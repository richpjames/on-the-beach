import UIKit
import UniformTypeIdentifiers
import MobileCoreServices

/// Native share-sheet entry point for On The Beach.
///
/// When the user taps "On The Beach" in the share sheet, iOS/macOS instantiates
/// this controller inside the Share Extension process and hands us the shared
/// content via `extensionContext`. We show a small compose form so the user can
/// add an optional note, pick any number of lists (existing or new), and set an
/// optional scheduled reminder date, then POST the link to the app's ingest
/// endpoint (`/api/ingest/link`) with a `Bearer` token.
///
/// The extension talks to the server directly rather than opening the app, so a
/// share succeeds even when the app isn't running.
///
/// Unlike Apple's `SLComposeServiceViewController` (which swooshes away the
/// instant you tap Post, leaving nowhere to report a failure), this is a custom
/// form: the post is synchronous. We stay on screen with an "Adding…" spinner
/// until the request finishes, flash a brief "Added" confirmation toast before
/// dismissing on success, and present a blocking error alert on failure.
/// Networking, the toast, and alerts live here in the container — which
/// outlives the child form/picker — so there's always a live view controller to
/// present them on.
final class ShareViewController: UIViewController {
    private struct Stack: Decodable {
        let id: Int
        let name: String
    }

    private struct StacksResponse: Decodable {
        let stacks: [Stack]
    }

    /// The slice of the `POST /api/ingest/link` response the confirmation toast
    /// needs: whether anything was created or skipped as a duplicate, and which
    /// lists the item was filed into.
    private struct LinkResponse: Decodable {
        struct List: Decodable {
            let name: String
        }

        let itemsCreated: Int?
        let itemsSkipped: Int?
        let lists: [List]?

        enum CodingKeys: String, CodingKey {
            case itemsCreated = "items_created"
            case itemsSkipped = "items_skipped"
            case lists
        }
    }

    /// The `409 ambiguous_link` response from `POST /api/ingest/link`: the
    /// shared page names several releases and the server wants the user to
    /// pick which ones to add. Same payload shape the web app's link picker
    /// consumes from `POST /api/music-items`.
    struct AmbiguousLinkResponse: Decodable {
        struct Candidate: Decodable {
            let candidateId: String
            let artist: String?
            let title: String
        }

        let kind: String
        let message: String?
        let candidates: [Candidate]
    }

    /// Outcome of a post attempt: a confirmation or error message to show the
    /// user, or — for a link only — a page with several releases on it that
    /// needs the user to pick which to add before posting again.
    private enum PostResult {
        case success(String)
        case failure(String)
        case needsReleaseSelection(message: String, candidates: [AmbiguousLinkResponse.Candidate])
    }

    /// What the user is sharing: a link (posted to `/api/ingest/link`) or an
    /// image (posted to `/api/ingest/photo`). The compose form, note, list
    /// picker, and reminder are identical either way — only the endpoint and
    /// payload differ.
    private enum SharedContent {
        case link(URL)
        case image(Data)
    }

    /// What extraction found: something postable, an image attachment we
    /// couldn't decode or compress, or nothing usable at all. The failure cases
    /// are kept apart so the form can say which one happened instead of just
    /// showing an empty preview with Add greyed out.
    private enum SharedInput {
        case content(SharedContent)
        case unreadableImage
        case nothing
    }

    /// Shown when a shared image can't be decoded or compressed into something
    /// postable — the one failure that happens before any request is made.
    private static let unreadablePhotoMessage =
        "Couldn't read that photo — try sharing it from Photos instead."

    private var sharedContent: SharedContent?
    private var stackNames: [String] = []
    private var selectedListNames: [String] = []

    /// Formats a chosen schedule as a locale-independent `yyyy-MM-dd` string —
    /// the same shape the web date picker sends to `/api/music-items/:id/reminder`.
    private static let scheduleFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    private let compose = ComposeFormController()
    private lazy var navController = UINavigationController(rootViewController: compose)
    /// The list picker while it's on screen, so posting state and the Add gate
    /// can be kept in step with the compose form's.
    private weak var listPicker: ListPickerViewController?
    /// The release picker while it's on screen (after a multi-release page came
    /// back ambiguous), so posting state locks it like the other screens.
    private weak var releasePicker: ReleasePickerViewController?

    // Read from the extension's Info.plist. `OTBBaseURL` is committed; the API
    // key is injected from a gitignored xcconfig at build time (see
    // native/ShareExtension/Secrets.example.xcconfig).
    private var baseURL: String {
        infoValue("OTBBaseURL") ?? "https://onthebeach.ricojam.es"
    }

    private var apiKey: String {
        infoValue("OTBIngestAPIKey") ?? ""
    }

    override func viewDidLoad() {
        super.viewDidLoad()

        view.backgroundColor = OTBTheme.desktop
        OTBTheme.styleTitleBar(navController.navigationBar)

        addChild(navController)
        navController.view.frame = view.bounds
        navController.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(navController.view)
        navController.didMove(toParent: self)

        compose.onCancel = { [weak self] in self?.cancel() }
        compose.onPickList = { [weak self] in self?.pushListPicker() }
        compose.onSubmit = { [weak self] in self?.submit() }

        extractSharedContent { [weak self] input in
            guard let self else { return }
            switch input {
            case .content(let content):
                self.sharedContent = content
                switch content {
                case .link(let url):
                    self.compose.setURL(url)
                case .image(let data):
                    if let image = UIImage(data: data) {
                        self.compose.setImage(image)
                    } else {
                        self.sharedContent = nil
                        self.compose.setUnavailable(Self.unreadablePhotoMessage)
                    }
                }
            case .unreadableImage:
                self.sharedContent = nil
                self.compose.setUnavailable(Self.unreadablePhotoMessage)
            case .nothing:
                self.sharedContent = nil
                self.compose.setUnavailable("Nothing to add from this share.")
            }
            // Extraction is async, so the picker may already be on screen when
            // the content lands — ungate its Add button too.
            self.listPicker?.canAdd = self.compose.canSubmit
        }
        fetchStacks()
    }

    // MARK: - List picker

    private func pushListPicker() {
        let picker = ListPickerViewController(stacks: stackNames, selected: selectedListNames)
        // The picker is multi-select and pushed (no Done button), so it reports
        // the full selection on every toggle — the user commits by tapping back.
        picker.onSelectionChanged = { [weak self] names in
            guard let self else { return }
            self.selectedListNames = names
            // A newly-created list should show up as an option next time too.
            for name in names where !self.stackNames.contains(name) {
                self.stackNames.append(name)
            }
            self.compose.setListNames(names)
        }
        // Picking a list is usually the last thing the user does, so the picker
        // carries its own Add button: post from here rather than making them
        // walk back to the compose form just to tap the same button.
        picker.canAdd = compose.canSubmit
        picker.onAdd = { [weak self] in self?.submit() }
        listPicker = picker
        navController.pushViewController(picker, animated: true)
    }

    // MARK: - Submit / cancel

    /// Posts the shared content with whatever the compose form currently holds.
    /// Called from the form's Add button, the list picker's, and — with the
    /// chosen candidate ids — the release picker's, so all send exactly the
    /// same note, lists, and reminder.
    ///
    /// `selectedCandidateIds` is empty on a first post. When the shared page
    /// names several releases the server answers 409 with the candidates
    /// instead of adding anything; we show the release picker and come back
    /// through here with the user's selection.
    private func submit(selectedCandidateIds: [String] = []) {
        guard let sharedContent else {
            // Add is disabled without content, so this shouldn't be reachable —
            // but silently dismissing the sheet would look like a successful add.
            presentError("There's nothing here to add.")
            return
        }
        let note = compose.noteText
        let remindAt = compose.remindAt

        let handle: (PostResult) -> Void = { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                self.presentSuccess(message)
            case .failure(let message):
                self.setPosting(false)
                self.presentError(message)
            case .needsReleaseSelection(let message, let candidates):
                self.setPosting(false)
                self.pushReleasePicker(message: message, candidates: candidates)
            }
        }

        setPosting(true)
        switch sharedContent {
        case .link(let url):
            postLink(
                url: url,
                note: note,
                listNames: selectedListNames,
                remindAt: remindAt,
                selectedCandidateIds: selectedCandidateIds,
                completion: handle
            )
        case .image(let data):
            postPhoto(
                imageData: data,
                note: note,
                listNames: selectedListNames,
                remindAt: remindAt,
                completion: handle
            )
        }
    }

    /// Applies the "Adding…" state to every screen in the stack, so whichever
    /// one the user submitted from shows the spinner and is locked against
    /// re-entry (including navigating between them mid-request).
    private func setPosting(_ posting: Bool) {
        compose.setPosting(posting)
        listPicker?.setPosting(posting)
        releasePicker?.setPosting(posting)
    }

    /// Pushes the release picker after the server reported the shared page
    /// mentions several releases. Add posts the link again with the chosen
    /// candidate ids; back returns to whatever screen the user submitted from
    /// with everything they'd already filled in intact.
    private func pushReleasePicker(
        message: String,
        candidates: [AmbiguousLinkResponse.Candidate]
    ) {
        let picker = ReleasePickerViewController(message: message, candidates: candidates)
        picker.onAdd = { [weak self] ids in self?.submit(selectedCandidateIds: ids) }
        releasePicker = picker
        navController.pushViewController(picker, animated: true)
    }

    /// Flashes a checkmark toast over the form, then closes the sheet. Completing
    /// the request immediately gave no visible feedback, so the user couldn't tell
    /// a successful add from the sheet just vanishing.
    private func presentSuccess(_ message: String) {
        view.endEditing(true)

        let checkmark = UIImageView(image: UIImage(systemName: "checkmark.circle.fill"))
        checkmark.tintColor = OTBTheme.ledGreen
        checkmark.contentMode = .scaleAspectFit

        let label = UILabel()
        label.text = message
        label.font = OTBTheme.ui(14, bold: true)
        label.textColor = .black
        label.textAlignment = .center
        label.numberOfLines = 0

        let stack = UIStackView(arrangedSubviews: [checkmark, label])
        stack.axis = .vertical
        stack.spacing = 8
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false

        // A raised chrome "window" with a hard offset shadow (no blur, zero
        // radius) — the app's --shadow-window signature.
        let toast = BeveledView(style: .raised, fill: OTBTheme.chrome)
        toast.layer.shadowColor = UIColor.black.cgColor
        toast.layer.shadowOpacity = 1
        toast.layer.shadowRadius = 0
        toast.layer.shadowOffset = CGSize(width: 4, height: 4)
        toast.translatesAutoresizingMaskIntoConstraints = false

        toast.addSubview(stack)
        view.addSubview(toast)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: toast.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: toast.bottomAnchor, constant: -20),
            stack.leadingAnchor.constraint(equalTo: toast.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: toast.trailingAnchor, constant: -24),
            checkmark.widthAnchor.constraint(equalToConstant: 44),
            checkmark.heightAnchor.constraint(equalToConstant: 44),
            toast.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            toast.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            toast.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 32),
            toast.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -32),
        ])

        toast.alpha = 0
        toast.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
        UIView.animate(withDuration: 0.2) {
            toast.alpha = 1
            toast.transform = .identity
        }
        UINotificationFeedbackGenerator().notificationOccurred(.success)

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.1) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        }
    }

    private func presentError(_ message: String) {
        let alert = UIAlertController(title: "Couldn't add", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        navController.present(alert, animated: true)
    }

    private func cancel() {
        let error = NSError(domain: "es.ricojam.onthebeach.ShareExtension", code: 0)
        extensionContext?.cancelRequest(withError: error)
    }

    // MARK: - Extracting the shared content

    /// Walks the extension's input items to work out what's being shared: a
    /// link or an image.
    ///
    /// A **link** is preferred when present — the common case is a music URL,
    /// and a shared web page often carries a thumbnail image we don't want. So
    /// we look for a URL first (a real `public.url` attachment, most apps),
    /// then a `public.plain-text` blob that embeds a URL (Safari often shares
    /// "Page Title\nhttps://…"), and only if neither yields a link do we fall
    /// back to an **image** attachment (a shared photo, e.g. a record cover).
    /// The very last resort is a URL recovered from the item's attributed text
    /// — some apps (e.g. Apple Music) carry the link there rather than as an
    /// attachment.
    ///
    /// For links, `url(from:)` does the decoding, because the loaded item is
    /// not always a `URL`: on macOS a `public.url` item arrives as `Data`
    /// holding the URL string (see below), and text branches arrive as
    /// `String`. Getting that coercion wrong is what left the Add button
    /// permanently disabled when sharing from Apple Music on macOS.
    private func extractSharedContent(completion: @escaping (SharedInput) -> Void) {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }

        let urlType = UTType.url.identifier
        let textType = UTType.plainText.identifier
        let imageType = UTType.image.identifier

        let imageProvider = providers.first { $0.hasItemConformingToTypeIdentifier(imageType) }

        // No link found: use a shared image if there is one, otherwise recover a
        // link from the item's attributed text as a final fallback.
        let fallback: () -> Void = {
            if let imageProvider {
                self.loadImage(from: imageProvider) { data in
                    if let data {
                        completion(.content(.image(data)))
                    } else {
                        // The share carried an image we couldn't decode or
                        // compress. A link recovered from the text is still
                        // worth posting; otherwise say so rather than leaving
                        // the form blank.
                        completion(Self.linkFromText(items) ?? .unreadableImage)
                    }
                }
            } else {
                completion(Self.linkFromText(items) ?? .nothing)
            }
        }

        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(urlType) }) {
            provider.loadItem(forTypeIdentifier: urlType, options: nil) { item, _ in
                DispatchQueue.main.async {
                    if let url = Self.url(from: item) {
                        completion(.content(.link(url)))
                    } else {
                        fallback()
                    }
                }
            }
            return
        }

        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(textType) }) {
            provider.loadItem(forTypeIdentifier: textType, options: nil) { item, _ in
                DispatchQueue.main.async {
                    if let url = Self.url(from: item) {
                        completion(.content(.link(url)))
                    } else {
                        fallback()
                    }
                }
            }
            return
        }

        fallback()
    }

    /// Recovers a link from the input items' attributed text, or `nil`.
    private nonisolated static func linkFromText(_ items: [NSExtensionItem]) -> SharedInput? {
        let text = items.compactMap { $0.attributedContentText?.string }.joined(separator: "\n")
        return firstURL(in: text).map { .content(.link($0)) }
    }

    /// Loads an image attachment and hands back downscaled JPEG bytes on the
    /// main queue, or `nil` if it couldn't be decoded.
    private func loadImage(from provider: NSItemProvider, completion: @escaping (Data?) -> Void) {
        provider.loadItem(forTypeIdentifier: UTType.image.identifier, options: nil) { item, _ in
            let data = Self.imageData(from: item)
            DispatchQueue.main.async { completion(data) }
        }
    }

    /// Coerces whatever `loadItem` hands back for an image into downscaled JPEG
    /// bytes. Depending on the source app the item is a file `URL`, raw `Data`,
    /// or a `UIImage`. We normalise to a `UIImage`, then re-encode via
    /// `downscaledJPEG(_:)` so the upload stays under the server's size cap
    /// (see `MAX_IMAGE_BASE64_LENGTH` in server/uploads.ts); a full-resolution
    /// phone photo would otherwise be rejected as too large.
    private nonisolated static func imageData(from item: NSSecureCoding?) -> Data? {
        let image: UIImage?
        if let uiImage = item as? UIImage {
            image = uiImage
        } else if let url = item as? URL, let data = try? Data(contentsOf: url) {
            image = UIImage(data: data)
        } else if let data = item as? Data {
            image = UIImage(data: data)
        } else {
            image = nil
        }
        return image.flatMap(downscaledJPEG)
    }

    /// The downscale/quality ladder to walk while the encoded photo is still
    /// too big. Mirrors `imageCompressionAttempts` in src/ui/domain/scan.ts.
    private nonisolated static func compressionAttempts(
        maxEdge: CGFloat,
        quality: CGFloat
    ) -> [(maxEdge: CGFloat, quality: CGFloat)] {
        [
            (maxEdge, quality),
            (maxEdge, quality * 0.75),
            ((maxEdge * 0.75).rounded(), quality * 0.7),
            ((maxEdge * 0.5).rounded(), quality * 0.6),
            ((maxEdge * 0.35).rounded(), quality * 0.5),
        ]
    }

    /// Downscales an image so its longest edge is at most 1024px and encodes it
    /// as JPEG — mirroring the web app's `encodeImageFile` (src/lib/encode-image.ts)
    /// so both share paths produce uploads the server will accept.
    ///
    /// A 1024px sleeve at quality 0.85 usually lands well under the limit, but a
    /// detailed cover can still encode past it, so we compress harder down the
    /// ladder until the base64 payload fits rather than posting a doomed request.
    /// If nothing fits we post the smallest attempt anyway — a rejection then is
    /// no worse than not trying.
    private nonisolated static func downscaledJPEG(_ image: UIImage) -> Data? {
        // Ceiling for the base64 payload we post, in characters — the same budget
        // the web app uses (`MAX_UPLOAD_BASE64_LENGTH` in src/ui/domain/scan.ts).
        // The binding limit is SvelteKit's request body limit, which 413s an
        // oversized upload before the ingest route ever runs.
        let maxUploadBase64Length = 460_000
        var smallest: Data?

        for attempt in compressionAttempts(maxEdge: 1024, quality: 0.85) {
            guard let data = encodedJPEG(image, maxEdge: attempt.maxEdge, quality: attempt.quality)
            else { continue }

            if base64Length(ofByteCount: data.count) <= maxUploadBase64Length {
                return data
            }
            if let current = smallest, data.count >= current.count {
                continue
            }
            smallest = data
        }

        return smallest
    }

    /// Base64 encodes 3 bytes into 4 characters, padded up to the next multiple
    /// of 4 — so we can size the payload without building the string.
    private nonisolated static func base64Length(ofByteCount count: Int) -> Int {
        ((count + 2) / 3) * 4
    }

    private nonisolated static func encodedJPEG(
        _ image: UIImage,
        maxEdge: CGFloat,
        quality: CGFloat
    ) -> Data? {
        let longest = max(image.size.width, image.size.height)
        let scale = longest > maxEdge ? maxEdge / longest : 1
        let target = CGSize(width: image.size.width * scale, height: image.size.height * scale)

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: target, format: format)
        let resized = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return resized.jpegData(compressionQuality: quality)
    }

    /// Coerces whatever `NSItemProvider.loadItem` hands back into a URL.
    ///
    /// iOS delivers a `public.url` item as a `URL`, but macOS / Mac Catalyst
    /// delivers the same item as `Data` containing the URL's UTF-8 string — so
    /// `item as? URL` alone silently returns nil there. Text items arrive as a
    /// `String`. We try URL, then String, then Data, and only trust a parsed
    /// string if it has a scheme (so a bare title isn't turned into a
    /// schemeless URL); otherwise we scan the text for an embedded link.
    private nonisolated static func url(from item: NSSecureCoding?) -> URL? {
        if let url = item as? URL { return url }

        let text: String?
        if let string = item as? String {
            text = string
        } else if let data = item as? Data {
            text = String(data: data, encoding: .utf8)
        } else {
            text = nil
        }
        guard let text else { return nil }

        if let url = URL(string: text), url.scheme != nil { return url }
        return firstURL(in: text)
    }

    private nonisolated static func firstURL(in text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        let match = detector.firstMatch(in: text, options: [], range: range)
        return match?.url
    }

    // MARK: - Loading lists for the picker

    private func fetchStacks() {
        guard let endpoint = URL(string: baseURL + "/api/ingest/stacks"), !apiKey.isEmpty else {
            return
        }
        var request = URLRequest(url: endpoint)
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15

        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            guard let self, let data,
                  let payload = try? JSONDecoder().decode(StacksResponse.self, from: data) else {
                return
            }
            DispatchQueue.main.async { self.stackNames = payload.stacks.map(\.name) }
        }.resume()
    }

    // MARK: - Posting to the ingest endpoint

    private func postLink(
        url: URL,
        note: String,
        listNames: [String],
        remindAt: Date?,
        selectedCandidateIds: [String] = [],
        completion: @escaping (PostResult) -> Void
    ) {
        guard let endpoint = URL(string: baseURL + "/api/ingest/link") else {
            completion(.failure("Misconfigured server URL."))
            return
        }
        guard !apiKey.isEmpty else {
            completion(.failure("Missing ingest API key in build config."))
            return
        }

        var payload: [String: Any] = ["url": url.absoluteString]
        if !note.isEmpty { payload["notes"] = note }
        if !listNames.isEmpty { payload["listNames"] = listNames }
        // Send the schedule as a plain yyyy-MM-dd date, matching the web reminder
        // control; the server parses it with `new Date(...)`.
        if let remindAt { payload["remindAt"] = Self.scheduleFormatter.string(from: remindAt) }
        // The user's answer to an earlier ambiguous (multi-release) response.
        if !selectedCandidateIds.isEmpty { payload["selectedCandidateIds"] = selectedCandidateIds }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            completion(.failure("Couldn't prepare that link to send."))
            return
        }
        request.httpBody = body
        request.timeoutInterval = 20

        URLSession.shared.dataTask(with: request) { data, response, error in
            let result: PostResult
            if let error {
                result = .failure("Couldn't reach On The Beach: \(error.localizedDescription)")
            } else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200...299).contains(status) {
                    result = .success(Self.successMessage(from: data))
                } else if status == 409, let ambiguous = Self.ambiguousResponse(from: data) {
                    result = .needsReleaseSelection(
                        message: ambiguous.message ?? "This link mentions several releases. Pick one or more to add.",
                        candidates: ambiguous.candidates
                    )
                } else {
                    result = .failure(Self.failureMessage(status: status, data: data, isPhoto: false))
                }
            }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    /// Decodes a 409 body as the multi-release payload, or nil when the
    /// conflict is something else (so it falls through to the error alert).
    private nonisolated static func ambiguousResponse(from data: Data?) -> AmbiguousLinkResponse? {
        guard let data,
              let payload = try? JSONDecoder().decode(AmbiguousLinkResponse.self, from: data),
              payload.kind == "ambiguous_link",
              !payload.candidates.isEmpty
        else { return nil }
        return payload
    }

    /// Posts a shared image to `/api/ingest/photo`. The image is sent as base64
    /// JSON — the same shape the web add-form's scan flow uses — alongside the
    /// same note, lists, and reminder the link path sends, so the server files
    /// and schedules the created item identically. The response is decoded by
    /// the shared `successMessage(from:)`, so the confirmation toast ("Added to
    /// Jazz, Chill") reads the same for a photo as for a link.
    private func postPhoto(
        imageData: Data,
        note: String,
        listNames: [String],
        remindAt: Date?,
        completion: @escaping (PostResult) -> Void
    ) {
        guard let endpoint = URL(string: baseURL + "/api/ingest/photo") else {
            completion(.failure("Misconfigured server URL."))
            return
        }
        guard !apiKey.isEmpty else {
            completion(.failure("Missing ingest API key in build config."))
            return
        }

        var payload: [String: Any] = ["imageBase64": imageData.base64EncodedString()]
        if !note.isEmpty { payload["notes"] = note }
        if !listNames.isEmpty { payload["listNames"] = listNames }
        if let remindAt { payload["remindAt"] = Self.scheduleFormatter.string(from: remindAt) }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else {
            completion(.failure("Couldn't prepare that photo to send."))
            return
        }
        request.httpBody = body
        request.timeoutInterval = 30

        URLSession.shared.dataTask(with: request) { data, response, error in
            let result: PostResult
            if let error {
                result = .failure("Couldn't reach On The Beach: \(error.localizedDescription)")
            } else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200...299).contains(status) {
                    result = .success(Self.successMessage(from: data))
                } else {
                    result = .failure(Self.failureMessage(status: status, data: data, isPhoto: true))
                }
            }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    /// Turns a non-2xx response into something the person sharing can act on.
    ///
    /// The old message pasted the raw response body into the alert, which for a
    /// 413 is the adapter's HTML error page rather than anything readable — so
    /// an upload that was too big looked like a generic failure. Known statuses
    /// get plain English; anything else falls back to the server's JSON `error`
    /// field (never a raw HTML body) alongside the status code.
    private nonisolated static func failureMessage(status: Int, data: Data?, isPhoto: Bool) -> String {
        switch status {
        case 401:
            return "Unauthorized — check the ingest API key."
        case 413:
            return isPhoto
                ? "That photo was too big to send, even after compressing it. Try sharing a smaller image."
                : "That share was too big to send."
        case 503:
            return "On The Beach isn't accepting shares right now. Try again later."
        case 500...599:
            return "On The Beach couldn't save that (\(status)). Try again in a moment."
        default:
            if let detail = serverError(from: data) {
                return "\(detail) (\(status))"
            }
            return "Add failed (\(status))."
        }
    }

    /// Pulls the `error` field out of the API's JSON error body, if that's what
    /// came back. Returns nil for an empty or non-JSON body (e.g. an HTML error
    /// page), so those never reach the alert verbatim.
    private nonisolated static func serverError(from data: Data?) -> String? {
        guard let data,
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let message = payload["error"] as? String
        else { return nil }

        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return trimmed.count > 200 ? String(trimmed.prefix(200)) + "…" : trimmed
    }

    /// Builds the confirmation toast text from the ingest response: "Added",
    /// "Added 3 releases" when a multi-release selection created several items,
    /// "Added to Jazz, Chill", or "Already saved" when the link was a duplicate
    /// (still worth confirming — a re-share still files it into lists and sets
    /// the reminder). An unparseable body is still a 2xx, so fall back to "Added".
    private nonisolated static func successMessage(from data: Data?) -> String {
        guard let data, let payload = try? JSONDecoder().decode(LinkResponse.self, from: data) else {
            return "Added"
        }
        let created = payload.itemsCreated ?? 0
        let duplicate = created == 0 && (payload.itemsSkipped ?? 0) > 0
        let base: String
        if created > 1 {
            base = "Added \(created) releases"
        } else if duplicate {
            base = "Already saved"
        } else {
            base = "Added"
        }
        let names = (payload.lists ?? []).map(\.name)
        return names.isEmpty ? base : "\(base) to \(names.joined(separator: ", "))"
    }

    private func infoValue(_ key: String) -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !value.isEmpty else { return nil }
        return value
    }
}

/// The compose form: an optional note field, a tappable "List" row, and a
/// "Remind me" switch that reveals a date picker, with Cancel/Add in the
/// navigation bar. It owns no state and does no networking — it reports Cancel,
/// Add (with the note text and any chosen date), and List taps back to its
/// container via closures.
private final class ComposeFormController: UIViewController, UITextViewDelegate {
    var onCancel: (() -> Void)?
    var onSubmit: (() -> Void)?
    var onPickList: (() -> Void)?

    /// The note as typed, trimmed. Read by the container on submit — from this
    /// screen's Add button or the list picker's — so the form stays the single
    /// source of truth for what gets posted.
    var noteText: String {
        noteView.text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The chosen reminder day, or `nil` when "Remind me" is off.
    var remindAt: Date? {
        scheduleSwitch.isOn ? datePicker.date : nil
    }

    /// Whether there's anything to post yet — mirrored onto the list picker's
    /// Add button so both are gated on the same condition.
    var canSubmit: Bool { hasContent && !isPosting }

    private let urlLabel = UILabel()
    private let imagePreview = UIImageView()
    private let imageWell = BeveledView(style: .field, fill: OTBTheme.chromeWhite)
    private let noteView = UITextView()
    private let notePlaceholder = UILabel()
    private let listValueLabel = UILabel()
    private let scheduleSwitch = UISwitch()
    private let datePicker = UIDatePicker()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private lazy var addButton = UIBarButtonItem(
        title: "Add", style: .done, target: self, action: #selector(didTapAdd)
    )

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "On The Beach"
        view.backgroundColor = OTBTheme.chrome

        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel, target: self, action: #selector(didTapCancel)
        )
        navigationItem.rightBarButtonItem = addButton
        // Nothing to post until a URL is extracted.
        addButton.isEnabled = false
        // The bar is the blue title-bar gradient, so a default grey spinner all
        // but disappears on it.
        spinner.color = .white

        // The shared URL reads like a terminal line: mono type, navy on chrome.
        urlLabel.font = OTBTheme.mono(11)
        urlLabel.textColor = OTBTheme.navy
        urlLabel.numberOfLines = 2
        urlLabel.lineBreakMode = .byTruncatingMiddle

        // A shared image gets a sunken white well preview, seated inside the 2px
        // bevel like the note field. Hidden until an image is actually shared.
        imagePreview.contentMode = .scaleAspectFit
        imagePreview.clipsToBounds = true
        imagePreview.translatesAutoresizingMaskIntoConstraints = false
        imageWell.translatesAutoresizingMaskIntoConstraints = false
        imageWell.addSubview(imagePreview)
        imageWell.isHidden = true

        // A sunken white well for the note, matching the app's --bevel-field inputs.
        noteView.font = OTBTheme.ui(14)
        noteView.textColor = .black
        noteView.backgroundColor = .clear
        noteView.textContainerInset = UIEdgeInsets(top: 8, left: 6, bottom: 8, right: 6)
        noteView.delegate = self

        notePlaceholder.text = "Add a note (optional)"
        notePlaceholder.font = OTBTheme.ui(14)
        notePlaceholder.textColor = OTBTheme.chromeDark

        // Schedule: a compact date picker revealed only when "Remind me" is on, so
        // an unscheduled share sends no date. Default to tomorrow, and never let
        // the user pick a past day.
        datePicker.datePickerMode = .date
        datePicker.preferredDatePickerStyle = .compact
        datePicker.tintColor = OTBTheme.winBlue
        datePicker.minimumDate = Calendar.current.startOfDay(for: Date())
        datePicker.date = Calendar.current.date(byAdding: .day, value: 1, to: Date()) ?? Date()
        datePicker.isHidden = true

        // Seat the note text view inside a sunken field well, inset by the 2px bevel.
        let noteField = BeveledView(style: .field, fill: OTBTheme.chromeWhite)
        noteField.translatesAutoresizingMaskIntoConstraints = false
        noteView.translatesAutoresizingMaskIntoConstraints = false
        noteField.addSubview(noteView)
        noteView.addSubview(notePlaceholder)
        notePlaceholder.translatesAutoresizingMaskIntoConstraints = false

        let listRow = makeListRow()
        let scheduleRow = makeScheduleRow()

        let stack = UIStackView(arrangedSubviews: [urlLabel, imageWell, noteField, listRow, scheduleRow, datePicker])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: guide.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
            imageWell.heightAnchor.constraint(equalToConstant: 140),
            imagePreview.topAnchor.constraint(equalTo: imageWell.topAnchor, constant: 2),
            imagePreview.bottomAnchor.constraint(equalTo: imageWell.bottomAnchor, constant: -2),
            imagePreview.leadingAnchor.constraint(equalTo: imageWell.leadingAnchor, constant: 2),
            imagePreview.trailingAnchor.constraint(equalTo: imageWell.trailingAnchor, constant: -2),
            noteField.heightAnchor.constraint(equalToConstant: 96),
            noteView.topAnchor.constraint(equalTo: noteField.topAnchor, constant: 2),
            noteView.bottomAnchor.constraint(equalTo: noteField.bottomAnchor, constant: -2),
            noteView.leadingAnchor.constraint(equalTo: noteField.leadingAnchor, constant: 2),
            noteView.trailingAnchor.constraint(equalTo: noteField.trailingAnchor, constant: -2),
            notePlaceholder.topAnchor.constraint(equalTo: noteView.topAnchor, constant: 8),
            notePlaceholder.leadingAnchor.constraint(equalTo: noteView.leadingAnchor, constant: 10),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        noteView.becomeFirstResponder()
    }

    /// Builds the "Lists — None ›" row as a tappable stack (no iOS 15 button APIs).
    private func makeListRow() -> UIView {
        let container = PressableBeveledView(style: .raised, fill: OTBTheme.chromePanel)
        container.onTap = { [weak self] in self?.onPickList?() }

        let title = UILabel()
        title.text = "Lists"
        title.font = OTBTheme.ui(14)
        title.textColor = .black

        listValueLabel.text = "None"
        listValueLabel.font = OTBTheme.ui(14)
        listValueLabel.textColor = OTBTheme.chromeDarker
        listValueLabel.textAlignment = .right
        listValueLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let chevron = UIImageView(image: UIImage(systemName: "chevron.right"))
        chevron.tintColor = OTBTheme.chromeDark
        chevron.setContentHuggingPriority(.required, for: .horizontal)

        let row = UIStackView(arrangedSubviews: [title, listValueLabel, chevron])
        row.axis = .horizontal
        row.spacing = 8
        row.alignment = .center
        row.isLayoutMarginsRelativeArrangement = true
        row.layoutMargins = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        row.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: container.topAnchor),
            row.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        return container
    }

    /// Builds the "Remind me" row: a title and a switch that reveals the date picker.
    private func makeScheduleRow() -> UIView {
        let container = BeveledView(style: .raised, fill: OTBTheme.chromePanel)

        let title = UILabel()
        title.text = "Remind me"
        title.font = OTBTheme.ui(14)
        title.textColor = .black
        title.setContentHuggingPriority(.defaultLow, for: .horizontal)

        scheduleSwitch.onTintColor = OTBTheme.winBlue
        scheduleSwitch.addTarget(self, action: #selector(didToggleSchedule), for: .valueChanged)
        scheduleSwitch.setContentHuggingPriority(.required, for: .horizontal)

        let row = UIStackView(arrangedSubviews: [title, scheduleSwitch])
        row.axis = .horizontal
        row.spacing = 8
        row.alignment = .center
        row.isLayoutMarginsRelativeArrangement = true
        row.layoutMargins = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        row.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: container.topAnchor),
            row.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
        return container
    }

    // MARK: - Updates from the container

    func setURL(_ url: URL?) {
        urlLabel.text = url?.absoluteString
        urlLabel.isHidden = url == nil
        urlLabel.numberOfLines = 2
        urlLabel.lineBreakMode = .byTruncatingMiddle
        imageWell.isHidden = true
        setHasContent(url != nil)
    }

    /// Explains, in the line the URL normally occupies, why there's nothing to
    /// post — an image we couldn't read, or a share with nothing usable in it.
    /// Add stays disabled either way; without this the sheet just showed an
    /// empty form and left the user guessing.
    func setUnavailable(_ message: String) {
        urlLabel.text = message
        urlLabel.isHidden = false
        urlLabel.numberOfLines = 0
        urlLabel.lineBreakMode = .byWordWrapping
        imageWell.isHidden = true
        setHasContent(false)
    }

    /// Shows the shared image in the preview well and enables Add. Called
    /// instead of `setURL` when the share payload is a photo rather than a link.
    func setImage(_ image: UIImage?) {
        imagePreview.image = image
        imageWell.isHidden = image == nil
        urlLabel.isHidden = true
        setHasContent(image != nil)
    }

    /// Tracks whether there's anything to post (a URL or an image), so both the
    /// initial extraction and `setPosting` gate the Add button off the same flag.
    private var hasContent = false
    private func setHasContent(_ value: Bool) {
        hasContent = value
        addButton.isEnabled = value && !isPosting
    }

    /// Reflects the chosen lists in the "List" row: "None", the single name, or
    /// all names joined so the user can see everything the item will be filed into.
    func setListNames(_ names: [String]) {
        listValueLabel.text = names.isEmpty ? "None" : names.joined(separator: ", ")
    }

    private var isPosting = false

    /// While posting, swap the Add button for a spinner and block re-entry.
    func setPosting(_ posting: Bool) {
        isPosting = posting
        view.isUserInteractionEnabled = !posting
        if posting {
            spinner.startAnimating()
            navigationItem.rightBarButtonItem = UIBarButtonItem(customView: spinner)
        } else {
            spinner.stopAnimating()
            navigationItem.rightBarButtonItem = addButton
            addButton.isEnabled = hasContent
        }
    }

    // MARK: - Actions

    @objc private func didTapCancel() { onCancel?() }

    /// Reveal or hide the date picker alongside the "Remind me" switch.
    @objc private func didToggleSchedule() {
        UIView.animate(withDuration: 0.2) {
            self.datePicker.isHidden = !self.scheduleSwitch.isOn
        }
    }

    @objc private func didTapAdd() { onSubmit?() }

    // MARK: - UITextViewDelegate

    func textViewDidChange(_ textView: UITextView) {
        notePlaceholder.isHidden = !textView.text.isEmpty
    }
}

/// A multi-select list picker pushed onto the compose form's navigation stack.
///
/// Shows every existing list with a checkmark for the ones the item will go into,
/// plus a "New list…" row that prompts for a name. Tapping a list toggles it; an
/// item can belong to any number of lists (or none). The full selection is
/// reported via `onSelectionChanged` after every change — the server resolves the
/// names (creating any new), so no id round-trip is needed.
///
/// There's also an **Add** button in the top right, mirroring the compose form's:
/// choosing a list is normally the last decision, so the user can post from here
/// and close the sheet without first navigating back.
private final class ListPickerViewController: UITableViewController {
    var onSelectionChanged: (([String]) -> Void)?
    var onAdd: (() -> Void)?

    /// Mirrors the compose form's Add gate — there's nothing to post until the
    /// shared link or image has been extracted.
    var canAdd = false {
        didSet { addButton.isEnabled = canAdd && !isPosting }
    }

    private var names: [String]
    // Selection order is preserved so the compose row and payload stay stable.
    private var selected: [String]

    private lazy var addButton = UIBarButtonItem(
        title: "Add", style: .done, target: self, action: #selector(didTapAdd)
    )
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var isPosting = false

    init(stacks: [String], selected: [String]) {
        self.names = stacks
        self.selected = selected
        super.init(style: .plain)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Lists"
        // The Winamp black playlist: black well, light-blue text, navy separators.
        tableView.backgroundColor = OTBTheme.playlistBg
        tableView.separatorColor = OTBTheme.navyBorder
        tableView.tintColor = OTBTheme.accent // checkmark colour

        navigationItem.rightBarButtonItem = addButton
        addButton.isEnabled = canAdd
        // The bar is the blue title-bar gradient, so a default grey spinner all
        // but disappears on it.
        spinner.color = .white
    }

    /// While a post is in flight, swap Add for a spinner and lock the screen —
    /// including the back button, so the request can't be re-entered from the
    /// compose form.
    func setPosting(_ posting: Bool) {
        isPosting = posting
        tableView.isUserInteractionEnabled = !posting
        navigationItem.hidesBackButton = posting
        if posting {
            spinner.startAnimating()
            navigationItem.rightBarButtonItem = UIBarButtonItem(customView: spinner)
        } else {
            spinner.stopAnimating()
            navigationItem.rightBarButtonItem = addButton
            addButton.isEnabled = canAdd
        }
    }

    @objc private func didTapAdd() { onAdd?() }

    // Section 0: existing lists (checkmark = selected). Section 1: "New list…".
    override func numberOfSections(in tableView: UITableView) -> Int { 2 }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        section == 0 ? names.count : 1
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "cell")
            ?? UITableViewCell(style: .default, reuseIdentifier: "cell")

        cell.backgroundColor = .clear
        cell.textLabel?.font = OTBTheme.ui(14)
        // Keep the selected-row highlight in the Winamp blue rather than iOS grey.
        let highlight = UIView()
        highlight.backgroundColor = OTBTheme.playlistSelectedBg
        cell.selectedBackgroundView = highlight

        if indexPath.section == 1 {
            cell.textLabel?.text = "New list…"
            cell.textLabel?.textColor = OTBTheme.accent
            cell.accessoryType = .none
            return cell
        }

        let name = names[indexPath.row]
        cell.textLabel?.text = name
        cell.textLabel?.textColor = OTBTheme.playlistText
        cell.accessoryType = selected.contains(name) ? .checkmark : .none
        return cell
    }

    /// Zebra-stripe the existing-list rows, matching the playlist's alternating
    /// row backgrounds (--playlist-bg / --playlist-bg-alt).
    override func tableView(_ tableView: UITableView, willDisplay cell: UITableViewCell, forRowAt indexPath: IndexPath) {
        guard indexPath.section == 0 else {
            cell.backgroundColor = OTBTheme.playlistBg
            return
        }
        cell.backgroundColor = indexPath.row.isMultiple(of: 2) ? OTBTheme.playlistBg : OTBTheme.playlistBgAlt
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)

        if indexPath.section == 1 {
            promptForNewList()
            return
        }

        toggle(names[indexPath.row])
        tableView.reloadRows(at: [indexPath], with: .none)
    }

    /// Add or remove a name from the selection, then report the new full set.
    private func toggle(_ name: String) {
        if let index = selected.firstIndex(of: name) {
            selected.remove(at: index)
        } else {
            selected.append(name)
        }
        onSelectionChanged?(selected)
    }

    private func promptForNewList() {
        let alert = UIAlertController(title: "New list", message: nil, preferredStyle: .alert)
        alert.addTextField { $0.placeholder = "List name"; $0.autocapitalizationType = .sentences }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Add", style: .default) { [weak self, weak alert] _ in
            guard let self else { return }
            let name = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let name, !name.isEmpty else { return }
            // Surface the new list as a checked row, and select it if it's brand new.
            if !self.names.contains(name) { self.names.append(name) }
            if !self.selected.contains(name) {
                self.selected.append(name)
                self.onSelectionChanged?(self.selected)
            }
            self.tableView.reloadData()
        })
        present(alert, animated: true)
    }
}

/// A multi-select release picker pushed when the shared page mentions several
/// releases — the native twin of the web app's LinkPickerModal.
///
/// The server answered `409 ambiguous_link` instead of adding anything, so
/// nothing is saved until the user picks. Every candidate row toggles a
/// checkmark; a "Select all" row above them checks the lot (or clears it when
/// everything is already checked). **Add** re-posts the link with the chosen
/// candidate ids and is disabled until at least one release is picked. Going
/// back returns to the compose form / list picker with the note, lists, and
/// reminder untouched — the next Add just asks the server again.
private final class ReleasePickerViewController: UITableViewController {
    /// Called with the selected candidate ids when the user taps Add.
    var onAdd: (([String]) -> Void)?

    private let message: String
    private let candidates: [ShareViewController.AmbiguousLinkResponse.Candidate]
    // Selection order is preserved so the posted ids match the tap order.
    private var selectedIds: [String] = []

    private lazy var addButton = UIBarButtonItem(
        title: "Add", style: .done, target: self, action: #selector(didTapAdd)
    )
    private let spinner = UIActivityIndicatorView(style: .medium)
    private var isPosting = false

    init(message: String, candidates: [ShareViewController.AmbiguousLinkResponse.Candidate]) {
        self.message = message
        self.candidates = candidates
        super.init(style: .plain)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Releases"
        // Same Winamp black playlist treatment as the list picker.
        tableView.backgroundColor = OTBTheme.playlistBg
        tableView.separatorColor = OTBTheme.navyBorder
        tableView.tintColor = OTBTheme.accent // checkmark colour

        // The server's "pick one or more" prompt, as a chrome banner above the
        // playlist so the sudden extra screen explains itself.
        let banner = UILabel()
        banner.text = message
        banner.font = OTBTheme.ui(13)
        banner.textColor = .black
        banner.numberOfLines = 0
        let bannerWrap = BeveledView(style: .raised, fill: OTBTheme.chromePanel)
        banner.translatesAutoresizingMaskIntoConstraints = false
        bannerWrap.addSubview(banner)
        NSLayoutConstraint.activate([
            banner.topAnchor.constraint(equalTo: bannerWrap.topAnchor, constant: 10),
            banner.bottomAnchor.constraint(equalTo: bannerWrap.bottomAnchor, constant: -10),
            banner.leadingAnchor.constraint(equalTo: bannerWrap.leadingAnchor, constant: 12),
            banner.trailingAnchor.constraint(equalTo: bannerWrap.trailingAnchor, constant: -12),
        ])
        bannerWrap.frame = CGRect(
            x: 0,
            y: 0,
            width: tableView.bounds.width,
            height: 1 // resized below once Auto Layout knows the text height
        )
        tableView.tableHeaderView = bannerWrap

        navigationItem.rightBarButtonItem = addButton
        addButton.isEnabled = false
        // The bar is the blue title-bar gradient, so a default grey spinner all
        // but disappears on it.
        spinner.color = .white
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // Size the header banner to its text: table header views don't get
        // Auto Layout for free, so measure and re-set when the height changes.
        guard let header = tableView.tableHeaderView else { return }
        let height = header.systemLayoutSizeFitting(
            CGSize(width: tableView.bounds.width, height: UIView.layoutFittingCompressedSize.height),
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel
        ).height
        if abs(header.frame.height - height) > 0.5 {
            header.frame.size = CGSize(width: tableView.bounds.width, height: height)
            tableView.tableHeaderView = header
        }
    }

    /// While a post is in flight, swap Add for a spinner and lock the screen —
    /// including the back button, so the request can't be re-entered.
    func setPosting(_ posting: Bool) {
        isPosting = posting
        tableView.isUserInteractionEnabled = !posting
        navigationItem.hidesBackButton = posting
        if posting {
            spinner.startAnimating()
            navigationItem.rightBarButtonItem = UIBarButtonItem(customView: spinner)
        } else {
            spinner.stopAnimating()
            navigationItem.rightBarButtonItem = addButton
            addButton.isEnabled = !selectedIds.isEmpty
        }
    }

    @objc private func didTapAdd() {
        guard !selectedIds.isEmpty else { return }
        onAdd?(selectedIds)
    }

    // Section 0: "Select all". Section 1: the candidates (checkmark = will be added).
    override func numberOfSections(in tableView: UITableView) -> Int { 2 }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        section == 0 ? 1 : candidates.count
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        if indexPath.section == 0 {
            let cell = tableView.dequeueReusableCell(withIdentifier: "selectAll")
                ?? UITableViewCell(style: .default, reuseIdentifier: "selectAll")
            cell.backgroundColor = .clear
            cell.textLabel?.font = OTBTheme.ui(14)
            cell.textLabel?.textColor = OTBTheme.accent
            cell.textLabel?.text = selectedIds.count == candidates.count ? "Select none" : "Select all"
            cell.accessoryType = .none
            let highlight = UIView()
            highlight.backgroundColor = OTBTheme.playlistSelectedBg
            cell.selectedBackgroundView = highlight
            return cell
        }

        let cell = tableView.dequeueReusableCell(withIdentifier: "candidate")
            ?? UITableViewCell(style: .subtitle, reuseIdentifier: "candidate")

        cell.backgroundColor = .clear
        let highlight = UIView()
        highlight.backgroundColor = OTBTheme.playlistSelectedBg
        cell.selectedBackgroundView = highlight

        let candidate = candidates[indexPath.row]
        cell.textLabel?.text = candidate.title
        cell.textLabel?.font = OTBTheme.ui(14)
        cell.textLabel?.textColor = OTBTheme.playlistText
        cell.detailTextLabel?.text = candidate.artist
        cell.detailTextLabel?.font = OTBTheme.ui(11)
        cell.detailTextLabel?.textColor = OTBTheme.accent
        cell.accessoryType = selectedIds.contains(candidate.candidateId) ? .checkmark : .none
        return cell
    }

    /// Zebra-stripe the candidate rows, matching the playlist's alternating
    /// row backgrounds (--playlist-bg / --playlist-bg-alt).
    override func tableView(_ tableView: UITableView, willDisplay cell: UITableViewCell, forRowAt indexPath: IndexPath) {
        guard indexPath.section == 1 else {
            cell.backgroundColor = OTBTheme.playlistBg
            return
        }
        cell.backgroundColor = indexPath.row.isMultiple(of: 2) ? OTBTheme.playlistBg : OTBTheme.playlistBgAlt
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)

        if indexPath.section == 0 {
            // Toggle between everything and nothing.
            if selectedIds.count == candidates.count {
                selectedIds = []
            } else {
                selectedIds = candidates.map(\.candidateId)
            }
            tableView.reloadData()
            addButton.isEnabled = !selectedIds.isEmpty && !isPosting
            return
        }

        toggle(candidates[indexPath.row].candidateId)
        tableView.reloadRows(at: [indexPath], with: .none)
        // The "Select all" label flips to "Select none" once everything's checked.
        tableView.reloadSections(IndexSet(integer: 0), with: .none)
    }

    /// Add or remove a candidate id from the selection and re-gate Add.
    private func toggle(_ id: String) {
        if let index = selectedIds.firstIndex(of: id) {
            selectedIds.remove(at: index)
        } else {
            selectedIds.append(id)
        }
        addButton.isEnabled = !selectedIds.isEmpty && !isPosting
    }
}

// MARK: - Windows 98 / Winamp styling
//
// The web app (src/styles/main.css) is a deliberate Windows 98 + Winamp skin:
// silver-chrome surfaces, a teal desktop, a blue title bar, a black Winamp
// playlist, 2px two-tone 3D bevels, zero corner radius, and hard offset shadows.
// This extension is native UIKit with no access to that stylesheet, so we mirror
// the same design tokens here in code and apply them to the share sheet.

/// The app's palette and fonts, mirrored from the `:root` tokens in main.css.
enum OTBTheme {
    static let chrome = UIColor(rgb: 0xC0C0C0)       // --chrome: primary surface
    static let chromeLight = UIColor(rgb: 0xDFDFDF)  // --chrome-light: hover
    static let chromeWhite = UIColor.white           // --chrome-white
    static let chromeDark = UIColor(rgb: 0x808080)   // --chrome-dark
    static let chromeDarker = UIColor(rgb: 0x404040) // --chrome-darker: shadow edge
    static let chromePanel = UIColor(rgb: 0xD4D0C8)  // --chrome-panel: warm toolbar grey
    static let desktop = UIColor(rgb: 0x008080)      // teal desktop background
    static let titleBarStart = UIColor(rgb: 0x000080) // --title-bar gradient stops
    static let titleBarMid = UIColor(rgb: 0x1084D0)
    static let titleBarEnd = UIColor(rgb: 0x4DB0E8)
    static let playlistBg = UIColor.black            // --playlist-bg
    static let playlistBgAlt = UIColor(rgb: 0x06060E) // --playlist-bg-alt (zebra)
    static let playlistText = UIColor(rgb: 0xADC8FF) // --playlist-text
    static let playlistSelectedBg = UIColor(rgb: 0x225FA8) // --playlist-selected-bg
    static let accent = UIColor(rgb: 0x6699FF)       // --accent: electric blue
    static let winBlue = UIColor(rgb: 0x225FA8)      // --win-blue: menu/selection highlight
    static let navy = UIColor(rgb: 0x001033)         // --navy
    static let navyBorder = UIColor(rgb: 0x224499)   // --navy-border
    static let ledGreen = UIColor(rgb: 0x00FF41)     // --led-green

    /// UI chrome type. The web uses Tahoma; iOS doesn't ship it, so we use
    /// Verdana — the same designer's near-identical face, bundled on every device.
    static func ui(_ size: CGFloat, bold: Bool = false) -> UIFont {
        UIFont(name: bold ? "Verdana-Bold" : "Verdana", size: size)
            ?? .systemFont(ofSize: size, weight: bold ? .bold : .regular)
    }

    /// Mono/terminal type for URLs and the toast — the web's Share Tech Mono
    /// stand-in, using Courier New (also always present on iOS).
    static func mono(_ size: CGFloat) -> UIFont {
        UIFont(name: "CourierNewPSMT", size: size)
            ?? .monospacedSystemFont(ofSize: size, weight: .regular)
    }

    /// A horizontal title-bar gradient (navy → blue → light blue) rendered to an
    /// image so it can back a `UINavigationBarAppearance`. Wide so it stretches
    /// cleanly to any bar width while keeping the 0 / 0.7 / 1 colour stops.
    static func titleBarImage() -> UIImage {
        let size = CGSize(width: 1024, height: 44)
        return UIGraphicsImageRenderer(size: size).image { ctx in
            let colors = [titleBarStart.cgColor, titleBarMid.cgColor, titleBarEnd.cgColor] as CFArray
            guard let gradient = CGGradient(
                colorsSpace: CGColorSpaceCreateDeviceRGB(),
                colors: colors,
                locations: [0, 0.7, 1]
            ) else { return }
            ctx.cgContext.drawLinearGradient(
                gradient,
                start: .zero,
                end: CGPoint(x: size.width, y: 0),
                options: []
            )
        }
    }

    /// Applies the blue title-bar look to a navigation bar: gradient background,
    /// white bold Verdana title, white bar-button items.
    static func styleTitleBar(_ navigationBar: UINavigationBar) {
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundImage = titleBarImage()
        appearance.shadowColor = .black
        appearance.titleTextAttributes = [
            .foregroundColor: UIColor.white,
            .font: ui(15, bold: true),
        ]
        let buttonText: [NSAttributedString.Key: Any] = [.font: ui(14)]
        appearance.buttonAppearance.normal.titleTextAttributes = buttonText
        appearance.doneButtonAppearance.normal.titleTextAttributes = [.font: ui(14, bold: true)]

        navigationBar.standardAppearance = appearance
        navigationBar.scrollEdgeAppearance = appearance
        navigationBar.compactAppearance = appearance
        navigationBar.tintColor = .white
    }
}

extension UIColor {
    /// Builds an opaque colour from a 0xRRGGBB literal, matching how the CSS
    /// tokens are written, so the palette reads the same in both places.
    convenience init(rgb: UInt32) {
        self.init(
            red: CGFloat((rgb >> 16) & 0xFF) / 255,
            green: CGFloat((rgb >> 8) & 0xFF) / 255,
            blue: CGFloat(rgb & 0xFF) / 255,
            alpha: 1
        )
    }
}

/// The three Windows 98 bevel states. Each is a 2px border whose top+left edges
/// are one tone and bottom+right edges the opposite, faking a 3D light source.
enum BevelStyle {
    case raised // buttons, windows, panels: light top-left, dark bottom-right
    case sunken // pressed controls: dark top-left, light bottom-right
    case field  // sunken wells (inputs, list rows): grey top-left, white bottom-right
}

/// A flat-filled view that draws a Windows 98 two-tone bevel around its edge.
///
/// UIKit has no built-in for this: `CALayer.borderColor` is a single colour, but
/// the whole retro look depends on adjacent edges being *different* colours. So we
/// draw it ourselves in `draw(_:)`. Subclassed by `PressableBeveledView`.
class BeveledView: UIView {
    var style: BevelStyle { didSet { setNeedsDisplay() } }
    var fill: UIColor { didSet { setNeedsDisplay() } }
    /// Bevel thickness in points (the web uses 2px).
    var bevelWidth: CGFloat = 2 { didSet { setNeedsDisplay() } }

    init(style: BevelStyle = .raised, fill: UIColor = OTBTheme.chrome) {
        self.style = style
        self.fill = fill
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        contentMode = .redraw // re-run draw(_:) whenever Auto Layout resizes us
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// The two edge tones for the current style: `light` paints the top + left
    /// edges, `dark` paints the bottom + right edges.
    var edgeColors: (light: UIColor, dark: UIColor) {
        switch style {
        case .raised: return (OTBTheme.chromeWhite, OTBTheme.chromeDarker)
        case .sunken: return (OTBTheme.chromeDarker, OTBTheme.chromeWhite)
        case .field:  return (OTBTheme.chromeDark, OTBTheme.chromeWhite)
        }
    }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        let (light, dark) = edgeColors
        let w = bevelWidth

        // 1. Fill the interior.
        ctx.setFillColor(fill.cgColor)
        ctx.fill(bounds)

        // 2. Light top + left edges.
        ctx.setFillColor(light.cgColor)
        ctx.fill(CGRect(x: 0, y: 0, width: bounds.width, height: w))          // top
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: bounds.height))         // left

        // 3. Dark bottom + right edges.
        ctx.setFillColor(dark.cgColor)
        ctx.fill(CGRect(x: 0, y: bounds.height - w, width: bounds.width, height: w))  // bottom
        ctx.fill(CGRect(x: bounds.width - w, y: 0, width: w, height: bounds.height))  // right
    }
}

/// A beveled panel that behaves like a Windows 98 button: it "pushes in" while
/// held (bevel flips raised → sunken), springs back on release, and fires `onTap`
/// only when the touch lifts inside its bounds — same feel as the web app's
/// raised controls, which invert their bevel on `:active`.
final class PressableBeveledView: BeveledView {
    var onTap: (() -> Void)?
    /// The look when not being pressed, restored on release/cancel.
    private let restingStyle: BevelStyle

    override init(style: BevelStyle = .raised, fill: UIColor = OTBTheme.chrome) {
        self.restingStyle = style
        super.init(style: style, fill: fill)
        isUserInteractionEnabled = true
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        style = .sunken
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        style = restingStyle
        if let point = touches.first?.location(in: self), bounds.contains(point) {
            onTap?()
        }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        style = restingStyle
    }
}

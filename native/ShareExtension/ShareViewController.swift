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

    /// Outcome of a post attempt: a confirmation or error message to show the user.
    private enum PostResult {
        case success(String)
        case failure(String)
    }

    /// What the user is sharing: a link (posted to `/api/ingest/link`) or an
    /// image (posted to `/api/ingest/photo`). The compose form, note, list
    /// picker, and reminder are identical either way — only the endpoint and
    /// payload differ.
    private enum SharedContent {
        case link(URL)
        case image(Data)
    }

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
        compose.onSubmit = { [weak self] note, remindAt in self?.submit(note: note, remindAt: remindAt) }

        extractSharedContent { [weak self] content in
            guard let self else { return }
            self.sharedContent = content
            switch content {
            case .link(let url):
                self.compose.setURL(url)
            case .image(let data):
                self.compose.setImage(UIImage(data: data))
            case nil:
                self.compose.setURL(nil)
            }
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
        navController.pushViewController(picker, animated: true)
    }

    // MARK: - Submit / cancel

    private func submit(note: String, remindAt: Date?) {
        guard let sharedContent else {
            cancel()
            return
        }

        let handle: (PostResult) -> Void = { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                self.presentSuccess(message)
            case .failure(let message):
                self.compose.setPosting(false)
                self.presentError(message)
            }
        }

        compose.setPosting(true)
        switch sharedContent {
        case .link(let url):
            postLink(
                url: url,
                note: note,
                listNames: selectedListNames,
                remindAt: remindAt,
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
    private func extractSharedContent(completion: @escaping (SharedContent?) -> Void) {
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
                        completion(.image(data))
                    } else {
                        completion(Self.linkFromText(items))
                    }
                }
            } else {
                completion(Self.linkFromText(items))
            }
        }

        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(urlType) }) {
            provider.loadItem(forTypeIdentifier: urlType, options: nil) { item, _ in
                DispatchQueue.main.async {
                    if let url = Self.url(from: item) { completion(.link(url)) } else { fallback() }
                }
            }
            return
        }

        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(textType) }) {
            provider.loadItem(forTypeIdentifier: textType, options: nil) { item, _ in
                DispatchQueue.main.async {
                    if let url = Self.url(from: item) { completion(.link(url)) } else { fallback() }
                }
            }
            return
        }

        fallback()
    }

    /// Recovers a `.link` from the input items' attributed text, or `nil`.
    private nonisolated static func linkFromText(_ items: [NSExtensionItem]) -> SharedContent? {
        let text = items.compactMap { $0.attributedContentText?.string }.joined(separator: "\n")
        return firstURL(in: text).map { .link($0) }
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

    /// Downscales an image so its longest edge is at most 1024px and encodes it
    /// as JPEG — mirroring the web app's `encodeImageFile` (src/lib/encode-image.ts)
    /// so both share paths produce uploads comfortably under the server limit.
    private nonisolated static func downscaledJPEG(_ image: UIImage) -> Data? {
        let maxEdge: CGFloat = 1024
        let longest = max(image.size.width, image.size.height)
        let scale = longest > maxEdge ? maxEdge / longest : 1
        let target = CGSize(width: image.size.width * scale, height: image.size.height * scale)

        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: target, format: format)
        let resized = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return resized.jpegData(compressionQuality: 0.85)
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

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        request.timeoutInterval = 20

        URLSession.shared.dataTask(with: request) { data, response, error in
            let result: PostResult
            if let error {
                result = .failure("Couldn't reach On The Beach: \(error.localizedDescription)")
            } else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200...299).contains(status) {
                    result = .success(Self.successMessage(from: data))
                } else if status == 401 {
                    result = .failure("Unauthorized — check the ingest API key.")
                } else {
                    let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                    result = .failure("Add failed (\(status)). \(body)")
                }
            }
            DispatchQueue.main.async { completion(result) }
        }.resume()
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
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        request.timeoutInterval = 30

        URLSession.shared.dataTask(with: request) { data, response, error in
            let result: PostResult
            if let error {
                result = .failure("Couldn't reach On The Beach: \(error.localizedDescription)")
            } else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200...299).contains(status) {
                    result = .success(Self.successMessage(from: data))
                } else if status == 401 {
                    result = .failure("Unauthorized — check the ingest API key.")
                } else {
                    let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                    result = .failure("Add failed (\(status)). \(body)")
                }
            }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    /// Builds the confirmation toast text from the ingest response: "Added",
    /// "Added to Jazz, Chill", or "Already saved" when the link was a duplicate
    /// (still worth confirming — a re-share still files it into lists and sets
    /// the reminder). An unparseable body is still a 2xx, so fall back to "Added".
    private nonisolated static func successMessage(from data: Data?) -> String {
        guard let data, let payload = try? JSONDecoder().decode(LinkResponse.self, from: data) else {
            return "Added"
        }
        let duplicate = (payload.itemsCreated ?? 0) == 0 && (payload.itemsSkipped ?? 0) > 0
        let base = duplicate ? "Already saved" : "Added"
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
    var onSubmit: ((String, Date?) -> Void)?
    var onPickList: (() -> Void)?

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
        imageWell.isHidden = true
        setHasContent(url != nil)
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

    @objc private func didTapAdd() {
        let note = noteView.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let remindAt = scheduleSwitch.isOn ? datePicker.date : nil
        onSubmit?(note, remindAt)
    }

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
/// names (creating any new), so no id round-trip is needed. The user commits by
/// tapping back out of the picker.
private final class ListPickerViewController: UITableViewController {
    var onSelectionChanged: (([String]) -> Void)?

    private var names: [String]
    // Selection order is preserved so the compose row and payload stay stable.
    private var selected: [String]

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
    }

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

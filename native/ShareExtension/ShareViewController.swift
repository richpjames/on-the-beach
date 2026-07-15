import UIKit
import UniformTypeIdentifiers
import MobileCoreServices

/// Native share-sheet entry point for On The Beach.
///
/// When the user taps "On The Beach" in the share sheet, iOS/macOS instantiates
/// this controller inside the Share Extension process and hands us the shared
/// content via `extensionContext`. We show a small compose form so the user can
/// add an optional note and pick any number of lists (existing or new), then POST
/// the link to the app's ingest endpoint (`/api/ingest/link`) with a `Bearer` token.
///
/// The extension talks to the server directly rather than opening the app, so a
/// share succeeds even when the app isn't running.
///
/// Unlike Apple's `SLComposeServiceViewController` (which swooshes away the
/// instant you tap Post, leaving nowhere to report a failure), this is a custom
/// form: the post is synchronous. We stay on screen with an "Adding…" spinner
/// until the request finishes, dismiss on success, and present a blocking error
/// alert on failure. Networking and alerts live here in the container — which
/// outlives the child form/picker — so there's always a live view controller to
/// present the alert on.
final class ShareViewController: UIViewController {
    private struct Stack: Decodable {
        let id: Int
        let name: String
    }

    private struct StacksResponse: Decodable {
        let stacks: [Stack]
    }

    /// Outcome of a post attempt: success, or a message to show the user.
    private enum PostResult {
        case success
        case failure(String)
    }

    private var sharedURL: URL?
    private var stackNames: [String] = []
    private var selectedListNames: [String] = []

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

        addChild(navController)
        navController.view.frame = view.bounds
        navController.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(navController.view)
        navController.didMove(toParent: self)

        compose.onCancel = { [weak self] in self?.cancel() }
        compose.onPickList = { [weak self] in self?.pushListPicker() }
        compose.onSubmit = { [weak self] note in self?.submit(note: note) }

        extractSharedURL { [weak self] url in
            guard let self else { return }
            self.sharedURL = url
            self.compose.setURL(url)
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

    private func submit(note: String) {
        guard let url = sharedURL else {
            cancel()
            return
        }
        compose.setPosting(true)
        postLink(url: url, note: note, listNames: selectedListNames) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
            case .failure(let message):
                self.compose.setPosting(false)
                self.presentError(message)
            }
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

    // MARK: - Extracting the shared URL

    /// Walks the extension's input items looking for a URL. Handles the shapes
    /// the system delivers: a real `public.url` attachment (most apps) and a
    /// `public.plain-text` blob that contains a URL somewhere in it (Safari
    /// often shares "Page Title\nhttps://…"). If neither attachment yields a
    /// URL, falls back to the item's attributed text — some apps (e.g. Apple
    /// Music) carry the link there rather than as an attachment.
    ///
    /// Whatever the branch, `url(from:)` does the decoding, because the loaded
    /// item is not always a `URL`: on macOS a `public.url` item arrives as
    /// `Data` holding the URL string (see below), and text branches arrive as
    /// `String`. Getting that coercion wrong is what left the Add button
    /// permanently disabled when sharing from Apple Music on macOS.
    private func extractSharedURL(completion: @escaping (URL?) -> Void) {
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }

        let urlType = UTType.url.identifier
        let textType = UTType.plainText.identifier

        // Last resort: recover a link from the item's attributed text.
        let fallback: () -> Void = {
            let text = items.compactMap { $0.attributedContentText?.string }.joined(separator: "\n")
            completion(Self.firstURL(in: text))
        }

        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(urlType) }) {
            provider.loadItem(forTypeIdentifier: urlType, options: nil) { item, _ in
                DispatchQueue.main.async {
                    if let url = Self.url(from: item) { completion(url) } else { fallback() }
                }
            }
            return
        }

        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(textType) }) {
            provider.loadItem(forTypeIdentifier: textType, options: nil) { item, _ in
                DispatchQueue.main.async {
                    if let url = Self.url(from: item) { completion(url) } else { fallback() }
                }
            }
            return
        }

        fallback()
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
                    result = .success
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

    private func infoValue(_ key: String) -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !value.isEmpty else { return nil }
        return value
    }
}

/// The compose form: an optional note field and a tappable "List" row, with
/// Cancel/Add in the navigation bar. It owns no state and does no networking —
/// it reports Cancel, Add (with the note text), and List taps back to its
/// container via closures.
private final class ComposeFormController: UIViewController, UITextViewDelegate {
    var onCancel: (() -> Void)?
    var onSubmit: ((String) -> Void)?
    var onPickList: (() -> Void)?

    private let urlLabel = UILabel()
    private let noteView = UITextView()
    private let notePlaceholder = UILabel()
    private let listValueLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private lazy var addButton = UIBarButtonItem(
        title: "Add", style: .done, target: self, action: #selector(didTapAdd)
    )

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "On The Beach"
        view.backgroundColor = .systemGroupedBackground

        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel, target: self, action: #selector(didTapCancel)
        )
        navigationItem.rightBarButtonItem = addButton
        // Nothing to post until a URL is extracted.
        addButton.isEnabled = false

        urlLabel.font = .preferredFont(forTextStyle: .footnote)
        urlLabel.textColor = .secondaryLabel
        urlLabel.numberOfLines = 2
        urlLabel.lineBreakMode = .byTruncatingMiddle

        noteView.font = .preferredFont(forTextStyle: .body)
        noteView.layer.cornerRadius = 10
        noteView.backgroundColor = .secondarySystemGroupedBackground
        noteView.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)
        noteView.delegate = self

        notePlaceholder.text = "Add a note (optional)"
        notePlaceholder.font = .preferredFont(forTextStyle: .body)
        notePlaceholder.textColor = .placeholderText

        let listRow = makeListRow()

        let stack = UIStackView(arrangedSubviews: [urlLabel, noteView, listRow])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)

        noteView.addSubview(notePlaceholder)
        notePlaceholder.translatesAutoresizingMaskIntoConstraints = false

        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: guide.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
            noteView.heightAnchor.constraint(equalToConstant: 96),
            notePlaceholder.topAnchor.constraint(equalTo: noteView.topAnchor, constant: 10),
            notePlaceholder.leadingAnchor.constraint(equalTo: noteView.leadingAnchor, constant: 12),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        noteView.becomeFirstResponder()
    }

    /// Builds the "Lists — None ›" row as a tappable stack (no iOS 15 button APIs).
    private func makeListRow() -> UIView {
        let container = UIView()
        container.backgroundColor = .secondarySystemGroupedBackground
        container.layer.cornerRadius = 10

        let title = UILabel()
        title.text = "Lists"
        title.font = .preferredFont(forTextStyle: .body)

        listValueLabel.text = "None"
        listValueLabel.font = .preferredFont(forTextStyle: .body)
        listValueLabel.textColor = .secondaryLabel
        listValueLabel.textAlignment = .right
        listValueLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let chevron = UIImageView(image: UIImage(systemName: "chevron.right"))
        chevron.tintColor = .tertiaryLabel
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

        container.addGestureRecognizer(
            UITapGestureRecognizer(target: self, action: #selector(didTapList))
        )
        return container
    }

    // MARK: - Updates from the container

    func setURL(_ url: URL?) {
        urlLabel.text = url?.absoluteString
        addButton.isEnabled = (url != nil) && !isPosting
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
            addButton.isEnabled = urlLabel.text != nil
        }
    }

    // MARK: - Actions

    @objc private func didTapCancel() { onCancel?() }
    @objc private func didTapList() { onPickList?() }

    @objc private func didTapAdd() {
        let note = noteView.text.trimmingCharacters(in: .whitespacesAndNewlines)
        onSubmit?(note)
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
    }

    // Section 0: existing lists (checkmark = selected). Section 1: "New list…".
    override func numberOfSections(in tableView: UITableView) -> Int { 2 }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        section == 0 ? names.count : 1
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "cell")
            ?? UITableViewCell(style: .default, reuseIdentifier: "cell")

        if indexPath.section == 1 {
            cell.textLabel?.text = "New list…"
            cell.textLabel?.textColor = cell.tintColor
            cell.accessoryType = .none
            return cell
        }

        let name = names[indexPath.row]
        cell.textLabel?.text = name
        cell.textLabel?.textColor = .label
        cell.accessoryType = selected.contains(name) ? .checkmark : .none
        return cell
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

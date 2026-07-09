import UIKit
import Social
import UniformTypeIdentifiers
import MobileCoreServices

/// Native share-sheet entry point for On The Beach.
///
/// When the user taps "On The Beach" in the iOS share sheet, iOS instantiates
/// this controller inside the Share Extension process and hands us the shared
/// content via `extensionContext`. We present Apple's standard compose sheet
/// (`SLComposeServiceViewController`) so the user can add an optional note and
/// pick a list (existing or new) before we POST the link to the app's ingest
/// endpoint (`/api/ingest/link`) with a `Bearer` token.
///
/// The extension talks to the server directly rather than opening the app, so a
/// share succeeds even when the app isn't running.
///
/// Posting is optimistic: `didSelectPost()` fires the request and dismisses.
/// iOS keeps the process alive until `completeRequest`, so the POST finishes in
/// the background, but the compose UI is already gone and can't surface a
/// per-request error — the standard tradeoff for the native compose sheet.
final class ShareViewController: SLComposeServiceViewController {
    /// A list as the ingest picker endpoint returns it.
    private struct Stack: Decodable {
        let id: Int
        let name: String
    }

    private var sharedURL: URL?
    private var stacks: [Stack] = []
    private var selectedListName: String?
    private weak var listConfigurationItem: SLComposeSheetConfigurationItem?

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
        title = "On The Beach"
        placeholder = "Add a note (optional)"
    }

    override func presentationAnimationDidFinish() {
        super.presentationAnimationDidFinish()
        // Extract the URL and load lists once the sheet is on screen.
        extractSharedURL { [weak self] url in
            guard let self else { return }
            self.sharedURL = url
            // Re-run isContentValid() now that we know whether we have a URL.
            self.validateContent()
        }
        fetchStacks()
    }

    // MARK: - Compose sheet configuration

    /// Post is only enabled once we've found a URL to share; the note is optional.
    override func isContentValid() -> Bool {
        sharedURL != nil
    }

    /// A single "List" row under the note field. Tapping it pushes the picker.
    override func configurationItems() -> [Any]! {
        guard let item = SLComposeSheetConfigurationItem() else { return [] }
        item.title = "List"
        item.value = selectedListName ?? "None"
        item.tapHandler = { [weak self] in
            self?.presentListPicker()
        }
        listConfigurationItem = item
        return [item]
    }

    override func didSelectPost() {
        guard let url = sharedURL else {
            extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
            return
        }
        let note = (contentText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        postLink(url: url, note: note, listName: selectedListName) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        }
    }

    // MARK: - List picker

    private func presentListPicker() {
        let picker = ListPickerViewController(
            stacks: stacks.map(\.name),
            selected: selectedListName
        )
        picker.onPick = { [weak self] name in
            guard let self else { return }
            self.selectedListName = name
            self.listConfigurationItem?.value = name ?? "None"
            self.popConfigurationViewController()
        }
        pushConfigurationViewController(picker)
    }

    // MARK: - Extracting the shared URL

    /// Walks the extension's input items looking for a URL. Handles the two
    /// shapes iOS delivers: a real `public.url` attachment (most apps) and a
    /// `public.plain-text` blob that contains a URL somewhere in it (Safari
    /// often shares "Page Title\nhttps://…"). Falls back to scanning text with
    /// NSDataDetector so a wrapped URL is still recovered.
    private func extractSharedURL(completion: @escaping (URL?) -> Void) {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }

        let urlType = UTType.url.identifier
        let textType = UTType.plainText.identifier

        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(urlType) }) {
            provider.loadItem(forTypeIdentifier: urlType, options: nil) { item, _ in
                let url = (item as? URL) ?? (item as? String).flatMap(Self.firstURL(in:))
                DispatchQueue.main.async { completion(url) }
            }
            return
        }

        if let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(textType) }) {
            provider.loadItem(forTypeIdentifier: textType, options: nil) { item, _ in
                let text = (item as? String) ?? (item as? URL)?.absoluteString ?? ""
                DispatchQueue.main.async { completion(Self.firstURL(in: text)) }
            }
            return
        }

        completion(nil)
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
            DispatchQueue.main.async { self.stacks = payload.stacks }
        }.resume()
    }

    private struct StacksResponse: Decodable {
        let stacks: [Stack]
    }

    // MARK: - Posting to the ingest endpoint

    private func postLink(url: URL, note: String, listName: String?, completion: @escaping () -> Void) {
        guard let endpoint = URL(string: baseURL + "/api/ingest/link"), !apiKey.isEmpty else {
            completion()
            return
        }

        var payload: [String: String] = ["url": url.absoluteString]
        if !note.isEmpty { payload["notes"] = note }
        if let listName, !listName.isEmpty { payload["listName"] = listName }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        request.timeoutInterval = 20

        URLSession.shared.dataTask(with: request) { _, _, _ in
            DispatchQueue.main.async { completion() }
        }.resume()
    }

    private func infoValue(_ key: String) -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !value.isEmpty else { return nil }
        return value
    }
}

/// A minimal list picker pushed onto the compose sheet's navigation stack.
///
/// Shows "None", every existing list, and a "New list…" row that prompts for a
/// name. Whatever the user chooses is handed back via `onPick` — the server
/// resolves it by name (creating it if new), so no id round-trip is needed.
private final class ListPickerViewController: UITableViewController {
    var onPick: ((String?) -> Void)?

    private let names: [String]
    private let selected: String?

    init(stacks: [String], selected: String?) {
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
        title = "List"
    }

    // Section 0: "None" + existing lists. Section 1: "New list…".
    override func numberOfSections(in tableView: UITableView) -> Int { 2 }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        section == 0 ? names.count + 1 : 1
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

        let name = indexPath.row == 0 ? nil : names[indexPath.row - 1]
        cell.textLabel?.text = name ?? "None"
        cell.textLabel?.textColor = .label
        cell.accessoryType = (name == selected) ? .checkmark : .none
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)

        if indexPath.section == 1 {
            promptForNewList()
            return
        }

        let name = indexPath.row == 0 ? nil : names[indexPath.row - 1]
        onPick?(name)
    }

    private func promptForNewList() {
        let alert = UIAlertController(title: "New list", message: nil, preferredStyle: .alert)
        alert.addTextField { $0.placeholder = "List name"; $0.autocapitalizationType = .sentences }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Add", style: .default) { [weak self, weak alert] _ in
            let name = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let name, !name.isEmpty else { return }
            self?.onPick?(name)
        })
        present(alert, animated: true)
    }
}

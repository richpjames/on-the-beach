import UIKit
import UniformTypeIdentifiers
import MobileCoreServices

/// Native share-sheet entry point for On The Beach.
///
/// When the user taps "On The Beach" in the iOS share sheet, iOS instantiates
/// this view controller inside the Share Extension process and hands us the
/// shared content via `extensionContext`. We pull a URL out of that content and
/// POST it to the app's ingest endpoint (`/api/ingest/link`) — the same endpoint
/// the documented iOS Shortcut uses — then dismiss with a brief confirmation.
///
/// The extension talks to the server directly rather than opening the app, so a
/// share succeeds even when the app isn't running.
final class ShareViewController: UIViewController {
    // Read from the extension's Info.plist. `OTBBaseURL` is committed; the API
    // key is injected from a gitignored xcconfig at build time (see
    // native/ShareExtension/Secrets.example.xcconfig).
    private var baseURL: String {
        infoValue("OTBBaseURL") ?? "https://onthebeach.ricojam.es"
    }

    private var apiKey: String {
        infoValue("OTBIngestAPIKey") ?? ""
    }

    private let activity = UIActivityIndicatorView(style: .large)

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor.black.withAlphaComponent(0.35)
        activity.color = .white
        activity.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(activity)
        NSLayoutConstraint.activate([
            activity.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            activity.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        activity.startAnimating()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        extractSharedURL { [weak self] url in
            guard let self else { return }
            guard let url else {
                self.finish(message: "No link found to share.", success: false)
                return
            }
            self.postLink(url)
        }
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

    private static func firstURL(in text: String) -> URL? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        let match = detector.firstMatch(in: text, options: [], range: range)
        return match?.url
    }

    // MARK: - Posting to the ingest endpoint

    private func postLink(_ url: URL) {
        guard let endpoint = URL(string: baseURL + "/api/ingest/link") else {
            finish(message: "Misconfigured server URL.", success: false)
            return
        }
        guard !apiKey.isEmpty else {
            finish(message: "Missing ingest API key in build config.", success: false)
            return
        }

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["url": url.absoluteString])
        request.timeoutInterval = 20

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            DispatchQueue.main.async {
                if let error {
                    self.finish(message: "Couldn't reach On The Beach: \(error.localizedDescription)", success: false)
                    return
                }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200...299).contains(status) {
                    self.finish(message: "Added to On The Beach.", success: true)
                } else if status == 401 {
                    self.finish(message: "Unauthorized — check the ingest API key.", success: false)
                } else {
                    let body = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                    self.finish(message: "Add failed (\(status)). \(body)", success: false)
                }
            }
        }.resume()
    }

    // MARK: - Finishing

    private func finish(message: String, success: Bool) {
        activity.stopAnimating()
        let alert = UIAlertController(
            title: success ? "On The Beach" : "Couldn't add",
            message: message,
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
            self?.extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
        })
        present(alert, animated: true)
    }

    private func infoValue(_ key: String) -> String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !value.isEmpty else { return nil }
        return value
    }
}

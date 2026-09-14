import Capacitor
import UIKit
import WebKit

/// Home-screen entry points into the app's **Listen** (song recognition) flow.
///
/// The native app is a `WKWebView` pointed at the live site, so nothing on the
/// outside can press a button in the page. Both shortcuts therefore reduce to
/// one move: load the list URL with `?action=listen`, which
/// `src/ui/logic/launch-action.ts` reads on mount and `MainPage.svelte` acts on
/// by starting the recogniser. Two ways in:
///
///   • **Long-press the app icon ▸ Listen** — a Home Screen quick action
///     (`UIApplicationShortcutItems`), delivered to `performActionFor` below.
///     iOS reserves a *widget's* own long-press menu (Edit Widget / Remove
///     Widget) and gives apps no way to add to it, so the app icon is where a
///     long press can offer this.
///   • **The Listen widget** — `native/Widget/OTBWidget.swift` opens
///     `onthebeach://listen`, which arrives as a `.capacitorOpenURL`
///     notification from Capacitor's app-delegate proxy.
///
/// Both the quick action and the URL scheme are registered on the generated app
/// by `scripts/add-listen-shortcut.rb`, which also adds this file to the App
/// target and declares `NSMicrophoneUsageDescription` — without which the
/// recogniser's first `getUserMedia` call would be refused by the system.
///
/// The hooks are an `extension AppDelegate` rather than edits to Capacitor's
/// generated `AppDelegate.swift`: both methods are ones the template leaves
/// unimplemented, so we can add them without owning (or drifting from) a file
/// `cap add` rewrites.

// MARK: - Actions

enum OTBLaunchAction: String, CaseIterable {
    case listen

    /// The Home Screen quick action's type. Must match the
    /// `UIApplicationShortcutItemType` that `scripts/add-listen-shortcut.rb`
    /// writes into the app's Info.plist.
    var shortcutType: String { "otb-\(rawValue)" }

    /// The query the web app reads on load (`src/ui/logic/launch-action.ts`).
    var webQuery: String { "action=\(rawValue)" }

    /// The action a widget deep link asks for, e.g. `onthebeach://listen`.
    static func named(in url: URL) -> OTBLaunchAction? {
        guard url.scheme?.lowercased() == OTBLaunchActions.urlScheme else { return nil }
        // `onthebeach://listen` parses as the host; tolerate `onthebeach:///listen` too.
        let name = url.host ?? url.pathComponents.first(where: { $0 != "/" })
        guard let name = name else { return nil }
        return OTBLaunchAction(rawValue: name.lowercased())
    }

    static func named(shortcutType: String) -> OTBLaunchAction? {
        allCases.first { $0.shortcutType == shortcutType }
    }
}

// MARK: - Delivery

final class OTBLaunchActions {
    static let shared = OTBLaunchActions()

    /// Registered as a `CFBundleURLTypes` scheme on the app by the script above.
    static let urlScheme = "onthebeach"

    /// How long to keep trying to reach the web view. A cold launch handles the
    /// shortcut before the bridge view controller has loaded, so the action
    /// waits for it rather than being dropped on the floor.
    private static let deliveryRetryInterval: TimeInterval = 0.25
    private static let deliveryAttempts = 20 // ≈ 5s

    private var pending: OTBLaunchAction?
    private var attemptsLeft = 0
    private var retryScheduled = false
    private var observing = false
    /// Held for the life of the app; the notification centre owns the blocks.
    private var observers: [NSObjectProtocol] = []

    /// Start listening for widget deep links. Called from
    /// `application(_:willFinishLaunchingWithOptions:)`, which runs before iOS
    /// delivers the launch URL.
    func startObserving() {
        guard !observing else { return }
        observing = true

        // Capacitor's ApplicationDelegateProxy posts this for every URL the app
        // is opened with — the generated AppDelegate already forwards to it, so
        // observing is all we need to do.
        observers.append(NotificationCenter.default.addObserver(
            forName: .capacitorOpenURL,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let payload = notification.object as? [String: Any],
                  let url = payload["url"] as? URL else { return }
            self?.handle(url: url)
        })

        // A shortcut taken while the app was suspended can arrive before the web
        // view is ready; flush anything still waiting once we're on screen.
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.deliverPending()
        })
    }

    @discardableResult
    func handle(url: URL) -> Bool {
        guard let action = OTBLaunchAction.named(in: url) else { return false }
        return run(action)
    }

    @discardableResult
    func handle(shortcutType: String) -> Bool {
        guard let action = OTBLaunchAction.named(shortcutType: shortcutType) else { return false }
        return run(action)
    }

    // MARK: - Private

    private func run(_ action: OTBLaunchAction) -> Bool {
        pending = action
        attemptsLeft = Self.deliveryAttempts
        deliverPending()
        return true
    }

    private func deliverPending() {
        guard let action = pending else { return }

        if let webView = bridgeViewController()?.bridge?.webView, let url = webURL(for: action) {
            pending = nil
            webView.load(URLRequest(url: url))
            return
        }

        guard attemptsLeft > 0 else {
            // The web view never appeared — drop the action rather than leaving
            // it to fire at some unrelated moment later.
            pending = nil
            return
        }
        attemptsLeft -= 1
        scheduleRetry()
    }

    private func scheduleRetry() {
        guard !retryScheduled else { return }
        retryScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.deliveryRetryInterval) { [weak self] in
            self?.retryScheduled = false
            self?.deliverPending()
        }
    }

    /// The list URL carrying the action, built from the origin the shell is
    /// configured with (`server.url` in capacitor.config.ts) rather than
    /// whatever page the web view happens to be showing.
    private func webURL(for action: OTBLaunchAction) -> URL? {
        guard let bridge = bridgeViewController()?.bridge,
              var components = URLComponents(
                  url: bridge.config.serverURL,
                  resolvingAgainstBaseURL: false
              ) else { return nil }
        components.path = "/"
        components.query = action.webQuery
        return components.url
    }

    private func bridgeViewController() -> CAPBridgeViewController? {
        let delegateRoot = (UIApplication.shared.delegate as? AppDelegate)?
            .window?.rootViewController
        if let found = bridgeViewController(in: delegateRoot) { return found }

        let sceneRoot = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }?
            .rootViewController
        return bridgeViewController(in: sceneRoot)
    }

    private func bridgeViewController(in controller: UIViewController?) -> CAPBridgeViewController? {
        guard let controller = controller else { return nil }
        if let bridgeController = controller as? CAPBridgeViewController { return bridgeController }
        for child in controller.children {
            if let found = bridgeViewController(in: child) { return found }
        }
        return bridgeViewController(in: controller.presentedViewController)
    }
}

// MARK: - App delegate hooks

extension AppDelegate {
    /// Runs before iOS hands over a launch URL, so the observer is in place for
    /// a cold launch from the Listen widget. Capacitor's template doesn't
    /// implement this method; returning true keeps the normal launch sequence.
    @objc func application(
        _ application: UIApplication,
        willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        OTBLaunchActions.shared.startObserving()
        return true
    }

    // Home Screen quick actions are an iOS gesture; Mac Catalyst has no Home
    // Screen, so the Mac build skips this hook (the widget's deep link, which
    // does work there, is handled above).
    #if !targetEnvironment(macCatalyst)
    /// Long-press the app icon ▸ Listen. Called for a cold launch too, because
    /// the generated `didFinishLaunchingWithOptions` returns true.
    @objc func application(
        _ application: UIApplication,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        completionHandler(OTBLaunchActions.shared.handle(shortcutType: shortcutItem.type))
    }
    #endif
}

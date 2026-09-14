import SwiftUI
import UIKit
import WidgetKit

/// Home-screen widgets for On The Beach.
///
/// Two small (square) tiles, both drawing the app's icon — the surfing capybara:
///
///   • **On The Beach** — the icon on the black playlist well. Tapping it opens
///     the app. That's deliberately all it is: the app is about enjoying music,
///     not about clearing a queue, so the widget is a shortcut and a bit of
///     character rather than a number to be driven down.
///   • **Listen** — the same icon over a Windows 98 LISTEN button. Tapping it
///     opens the app straight into song recognition (`onthebeach://listen`),
///     which is the one thing worth doing without unlocking into the app first:
///     something is playing *now*.
///
/// The Listen tile is a whole-tile tap target rather than a button inside the
/// first one because WidgetKit gives a `systemSmall` widget exactly one tap
/// target (`widgetURL`); `Link` only splits mediums and larges. Two tiles in the
/// gallery is also the clearer offer — pick the one you want on the Home Screen.
///
/// iOS reserves a widget's own long-press menu (Edit Widget / Remove Widget), so
/// the long-press route to Listen is the **app icon's** Home Screen quick
/// action, wired up in `scripts/add-listen-shortcut.rb` and handled by
/// `native/App/OTBLaunchActions.swift` — the same deep link this tile opens.
///
/// Because there's nothing to load, the widgets need no network, no ingest key
/// and no App Group: they draw a bundled image and render the same forever.
///
/// Like the Share Extension, this is native SwiftUI with no access to the web
/// app's stylesheet, so the Windows 98 / Winamp look (black playlist well,
/// electric-blue accent, chrome grey buttons, Courier/Verdana type) is mirrored
/// here in `OTBTheme`.

// MARK: - Artwork

/// The app icon exactly as the Home Screen draws it: the committed master at
/// `native/AppIcon.appiconset/AppIcon-512@2x.png` (the capybara composited on
/// white), added to this target's resources by
/// `scripts/add-widget-extension.rb` and referenced in place, so the appiconset
/// stays the single source of truth for the icon.
///
/// Loaded by URL rather than `UIImage(named:)` because the `@2x` in the filename
/// is a scale suffix to `UIImage`, which would go looking for `AppIcon-512`.
private let otbAppIcon: UIImage? = {
    guard let url = Bundle.main.url(forResource: "AppIcon-512@2x", withExtension: "png") else {
        return nil
    }
    return UIImage(contentsOfFile: url.path)
}()

/// The brand master `assets/logo.png` — the transparent capybara the app icon is
/// made from, also bundled by the script. It backs up the icon above: nil means
/// the resource wasn't wired into the target, and the view falls back again to a
/// wordmark, so the tile always renders something.
private let otbLogo: UIImage? = UIImage(named: "logo")

// MARK: - Deep links

/// Opens the app and starts song recognition. The scheme is registered on the
/// app by `scripts/add-listen-shortcut.rb`; `native/App/OTBLaunchActions.swift`
/// turns it into `/?action=listen`, which the web app acts on as it loads.
private let otbListenURL = URL(string: "onthebeach://listen")

// MARK: - Timeline model

/// The widgets have no data, so the entry carries nothing but its date.
struct OTBEntry: TimelineEntry {
    let date: Date
}

// MARK: - Provider

struct OTBProvider: TimelineProvider {
    func placeholder(in context: Context) -> OTBEntry {
        OTBEntry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (OTBEntry) -> Void) {
        completion(OTBEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<OTBEntry>) -> Void) {
        // One entry that never changes: nothing to refresh, so don't ask
        // WidgetKit to wake us again.
        completion(Timeline(entries: [OTBEntry(date: Date())], policy: .never))
    }
}

// MARK: - Views

/// The app icon, rounded like the Home Screen draws it.
struct OTBIconView: View {
    var body: some View {
        Group {
            if let icon = otbAppIcon ?? otbLogo {
                Image(uiImage: icon)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    // The icon master is opaque (iOS icons must be), so give it
                    // the same squircle the Home Screen does rather than leaving
                    // a hard white square on the black well.
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            } else {
                // Resources missing — draw the wordmark rather than an empty tile.
                Text("ON THE\nBEACH")
                    .font(OTBTheme.mono(15))
                    .foregroundStyle(OTBTheme.accent)
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.5)
            }
        }
    }
}

struct OTBWidgetEntryView: View {
    var entry: OTBEntry

    var body: some View {
        OTBIconView()
            // The system's default content margins (~16pt) would leave the
            // capybara small and adrift in the tile, so they're switched off on
            // the configuration and the icon gets a tighter inset that keeps it
            // clear of the rounded corners.
            .padding(10)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .containerBackground(for: .widget) {
                OTBTheme.playlistBg
            }
    }
}

struct OTBListenWidgetEntryView: View {
    var entry: OTBEntry

    var body: some View {
        VStack(spacing: 8) {
            OTBIconView()
            Text("LISTEN")
                .font(OTBTheme.ui(13, bold: true))
                .foregroundStyle(OTBTheme.chromeBlack)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .background(OTBTheme.chrome)
                .overlay(OTBBevel())
        }
        .padding(10)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerBackground(for: .widget) {
            OTBTheme.playlistBg
        }
        // A small widget has a single tap target, so the whole tile is the
        // button — tapping anywhere starts listening.
        .widgetURL(otbListenURL)
    }
}

/// The Windows 98 raised bevel: light top/left edges, dark bottom/right ones
/// (`--bevel-raised` in the web app's stylesheet).
struct OTBBevel: View {
    var body: some View {
        Rectangle()
            .fill(Color.clear)
            .overlay(alignment: .top) { edge(OTBTheme.chromeWhite, height: 1) }
            .overlay(alignment: .leading) { edge(OTBTheme.chromeWhite, width: 1) }
            .overlay(alignment: .bottom) { edge(OTBTheme.chromeDarker, height: 1) }
            .overlay(alignment: .trailing) { edge(OTBTheme.chromeDarker, width: 1) }
    }

    private func edge(_ color: Color, width: CGFloat? = nil, height: CGFloat? = nil) -> some View {
        Rectangle().fill(color).frame(width: width, height: height)
    }
}

// MARK: - Widgets

struct OTBWidget: Widget {
    // Stable kind identifier; changing it drops users' installed widgets, so it
    // keeps the name it was first shipped under even though the content changed.
    let kind = "OTBToListenWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: OTBProvider()) { entry in
            OTBWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("On The Beach")
        .description("The capybara on your home screen. Tap to open On The Beach.")
        // Home Screen only. The Lock Screen accessory families are rendered
        // monochrome by the system, which turns the icon into an unreadable
        // silhouette, and there's no number to put there instead.
        .supportedFamilies([.systemSmall])
        // The tile is one image on a black well; the view sets its own inset.
        .contentMarginsDisabled()
    }
}

struct OTBListenWidget: Widget {
    let kind = "OTBListenWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: OTBProvider()) { entry in
            OTBListenWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Listen")
        .description("Identify what's playing and add it to your queue — one tap, no typing.")
        .supportedFamilies([.systemSmall])
        .contentMarginsDisabled()
    }
}

@main
struct OTBWidgetBundle: WidgetBundle {
    var body: some Widget {
        OTBWidget()
        OTBListenWidget()
    }
}

// MARK: - Windows 98 / Winamp styling
//
// Mirrors the `:root` design tokens in the web app's src/styles/main.css, the
// same way native/ShareExtension/ShareViewController.swift's OTBTheme does — the
// widget can't reach that stylesheet, so the palette and fonts live here too.

enum OTBTheme {
    static let playlistBg = Color(red: 0, green: 0, blue: 0)             // --playlist-bg
    static let accent = Color(rgb: 0x6699FF)                            // --accent: electric blue
    static let chrome = Color(rgb: 0xC0C0C0)                            // --chrome: button face
    static let chromeWhite = Color.white                                // --chrome-white: lit bevel
    static let chromeDarker = Color(rgb: 0x404040)                      // --chrome-darker: shadow bevel
    static let chromeBlack = Color(rgb: 0x000000)                       // --chrome-black: button label

    /// Mono/terminal type for the wordmark — the web's Share Tech Mono stand-in,
    /// using Courier New (always present on iOS).
    static func mono(_ size: CGFloat) -> Font {
        Font.custom("CourierNewPSMT", size: size)
    }

    /// UI chrome type. The web uses Tahoma; iOS doesn't ship it, so we use
    /// Verdana — the same designer's near-identical face, on every device.
    static func ui(_ size: CGFloat, bold: Bool = false) -> Font {
        Font.custom(bold ? "Verdana-Bold" : "Verdana", size: size)
    }
}

extension Color {
    /// Builds a colour from a 0xRRGGBB literal, matching how the CSS tokens are
    /// written (same convention as the UIColor(rgb:) helper in the extension).
    init(rgb: UInt32) {
        self.init(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }
}

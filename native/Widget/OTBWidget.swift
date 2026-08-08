import SwiftUI
import UIKit
import WidgetKit

/// Home-screen widget for On The Beach.
///
/// A single small (square) widget that shows the app's logo — the surfing
/// capybara — on the black playlist well. That's deliberately all it is: the app
/// is about enjoying music, not about clearing a queue, so the widget is a
/// shortcut and a bit of character rather than a number to be driven down.
///
/// Because there's nothing to load, the widget needs no network, no ingest key
/// and no App Group: it draws a bundled image and renders the same forever.
/// Tapping it opens the app.
///
/// Like the Share Extension, this is native SwiftUI with no access to the web
/// app's stylesheet, so the Windows 98 / Winamp look (black playlist well,
/// electric-blue accent, Courier chrome type) is mirrored here in `OTBTheme`.

// MARK: - Logo

/// The brand master `assets/logo.png`, added to this target's resources by
/// `scripts/add-widget-extension.rb` (referenced in place — `assets/logo.png`
/// stays the single source of truth for every icon in the project).
///
/// `UIImage(named:)` finds a loose resource by filename in the extension's own
/// bundle. Nil means the resource wasn't wired into the target; the view falls
/// back to a wordmark so the widget always renders something.
private let otbLogo: UIImage? = UIImage(named: "logo")

// MARK: - Timeline model

/// The widget has no data, so the entry carries nothing but its date.
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

// MARK: - View

struct OTBWidgetEntryView: View {
    var entry: OTBEntry

    var body: some View {
        Group {
            if let logo = otbLogo {
                Image(uiImage: logo)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    // The system's default content margins (~16pt) would leave
                    // the capybara small and adrift in the tile, so they're
                    // switched off on the configuration and the logo gets a
                    // tighter inset that keeps it clear of the rounded corners.
                    .padding(10)
            } else {
                // Resource missing — draw the wordmark rather than an empty tile.
                Text("ON THE\nBEACH")
                    .font(OTBTheme.mono(15))
                    .foregroundStyle(OTBTheme.accent)
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.5)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerBackground(for: .widget) {
            OTBTheme.playlistBg
        }
    }
}

// MARK: - Widget

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
        // monochrome by the system, which turns the logo into an unreadable
        // silhouette, and there's no number to put there instead.
        .supportedFamilies([.systemSmall])
        // The tile is one image on a black well; the view sets its own inset.
        .contentMarginsDisabled()
    }
}

@main
struct OTBWidgetBundle: WidgetBundle {
    var body: some Widget {
        OTBWidget()
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

    /// Mono/terminal type for the wordmark — the web's Share Tech Mono stand-in,
    /// using Courier New (always present on iOS).
    static func mono(_ size: CGFloat) -> Font {
        Font.custom("CourierNewPSMT", size: size)
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

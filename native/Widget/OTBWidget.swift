import WidgetKit
import SwiftUI

/// Home-screen widget for On The Beach.
///
/// A single small (square) widget that shows how many releases are still queued
/// "To Listen" — the one glanceable number for a listening tracker. It fetches
/// `GET /api/ingest/stats` with the same `Bearer` ingest key the Share Extension
/// uses (read from the widget's Info.plist: `OTBBaseURL` committed, the key
/// injected from the gitignored `Secrets.xcconfig` at build time), so no session
/// or App Group is needed. Tapping the widget opens the app.
///
/// Like the Share Extension, this is native SwiftUI with no access to the web
/// app's stylesheet, so the Windows 98 / Winamp look (black playlist well,
/// electric-blue accent, Verdana chrome type) is mirrored here in `OTBTheme`.

// MARK: - Config read from Info.plist

/// Reads a non-empty string from the widget's Info.plist, or nil. `OTBBaseURL`
/// is committed; `OTBIngestAPIKey` resolves from `$(OTB_INGEST_API_KEY)` in
/// Secrets.xcconfig at build time (mirrors ShareViewController.infoValue).
private func infoValue(_ key: String) -> String? {
    guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
          !value.isEmpty else { return nil }
    return value
}

// MARK: - Timeline model

/// One rendered state of the widget. `toListen == nil` means the count couldn't
/// be loaded (no key wired, offline, server error) — the view shows a dash.
struct OTBEntry: TimelineEntry {
    let date: Date
    let toListen: Int?
}

// MARK: - Networking

private struct StatsResponse: Decodable {
    let toListen: Int

    enum CodingKeys: String, CodingKey {
        case toListen = "to_listen"
    }
}

/// Fetches the "To Listen" count. Any failure (missing key, network, decode)
/// resolves to nil rather than throwing, so the widget always renders something.
private func fetchToListen(completion: @escaping (Int?) -> Void) {
    guard let base = infoValue("OTBBaseURL"),
          let key = infoValue("OTBIngestAPIKey"),
          let endpoint = URL(string: base + "/api/ingest/stats") else {
        completion(nil)
        return
    }

    var request = URLRequest(url: endpoint)
    request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 15

    URLSession.shared.dataTask(with: request) { data, _, _ in
        guard let data,
              let payload = try? JSONDecoder().decode(StatsResponse.self, from: data) else {
            completion(nil)
            return
        }
        completion(payload.toListen)
    }.resume()
}

// MARK: - Provider

struct OTBProvider: TimelineProvider {
    /// Shown in the gallery / while the real entry loads.
    func placeholder(in context: Context) -> OTBEntry {
        OTBEntry(date: Date(), toListen: 12)
    }

    func getSnapshot(in context: Context, completion: @escaping (OTBEntry) -> Void) {
        // The widget gallery preview shouldn't make a network call; show a sample.
        if context.isPreview {
            completion(OTBEntry(date: Date(), toListen: 12))
            return
        }
        fetchToListen { count in
            completion(OTBEntry(date: Date(), toListen: count))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<OTBEntry>) -> Void) {
        fetchToListen { count in
            let entry = OTBEntry(date: Date(), toListen: count)
            // Refresh roughly every 30 minutes. WidgetKit budgets background
            // refreshes, so asking for more just gets throttled; the count is
            // also refreshed whenever the system reloads the timeline.
            let next = Calendar.current.date(byAdding: .minute, value: 30, to: Date())
                ?? Date().addingTimeInterval(1800)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }
}

// MARK: - View

struct OTBWidgetEntryView: View {
    // Which family this instance is rendering — drives the per-surface layout.
    // The Home Screen family keeps the full app look; the Lock Screen accessory
    // families use compact layouts the system draws in monochrome (custom colors
    // are ignored there), so they carry the app's *type* and wording instead.
    @Environment(\.widgetFamily) private var family
    var entry: OTBEntry

    private var countText: String {
        guard let n = entry.toListen else { return "—" }
        return "\(n)"
    }

    private var releaseWord: String {
        entry.toListen == 1 ? "release" : "releases"
    }

    var body: some View {
        switch family {
        case .accessoryInline:
            // A single line beside the Lock Screen clock, e.g. "12 to listen".
            Text("\(countText) to listen")
                .font(OTBTheme.mono(11))

        case .accessoryCircular:
            // Circular Lock Screen slot: the glanceable number over the standard
            // translucent accessory background.
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text(countText)
                        .font(OTBTheme.number(22))
                        .lineLimit(1)
                        .minimumScaleFactor(0.4)
                    Text("QUEUED")
                        .font(OTBTheme.mono(8))
                }
            }
            .containerBackground(for: .widget) { Color.clear }

        case .accessoryRectangular:
            // Wide Lock Screen slot: number + the same TO LISTEN / releases lines
            // the Home Screen widget uses, so it reads as the same app.
            HStack(spacing: 10) {
                Text(countText)
                    .font(OTBTheme.number(34))
                    .lineLimit(1)
                    .minimumScaleFactor(0.4)
                VStack(alignment: .leading, spacing: 2) {
                    Text("TO LISTEN").font(OTBTheme.mono(11))
                    Text(releaseWord).font(OTBTheme.ui(11))
                }
            }
            .containerBackground(for: .widget) { Color.clear }

        default:
            homeScreen
        }
    }

    // The original Home Screen (systemSmall) layout — the full app aesthetic:
    // black playlist well, electric-blue count, Verdana/Courier chrome.
    private var homeScreen: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("TO LISTEN")
                .font(OTBTheme.mono(11))
                .foregroundStyle(OTBTheme.playlistText)
                .lineLimit(1)
                .minimumScaleFactor(0.7)

            Spacer(minLength: 0)

            Text(countText)
                .font(OTBTheme.number(44))
                .foregroundStyle(OTBTheme.accent)
                .lineLimit(1)
                .minimumScaleFactor(0.4)

            Text(releaseWord)
                .font(OTBTheme.ui(11))
                .foregroundStyle(OTBTheme.playlistText.opacity(0.7))
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .containerBackground(for: .widget) {
            OTBTheme.playlistBg
        }
    }
}

// MARK: - Widget

struct OTBWidget: Widget {
    // Stable kind identifier; changing it drops users' installed widgets.
    let kind = "OTBToListenWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: OTBProvider()) { entry in
            OTBWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("To Listen")
        .description("How many releases are queued to listen to.")
        // Home Screen (systemSmall) keeps the full app look; the accessory
        // families put the same count on the Lock Screen (rendered monochrome).
        .supportedFamilies([
            .systemSmall,
            .accessoryCircular,
            .accessoryRectangular,
            .accessoryInline,
        ])
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
    static let playlistText = Color(rgb: 0xADC8FF)                       // --playlist-text
    static let accent = Color(rgb: 0x6699FF)                            // --accent: electric blue

    /// UI chrome type. The web uses Tahoma; iOS ships Verdana (the same
    /// designer's near-identical face), so use it with a system fallback.
    static func ui(_ size: CGFloat) -> Font {
        Font.custom("Verdana", size: size)
    }

    /// Bold Verdana for the big number.
    static func number(_ size: CGFloat) -> Font {
        Font.custom("Verdana-Bold", size: size)
    }

    /// Mono/terminal type for the label — the web's Share Tech Mono stand-in,
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

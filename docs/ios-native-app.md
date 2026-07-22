# Native App & Share Extension (iOS + macOS)

This is the "real" share-sheet integration: a native app (a thin
[Capacitor](https://capacitorjs.com) shell around the hosted web app) plus a
native **Share Extension** so **On The Beach** appears in the share sheet as a
first-class destination — no Shortcut required. The same app and extension serve
both **iOS** and **macOS**: iOS is the primary target, and macOS support comes
for free by building the same targets with **Mac Catalyst** (see [Enable macOS
(Mac Catalyst)](#6-enable-macos-mac-catalyst) below).

> **Why native?** iOS Safari does not implement the Web Share _Target_ API, so a
> PWA can never register as a share destination on iOS. The only ways a web app
> can appear in the share sheet are (a) a user-installed Shortcut
> (`docs/ios-shortcut.md`) or (b) a native app that ships a Share Extension —
> this document. On macOS the share **menu** likewise only lists Share
> extensions vended by installed native apps, so the same native app — built for
> the Mac via Mac Catalyst — is what puts On The Beach in the Mac share menu.

## How it works

- The Capacitor shell (`ios/App/`, generated on a mac) is a `WKWebView` pointed
  at the production URL via `capacitor.config.ts` (`server.url`). It's just a
  wrapper so there's a real app to host the extension; there is no separate
  mobile web bundle to maintain. The same shell target also builds as a native
  Mac app under **Mac Catalyst**, which is what hosts the extension on macOS.
- The `ShareViewController.swift` and `Info.plist` are shared **byte-for-byte**
  across iOS and macOS — it's a custom `UIViewController` compose form (plus
  `UIAlertController`), all of which work under Mac Catalyst, so no Mac-specific
  Swift is needed.
- The Share Extension (`native/ShareExtension/`) is the part that matters. When the
  user shares a link, `ShareViewController.swift` shows a small compose form with an
  optional **note** field and a **List** row. The List row fetches your lists from
  `GET /api/ingest/stacks` and lets you pick an existing one or create a new one by
  name. On **Add** it `POST`s the URL — plus `notes` and `listName` when set — to
  `POST /api/ingest/link` with a `Bearer` token. The extension talks to the server
  directly, so a share works even when the app isn't running.
- Posting is **synchronous**: the form stays on screen showing an "Adding…" spinner
  until the request finishes. On success it flashes a brief checkmark toast built
  from the server's response — "Added", "Added to Jazz, Chill", or "Already saved"
  for a duplicate — then dismisses; on failure it presents a blocking error alert
  (a deliberate departure from Apple's `SLComposeServiceViewController`, which
  swooshes away on Post and leaves nowhere to report a failure). The networking
  lives in the container view controller, which outlives the form, so there's
  always a live controller to present the toast and alert on.

```
iOS share sheet ──► ShareExtension compose form ──► POST /api/ingest/link ──► item created
        (note + list picker)          GET /api/ingest/stacks ──┘  (filed into list)
```

## What lives in the repo vs. what's generated

| Path                              | Source of truth | Committed? |
| --------------------------------- | --------------- | ---------- |
| `capacitor.config.ts`             | hand-authored   | yes        |
| `native/ShareExtension/*.swift`      | hand-authored   | yes        |
| `native/ShareExtension/Info.plist`   | hand-authored   | yes        |
| `native/ShareExtension/Secrets.xcconfig` | you create locally | no (gitignored) |
| `native/Widget/*.swift`, `Info.plist`, `OTBWidget.entitlements` | hand-authored | yes |
| `scripts/add-share-extension.rb`  | hand-authored   | yes        |
| `scripts/add-widget-extension.rb` | hand-authored   | yes        |
| `assets/logo.png`                 | hand-authored (the one brand master) | yes |
| `scripts/generate-brand-assets.sh` | hand-authored  | yes        |
| `public/favicon*`, `public/*-chrome-*`, `apple-touch-icon.png` | generated from `assets/logo.png` | yes |
| `ios/App/` (Xcode project, Pods)  | `bun run cap:add` + the scripts | no (gitignored) |

The whole `ios/` directory is generated, not committed, so it's never stale
relative to the Capacitor version. Regenerate it any time by removing `ios/` and
running `bun run cap:add` followed by `ruby scripts/add-share-extension.rb` and
`ruby scripts/add-widget-extension.rb` to re-inject the extension targets.
Because the targets are scripted (not hand-clicked in Xcode), CI can reproduce
the whole build on every PR — see `.github/workflows/ios-build.yml`.

`add-share-extension.rb` also patches two host-app details that Capacitor gets
wrong for our case, so they survive every regenerate:

- **`CFBundleName = "On The Beach"`.** Capacitor sets it to `"App"`. The macOS
  "Login Items & Extensions ▸ Sharing" list titles each provider by its
  `CFBundleName` (not `CFBundleDisplayName`), so without this the app — and its
  Share Extension row — shows as a generic "App". It's also the Catalyst menu-bar
  title.
- **Extension version = the app's.** The extension's `CFBundleVersion` /
  `CFBundleShortVersionString` are mirrored from the App target, or an archive is
  rejected ("The CFBundleVersion of an app extension … must match…").

## Brand assets (icons + favicons from one source)

Every app icon and web favicon derives from a single master, **`assets/logo.png`**
(a transparent square — ideally ≥1024px). `scripts/generate-brand-assets.sh`
(`bun run brand:assets`) regenerates all of them:

- **Web favicons** in `public/` (`favicon.ico`, `-16`/`-32`, `apple-touch-icon`,
  `android-chrome-*`) — kept transparent.
- **iOS + Mac Catalyst app icon and splash** in the generated `ios/` tree, via
  `@capacitor/assets` (logo composited on white, since iOS icons must be opaque).

Two gotchas the script handles: `@capacitor/assets` rewrites the AppIcon
`Contents.json` and drops the Mac Catalyst `mac` idiom on every run (without it,
Catalyst shows a placeholder icon), so the script regenerates the `mac`
renditions and rewrites `Contents.json`. Requires ImageMagick (`magick`).

To rebrand: replace `assets/logo.png` and run `bun run brand:assets` (then
`bun run cap:sync` to copy the web assets into the app).

## Home-screen Widget

A small (square) **WidgetKit** widget shows how many releases are still queued
**To Listen** — the one glanceable number for a listening tracker. It's the
widget sibling of the Share Extension: hand-authored SwiftUI in
`native/Widget/OTBWidget.swift`, injected into the generated Xcode project by
`scripts/add-widget-extension.rb` (extension point
`com.apple.widgetkit-extension`), and compiled in CI by the same `ios-build.yml`
job that builds the app and Share Extension.

- **Data.** The widget fetches `GET /api/ingest/stats` (added in
  `server/routes/ingest.ts`), which returns `{ "to_listen": N }`. It's
  Bearer-authed with the **same** ingest key the Share Extension uses, so there's
  nothing new to configure: the widget's `Info.plist` carries `OTBBaseURL`
  (committed) and `OTBIngestAPIKey` (`$(OTB_INGEST_API_KEY)`, substituted at
  build time), and its target reuses `native/ShareExtension/Secrets.xcconfig` as
  its base configuration — one gitignored secret for the whole app. Any failure
  (no key, offline, server error) renders a dash rather than an error.
- **Refresh.** The timeline refreshes roughly every 30 minutes; WidgetKit budgets
  background reloads, so the count is eventually-consistent, not live.
- **Styling.** Like the Share Extension, the widget can't reach the web app's
  stylesheet, so the Windows 98 / Winamp look (black playlist well, electric-blue
  accent, Verdana chrome type) is mirrored in the file's `OTBTheme`.
- **Mac Catalyst + sandbox.** `SUPPORTS_MACCATALYST` is enabled and
  `native/Widget/OTBWidget.entitlements` grants the sandboxed extension outbound
  network (macOS always sandboxes an app extension; without
  `com.apple.security.network.client` the stats GET is silently denied) — exactly
  as the Share Extension does. It's wired via `CODE_SIGN_ENTITLEMENTS[sdk=macosx*]`
  so iOS device signing is untouched.

To add it to your home screen: long-press the home screen ▸ **+** ▸ search **On
The Beach** ▸ pick the small **To Listen** widget. Tapping it opens the app.

## Prerequisites (mac only)

- macOS with **Xcode** and command line tools.
- **CocoaPods** (`sudo gem install cocoapods` or `brew install cocoapods`).
- An **Apple Developer account** for signing (a free personal team works for
  installing on your own device; a paid account is needed for TestFlight/App
  Store).
- `bun install` already run in the repo.

## One-time setup

### 1. Generate the Capacitor iOS project

```bash
bun install
bun run build        # produces build/client — cap sync needs webDir to exist
bun run cap:add      # cap add ios — creates ios/App/ (gitignored)
ruby scripts/add-share-extension.rb   # inject the Share Extension target (§2)
ruby scripts/add-widget-extension.rb  # inject the Widget target (after §2)
bun run brand:assets # capybara app icon + splash into ios/ (needs ImageMagick)
bun run cap:open     # cap open ios — opens ios/App/App.xcworkspace in Xcode
```

> `scripts/add-share-extension.rb` needs the `xcodeproj` gem
> (`gem install xcodeproj`). CocoaPods depends on it, so it's already present on
> a machine set up to build this project — but usually under CocoaPods' own Ruby;
> installing it into the Ruby you'll run the script with is the reliable path.
> The same script runs in CI (`.github/workflows/ios-build.yml`).

> Use `bun run cap:add` / `bunx cap add ios`, **not** `npx cap add ios`. This
> project installs the Capacitor CLI with Bun, so `npx` can't find the `cap`
> binary — it tries to fetch an unrelated npm package named `cap` and fails with
> "could not determine executable to run".

> `cap sync` (and the sync `cap add` runs at the end) copies `webDir`
> (`build/client`) into the app, so that directory must exist first — otherwise
> you get `sync could not run--missing build/client directory`. Because
> `server.url` points the shell at the live site, the copied contents are never
> served, so `bun run build` output — or even a placeholder `build/client/`
> containing a single `index.html` — satisfies it.

> **Full Xcode is required, not just the Command Line Tools.** `cap sync` finishes
> with an `xcodebuild … clean` step; with only the CLT installed it fails with
> `tool 'xcodebuild' requires Xcode`. `pod install` itself works under the CLT, so
> if you only need the pods you can run `cd ios/App && pod install` directly and
> skip the failing clean step. Point `xcode-select` at real Xcode once installed:
> `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.

### 2. Add the Share Extension target

`scripts/add-share-extension.rb` injects the `ShareExtension` app-extension
target into the generated `ios/App/App.xcodeproj` — the scripted equivalent of
adding it by hand in Xcode. Run it after `cap:add` (step 1 already does):

```bash
ruby scripts/add-share-extension.rb
```

It references `native/ShareExtension/ShareViewController.swift` and `Info.plist`
**in place** (git stays the source of truth — nothing is copied into `ios/`),
sets the target's Info.plist path and bundle id
(`es.ricojam.onthebeach.ShareExtension`), wires the `Secrets.xcconfig` base
configuration, and adds the "Embed App Extensions" phase so building the `App`
scheme also builds the extension. It's idempotent, so re-running it (e.g. after
regenerating `ios/`) is safe.

Notes on what the script encodes, in case you ever do it manually instead:

- The provided `Info.plist` has no `NSExtensionMainStoryboard` key (it uses
  `NSExtensionPrincipalClass`), so no storyboard is needed.
- The **iOS Deployment Target is 26.0** for the whole app. Capacitor generates
  the App target at 13.0; the script raises the App target, the project, and the
  extension to 26.0 so there's one floor across the app (this is a single-user
  app that runs the current iOS). It also comfortably clears the iOS 14 `UTType`
  API that `ShareViewController.swift` uses.
- **Mac Catalyst** is enabled on both the App and extension targets (the
  extension only reaches the macOS share menu if both build for Catalyst).

> This is what the CI check builds — a broken `ShareViewController.swift` or
> Capacitor/Info.plist change fails the PR instead of only surfacing here.

### 3. Wire up the ingest API key

```bash
cp native/ShareExtension/Secrets.example.xcconfig native/ShareExtension/Secrets.xcconfig
# edit Secrets.xcconfig, set OTB_INGEST_API_KEY to match the server's INGEST_API_KEY
```

The script in step 2 already wires this file as the **ShareExtension** target's
configuration file for both Debug and Release, so you don't need to touch Xcode's
Configurations pane. Just create `Secrets.xcconfig` **before** running the script
(if you add it afterwards, re-run the script). The key flows into the extension's
`Info.plist` through the `$(OTB_INGEST_API_KEY)` substitution and is read at
runtime by `ShareViewController`.

`OTBBaseURL` is already set to the production origin in `Info.plist`; change it
there if you deploy elsewhere.

### 4. Signing

Select each target (App and ShareExtension) ▸ **Signing & Capabilities** ▸ pick
your team. The extension's bundle id must be a child of the app's, e.g.
`es.ricojam.onthebeach` and `es.ricojam.onthebeach.ShareExtension` — Xcode
suggests this automatically.

### 5. Build & run

Plug in an iPhone (share-sheet testing is best on a device), select the **App**
scheme, and run. To use the extension: open Safari, tap **Share**, and pick
**On The Beach**. You should see the compose form — type a note if you like, tap
**List** to file it into a list (existing or new), then tap **Add**.

### 6. Enable macOS (Mac Catalyst)

Mac Catalyst runs the **same** `App` and `ShareExtension` targets as a native Mac
app, so the compose form and ingest logic are shared with iOS — there is no
separate macOS code to write or keep in sync.

`scripts/add-share-extension.rb` already enables Mac Catalyst
(`SUPPORTS_MACCATALYST`) on **both** the App and ShareExtension targets — the
extension only reaches the macOS share menu if both build for Catalyst. Xcode
derives the macOS deployment target from the iOS floor (26.0) automatically, so
there's nothing to toggle in the IDE. That leaves only:

1. **Signing & Capabilities** for each target: pick the same team you used for
   iOS. The extension's bundle id stays a child of the app's
   (`es.ricojam.onthebeach.ShareExtension`); a free personal team is fine for
   running locally on your own Mac.
2. Choose the **My Mac (Mac Catalyst)** run destination and **Run**. The shell
   opens as a Mac window showing the live site.

**Using it on macOS:** in Safari (or Finder, Notes, most apps) use the **Share**
button/menu and pick **On The Beach**. If it isn't listed, enable it under
**System Settings ▸ General ▸ Login Items & Extensions ▸ Sharing** (older macOS:
**System Settings ▸ Privacy & Security ▸ Extensions ▸ Sharing**) and tick **On
The Beach**. The compose form, note field, and List picker all work the same as
on iOS.

## Updating after web changes

There's nothing to rebuild for web-app changes — the shell loads the live site.
Rebuild/redeploy the app only when you change native code
(`native/ShareExtension/`), the Capacitor version, or `capacitor.config.ts` (run
`bun run cap:sync` after config changes).

## Security note

The ingest key is embedded in the app binary (same trade-off as the Shortcut,
which stores it in the Shortcut definition). That's acceptable for a personal /
single-user deployment. If you ever distribute the app more widely, move to a
per-device token or an OAuth-style flow instead of a shared static key, and
consider rotating `INGEST_API_KEY`.

## Troubleshooting

- **Extension doesn't appear in the share sheet** — make sure you shared a web
  URL or page (the activation rule in `Info.plist` targets web URLs, web pages,
  and text). Reboot the device once after first install; iOS caches extension
  registrations.
- **"Missing ingest API key in build config."** — `Secrets.xcconfig` isn't wired
  as the target's configuration file, or `OTB_INGEST_API_KEY` is empty.
- **401 Unauthorized** — the key in `Secrets.xcconfig` doesn't match the
  server's `INGEST_API_KEY`, or ingest is disabled (`INGEST_ENABLED=false`).
- **Add failed (4xx/5xx)** — the alert includes the server's response body;
  check the server logs for `POST /api/ingest/link`.
- **"ios platform already exists"** on `cap add` — a leftover `ios/` directory
  is present. It's fully generated and gitignored, so just `rm -rf ios` and run
  `bun run cap:add` again. (The hand-authored sources live in `native/`, not
  `ios/`, so removing `ios/` is always safe.)
- **(macOS) Extension not in the Mac share menu** — run the app once so macOS
  registers the extension, then enable it under **System Settings ▸ General ▸
  Login Items & Extensions ▸ Sharing**. If it still doesn't show, log out and
  back in (or `killall Finder`); macOS caches extension registrations like iOS
  does.
- **(macOS) Compose form looks or behaves oddly under Mac Catalyst** — the
  extension is a plain `UIViewController` (a `UINavigationController` hosting a note
  field and a List table), all standard UIKit that Mac Catalyst renders reliably.
  Still, treat macOS as "test on a real Mac" rather than guaranteed-identical to
  iOS. Because posting is synchronous, the form stays up until the request finishes
  and reports failures inline, so a wedged share hasn't silently posted — retry it.
  A fully native AppKit share extension would be marginally more Mac-idiomatic at
  the cost of a second, duplicated codebase; that trade-off wasn't worth it for a
  single-user deployment.
- **(macOS) Pods fail to build for Mac Catalyst** — set the **Pods** project's
  *Supported Destinations* (or its macOS deployment target) to include Mac
  Catalyst, then rebuild. Capacitor's WKWebView pod supports Catalyst; this only
  bites if a pod's own deployment settings exclude the Mac destination.
- **`Gem::FilePermissionError … /Library/Ruby/Gems/2.6.0` on `cap add`/`cap sync`**
  — before installing pods, Capacitor's `checkBundler` runs `bundle` and, if it
  returns a non-zero status (which the stock system Ruby's bundler does), tries
  `gem install bundler` into the read-only system gem dir and aborts. This is
  unrelated to Xcode and happens on a Mac with only the system Ruby. Fix it by
  giving Ruby a writable gem location — the simplest is a Homebrew Ruby
  (`brew install ruby` and put it ahead of `/usr/bin` on `PATH`) or a version
  manager (rbenv/rvm). CocoaPods installed via `brew install cocoapods` provides
  a working `pod`, so once the bundler check passes the actual install uses it
  (there is no `Gemfile` in this repo, so Capacitor calls plain `pod`, not
  `bundle exec pod`). As a one-off, you can also just run `cd ios/App && pod
  install` directly, which skips the bundler pre-flight entirely.

# Native iOS App & Share Extension

This is the "real" share-sheet integration: a native iOS app (a thin
[Capacitor](https://capacitorjs.com) shell around the hosted web app) plus a
native **Share Extension** so **On The Beach** appears in the iOS share sheet as
a first-class destination — no Shortcut required.

> **Why native?** iOS Safari does not implement the Web Share _Target_ API, so a
> PWA can never register as a share destination on iOS. The only ways a web app
> can appear in the share sheet are (a) a user-installed Shortcut
> (`docs/ios-shortcut.md`) or (b) a native app that ships a Share Extension —
> this document.

## How it works

- The Capacitor shell (`ios/App/`, generated on a mac) is a `WKWebView` pointed
  at the production URL via `capacitor.config.ts` (`server.url`). It's just a
  wrapper so there's a real app to host the extension; there is no separate
  mobile web bundle to maintain.
- The Share Extension (`ios/ShareExtension/`) is the part that matters. When the
  user shares a link, `ShareViewController.swift` extracts the URL and `POST`s it
  to `POST /api/ingest/link` with a `Bearer` token — the exact endpoint the
  documented Shortcut uses. The extension talks to the server directly, so a
  share works even when the app isn't running.

```
iOS share sheet ──► ShareExtension (Swift) ──► POST /api/ingest/link ──► item created
```

## What lives in the repo vs. what's generated

| Path                              | Source of truth | Committed? |
| --------------------------------- | --------------- | ---------- |
| `capacitor.config.ts`             | hand-authored   | yes        |
| `ios/ShareExtension/*.swift`      | hand-authored   | yes        |
| `ios/ShareExtension/Info.plist`   | hand-authored   | yes        |
| `ios/ShareExtension/Secrets.xcconfig` | you create locally | no (gitignored) |
| `ios/App/` (Xcode project, Pods)  | `npx cap add ios` | no (gitignored) |

The Xcode project is generated, not committed, so it's never stale relative to
the Capacitor version. Regenerate it any time with `npx cap add ios`.

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
npx cap add ios      # creates ios/App/ (gitignored)
bun run cap:sync     # cap sync ios — installs pods, applies config
bun run cap:open     # opens ios/App/App.xcworkspace in Xcode
```

### 2. Add the Share Extension target in Xcode

Xcode owns the `.xcodeproj`, so the extension target is added through the IDE
(this can't be scripted from Linux):

1. **File ▸ New ▸ Target… ▸ Share Extension.** Name it `ShareExtension`.
   Uncheck "Activate scheme" if prompted. Xcode creates a
   `ShareExtension/` group with its own `ShareViewController.swift`,
   `Info.plist`, and a `MainInterface.storyboard`.
2. **Delete** the auto-generated `ShareViewController.swift`,
   `Info.plist`, and `MainInterface.storyboard` that Xcode just made.
3. **Add** the repo's versions instead: drag
   `ios/ShareExtension/ShareViewController.swift` and
   `ios/ShareExtension/Info.plist` into the `ShareExtension` target (check
   "Copy items if needed" **off** — reference them in place so git stays the
   source of truth). Set the target's **Info.plist File** build setting to
   `ios/ShareExtension/Info.plist`.
   - The provided `Info.plist` has no `NSExtensionMainStoryboard` key (it uses
     `NSExtensionPrincipalClass` instead), so the storyboard isn't needed.
4. Set the extension target's **iOS Deployment Target** to 13.0 or higher.

### 3. Wire up the ingest API key

```bash
cp ios/ShareExtension/Secrets.example.xcconfig ios/ShareExtension/Secrets.xcconfig
# edit Secrets.xcconfig, set OTB_INGEST_API_KEY to match the server's INGEST_API_KEY
```

In Xcode, select the project ▸ **Info ▸ Configurations**, expand **Debug** and
**Release**, and set the **ShareExtension** target's configuration file to
`Secrets.xcconfig` for both. The key flows into the extension's `Info.plist`
through the `$(OTB_INGEST_API_KEY)` substitution and is read at runtime by
`ShareViewController`.

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
**On The Beach**. You should see a spinner, then "Added to On The Beach."

## Updating after web changes

There's nothing to rebuild for web-app changes — the shell loads the live site.
Rebuild/redeploy the app only when you change native code
(`ios/ShareExtension/`), the Capacitor version, or `capacitor.config.ts` (run
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

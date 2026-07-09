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
- The Share Extension (`native/ShareExtension/`) is the part that matters. When the
  user shares a link, `ShareViewController.swift` presents Apple's standard compose
  sheet (`SLComposeServiceViewController`) with an optional **note** field and a
  **List** row. The List row fetches your lists from `GET /api/ingest/stacks` and
  lets you pick an existing one or create a new one by name. On **Post** it `POST`s
  the URL — plus `notes` and `listName` when set — to `POST /api/ingest/link` with a
  `Bearer` token. The extension talks to the server directly, so a share works even
  when the app isn't running.
- Posting is **optimistic**: iOS dismisses the compose sheet as soon as you tap Post
  and keeps the extension alive just long enough to finish the request in the
  background, so a per-request server error isn't surfaced in the sheet (the
  tradeoff for using the native compose UI). The item either appears in the app or
  it doesn't; check the server logs for `POST /api/ingest/link` if one goes missing.

```
iOS share sheet ──► ShareExtension compose sheet ──► POST /api/ingest/link ──► item created
        (note + list picker)          GET /api/ingest/stacks ──┘  (filed into list)
```

## What lives in the repo vs. what's generated

| Path                              | Source of truth | Committed? |
| --------------------------------- | --------------- | ---------- |
| `capacitor.config.ts`             | hand-authored   | yes        |
| `native/ShareExtension/*.swift`      | hand-authored   | yes        |
| `native/ShareExtension/Info.plist`   | hand-authored   | yes        |
| `native/ShareExtension/Secrets.xcconfig` | you create locally | no (gitignored) |
| `ios/App/` (Xcode project, Pods)  | `bun run cap:add` | no (gitignored) |

The whole `ios/` directory is generated, not committed, so it's never stale
relative to the Capacitor version. Regenerate it any time by removing `ios/` and
running `bun run cap:add`.

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
bun run cap:sync     # cap sync ios — installs pods, applies config
bun run cap:open     # cap open ios — opens ios/App/App.xcworkspace in Xcode
```

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
   `native/ShareExtension/ShareViewController.swift` and
   `native/ShareExtension/Info.plist` into the `ShareExtension` target (check
   "Copy items if needed" **off** — reference them in place so git stays the
   source of truth). Set the target's **Info.plist File** build setting to
   `native/ShareExtension/Info.plist`.
   - The provided `Info.plist` has no `NSExtensionMainStoryboard` key (it uses
     `NSExtensionPrincipalClass` instead), so the storyboard isn't needed.
4. Set the extension target's **iOS Deployment Target** to 13.0 or higher.

### 3. Wire up the ingest API key

```bash
cp native/ShareExtension/Secrets.example.xcconfig native/ShareExtension/Secrets.xcconfig
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
**On The Beach**. You should see the compose sheet — type a note if you like, tap
**List** to file it into a list (existing or new), then tap **Post**.

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

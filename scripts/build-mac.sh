#!/usr/bin/env bash
# Build and launch the native Mac app locally — no Xcode UI, one command.
#
#   bun run mac
#
# On The Beach ships as a thin Capacitor shell (a WKWebView pointed at the live
# site) plus a native Share Extension. The whole `ios/` Xcode project is
# generated, not committed (see docs/ios-native-app.md), so this script does the
# full loop the way CI does — regenerate the project, inject the Share Extension —
# then goes one step further than CI: it *signs, builds, and launches* the Mac
# Catalyst app on this machine, so you can actually use it (and test the macOS
# share menu) without ever opening Xcode.
#
# What this needs that CI doesn't: your Apple signing identity. CI compiles with
# CODE_SIGNING_ALLOWED=NO (a build is enough to catch breakage); to *run* a
# Catalyst app macOS requires it signed. We sign automatically with your team
# (override with OTB_DEV_TEAM=... if it ever changes).

#
# Flags:
#   --install   After building, copy the .app into /Applications (or
#               ~/Applications if that isn't writable) and launch it from there,
#               so it's a permanent app you can open from Spotlight/Launchpad —
#               not one that only runs out of build/. Pair with
#               OTB_APP_URL=http://localhost:3000 (see `bun run mac:local`) to
#               install a shell around your *local* server. Note: because the app
#               is only a WKWebView shell, an installed localhost build shows
#               content only while that local server is running.

set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
source scripts/lib/native-build-common.sh

INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    *) echo "build-mac: unknown argument: $arg" >&2; exit 1 ;;
  esac
done

native_preflight
native_regenerate

# --- Build (signed, Mac Catalyst) ---------------------------------------------
# A *concrete* Mac Catalyst destination (not CI's generic one) produces a
# runnable .app. -allowProvisioningUpdates lets Xcode fetch/refresh the signing
# assets non-interactively.
log "Building Mac Catalyst app (signing with team $DEV_TEAM)"
xcodebuild \
  -workspace ios/App/App.xcworkspace \
  -scheme App \
  -configuration Debug \
  -destination 'platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath "$DERIVED" \
  DEVELOPMENT_TEAM="$DEV_TEAM" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates \
  build

# --- Launch -------------------------------------------------------------------
# Scope to the Catalyst product dir: build-ios.sh shares this DERIVED path, so a
# Debug-iphoneos build may also be present.
APP=$(find "$DERIVED/Build/Products/Debug-maccatalyst" -maxdepth 1 -name '*.app' -type d | head -1)
[[ -n "$APP" ]] || { echo "build-mac: no .app under $DERIVED/Build/Products/Debug-maccatalyst" >&2; exit 1; }

if [[ "$INSTALL" == 1 ]]; then
  # /Applications is admin-group writable on a typical Mac; fall back to the
  # per-user ~/Applications (also indexed by Spotlight/Launchpad) if it isn't,
  # so this never needs sudo. Install under the friendly product name — the
  # built wrapper is App.app (Capacitor's PRODUCT_NAME), but the bundle filename
  # is cosmetic and the menu-bar title comes from CFBundleName either way.
  dest_dir="/Applications"; [[ -w "$dest_dir" ]] || dest_dir="$HOME/Applications"
  mkdir -p "$dest_dir"
  APP_DEST="$dest_dir/On The Beach.app"
  rm -rf "$APP_DEST"
  cp -R "$APP" "$APP_DEST"
  log "Installed → $APP_DEST"
  APP="$APP_DEST"
fi

log "Launching $APP"
open "$APP"

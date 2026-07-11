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

set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
source scripts/lib/native-build-common.sh

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
log "Launching $APP"
open "$APP"

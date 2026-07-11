#!/usr/bin/env bash
# Build, install, and launch the native app on a connected iPhone — one command.
#
#   bun run ios
#
# The device-targeted sibling of build-mac.sh: same generated project + injected
# Share Extension, but built and *signed for a real device*, then pushed onto the
# connected iPhone and launched — so you can test the genuine on-device iOS share
# sheet without opening Xcode.
#
# Requires a paired iPhone that's connected, unlocked, and has Developer Mode on.
# We sign automatically with your team (override with OTB_DEV_TEAM=...);
# -allowProvisioningUpdates registers the device and mints profiles as needed.

set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
source scripts/lib/native-build-common.sh

# --- Find the connected device ------------------------------------------------
# `devicectl list devices` marks a reachable, paired device "available (…)";
# an "unavailable" one has no trailing par, so `available \(` matches only the
# usable ones. The UUID column is the CoreDevice identifier devicectl installs by.
device_line=$(xcrun devicectl list devices 2>/dev/null | grep -iE 'iphone|ipad' | grep -E 'available \(' | head -1 || true)
UDID=$(printf '%s' "$device_line" | grep -oE '[0-9A-Fa-f-]{36}' | head -1 || true)
if [[ -z "$UDID" ]]; then
  echo "build-ios: no connected iPhone found." >&2
  echo "  Connect + unlock your iPhone (Developer Mode on), then rerun. Current devices:" >&2
  xcrun devicectl list devices >&2 || true
  exit 1
fi
DEVICE_NAME=$(printf '%s' "$device_line" | awk -F'   +' '{print $NF}')
log "Target device: ${DEVICE_NAME:-$UDID} ($UDID)"

native_preflight
native_regenerate

# --- Build (signed for the device) --------------------------------------------
log "Building for device (signing with team $DEV_TEAM)"
xcodebuild \
  -workspace ios/App/App.xcworkspace \
  -scheme App \
  -configuration Debug \
  -destination "id=$UDID" \
  -derivedDataPath "$DERIVED" \
  DEVELOPMENT_TEAM="$DEV_TEAM" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates \
  build

# --- Install + launch ---------------------------------------------------------
APP=$(find "$DERIVED/Build/Products/Debug-iphoneos" -maxdepth 1 -name '*.app' -type d | head -1)
[[ -n "$APP" ]] || { echo "build-ios: no device .app under $DERIVED/Build/Products/Debug-iphoneos" >&2; exit 1; }
BUNDLE_ID=$(plutil -extract CFBundleIdentifier raw "$APP/Info.plist")

log "Installing $APP"
xcrun devicectl device install app --device "$UDID" "$APP"
log "Launching $BUNDLE_ID"
xcrun devicectl device process launch --terminate-existing --device "$UDID" "$BUNDLE_ID"

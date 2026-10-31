#!/usr/bin/env bash
# Archive the native app for TestFlight (internal testing) — one command.
#
#   bun run ios:archive                # produce the signed .ipa
#   bun run ios:archive -- --upload    # then push it to TestFlight via altool
#
# The TestFlight sibling of build-ios.sh: same generated project + injected
# Share Extension and Widget, but archived for distribution (Release, generic
# iOS device destination, signed with the team's distribution identity) instead
# of a Debug build installed onto a connected phone.
#
# A signed .ipa is final: same commit, same build number, same bytes. When one
# already exists in build/ios-archives/upload/ the archive + export steps are
# skipped and the file is reused — delete that directory to rebuild. This also
# routes around the flakiest step: export rides on the Xcode account session,
# which on this machine expires within minutes ("No Accounts" errors), while
# uploading needs no session at all.
#
# Versioning: the generated project pins MARKETING_VERSION=1.0 and
# CURRENT_PROJECT_VERSION=1 (Capacitor never copies package.json's version
# across), so both are stamped here — marketing version from package.json,
# build number from the git commit count. TestFlight rejects a version+build
# pair it already has, so when re-uploading from the same commit pass
# OTB_BUILD_NUMBER=<higher number>. The xcodebuild override applies to every
# target, which is exactly what the app-extension rule wants ("CFBundleVersion
# of an app extension must match its containing parent app").
#
# One-time setup (details in docs/ios-native-app.md ▸ TestFlight):
#   - a paid Apple Developer Program membership on team $DEV_TEAM
#   - the app record created in App Store Connect (es.ricojam.onthebeach)
#   - Xcode ▸ Settings ▸ Accounts signed in with that Apple ID. The
#     distribution export mints the App Store provisioning profiles and the
#     (cloud-managed) iOS Distribution certificate through that session —
#     without it the export fails with "No Accounts". Click the account in
#     Xcode's Accounts pane first if the session has gone stale.
# -allowProvisioningUpdates registers the extensions' App IDs and mints their
# profiles at export time.
#
# Upload credentials (altool has no notion of Xcode's session):
#   OTB_APPLE_ID + OTB_APP_SPECIFIC_PASSWORD (an app-specific password from
#     appleid.apple.com — Sign-In and Security ▸ App-Specific Passwords), or
#   OTB_API_KEY + OTB_API_ISSUER (an App Store Connect API team key; the .p8
#     must live in ./private_keys, ~/private_keys or ~/.appstoreconnect)
# With neither, the script stops after exporting and points at the ready .ipa —
# dragging it onto Apple's free Transporter app is the credential-free route.
# When OTB_API_KEY/OTB_API_ISSUER are set, the key also authenticates
# -allowProvisioningUpdates for signing (headless CI has no Xcode session).

set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
source scripts/lib/native-build-common.sh

UPLOAD=false
case "${1:-}" in
  "") ;;
  --upload) UPLOAD=true ;;
  *) echo "usage: $(basename "$0") [--upload]" >&2; exit 1 ;;
esac

# --- App Store Connect API key (optional signing auth) -------------------------
# -allowProvisioningUpdates authenticates against App Store Connect. Locally that
# rides on the Xcode account session; on a headless runner there is no session, so
# when the upload API-key env vars are set, pass the same key to xcodebuild
# (-authenticationKeyPath/-ID/-IssuerID) and signing works there too. The .p8 is
# looked up in the same three directories altool searches (see the header), so one
# key file serves both signing and upload; OTB_API_KEY_PATH overrides. With the
# env vars unset — the plain local flow — nothing changes.
#
# The expansion guard `${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}` is the macOS-bash-3.2
# safe form: plain "${AUTH_ARGS[@]}" on an empty array is an "unbound variable"
# error under set -u there.
AUTH_ARGS=()
if [[ -n "${OTB_API_KEY:-}" && -n "${OTB_API_ISSUER:-}" ]]; then
  KEY_PATH="${OTB_API_KEY_PATH:-}"
  if [[ -z "$KEY_PATH" ]]; then
    for candidate in "./private_keys/AuthKey_${OTB_API_KEY}.p8" \
                     "$HOME/private_keys/AuthKey_${OTB_API_KEY}.p8" \
                     "$HOME/.appstoreconnect/AuthKey_${OTB_API_KEY}.p8"; do
      if [[ -f "$candidate" ]]; then KEY_PATH="$candidate"; break; fi
    done
  fi
  if [[ -n "$KEY_PATH" && -f "$KEY_PATH" ]]; then
    AUTH_ARGS=(-authenticationKeyPath "$KEY_PATH"
               -authenticationKeyID "$OTB_API_KEY"
               -authenticationKeyIssuerID "$OTB_API_ISSUER")
    log "Signing via App Store Connect API key ($KEY_PATH)"
  else
    echo "archive-ios: OTB_API_KEY set but AuthKey_${OTB_API_KEY}.p8 not found in" >&2
    echo "  ./private_keys, ~/private_keys or ~/.appstoreconnect — signing falls back to" >&2
    echo "  the Xcode session (upload still needs the key file)." >&2
  fi
fi

APP_VERSION=$(bun -e 'console.log(require("./package.json").version)')
BUILD_NUMBER="${OTB_BUILD_NUMBER:-$(git rev-list --count HEAD)}"
ARCHIVE_DIR="build/ios-archives"
ARCHIVE="$ARCHIVE_DIR/OnTheBeach-$APP_VERSION-$BUILD_NUMBER.xcarchive"
IPA_DIR="$ARCHIVE_DIR/upload"

# `|| true` so a missing IPA_DIR is just "no ipa" — pipefail would otherwise
# make find's non-zero exit kill the script under set -e.
find_ipa() { find "$IPA_DIR" -maxdepth 1 -name '*.ipa' -type f 2>/dev/null | head -1 || true; }

IPA=$(find_ipa)
if [[ -z "$IPA" ]]; then
  native_preflight
  native_regenerate

  mkdir -p "$ARCHIVE_DIR"
  rm -rf "$ARCHIVE"

  log "Archiving $APP_VERSION (build $BUILD_NUMBER) for distribution"
  xcodebuild archive \
    -workspace ios/App/App.xcworkspace \
    -scheme App \
    -configuration Release \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE" \
    -derivedDataPath "$DERIVED" \
    DEVELOPMENT_TEAM="$DEV_TEAM" \
    CODE_SIGN_STYLE=Automatic \
    MARKETING_VERSION="$APP_VERSION" \
    CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
    -allowProvisioningUpdates \
    ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}

  # --- Export the signed .ipa --------------------------------------------------
  # Xcode 27 removed destination=upload from -exportArchive (the key now only
  # accepts "export"), so exporting produces the signed .ipa and uploading is
  # altool's job below. method=release-testing is TestFlight-only: the build
  # can never be submitted to the App Store, which is the point for an
  # internal-testing distribution. (app-store-connect also works but hunts for
  # classic App Store profiles; release-testing is the one Xcode 27 provisions
  # end-to-end for this team.) Automatic signing + -allowProvisioningUpdates
  # re-signs with the distribution identity, minting it on first use.
  log "Exporting signed .ipa"
  OPTIONS="$ARCHIVE_DIR/exportOptions-$APP_VERSION-$BUILD_NUMBER.plist"
  cat > "$OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>release-testing</string>
  <key>destination</key>
  <string>export</string>
  <key>teamID</key>
  <string>$DEV_TEAM</string>
  <key>signingStyle</key>
  <string>automatic</string>
</dict>
</plist>
PLIST

  xcodebuild -exportArchive \
    -archivePath "$ARCHIVE" \
    -exportOptionsPlist "$OPTIONS" \
    -exportPath "$IPA_DIR" \
    -allowProvisioningUpdates \
    ${AUTH_ARGS[@]+"${AUTH_ARGS[@]}"}

  IPA=$(find_ipa)
  [[ -n "$IPA" ]] || { echo "archive-ios: export produced no .ipa under $IPA_DIR" >&2; exit 1; }
else
  log "Reusing already-signed $IPA"
  echo "  (delete $IPA_DIR to archive + export fresh)"
fi

if [[ "$UPLOAD" == false ]]; then
  log "Signed .ipa ready: $IPA"
  echo "  Upload with: bun run ios:archive -- --upload"
  echo "  (or drag it onto Apple's Transporter app and click Deliver)"
  exit 0
fi

# --- Upload to TestFlight ------------------------------------------------------
if [[ -n "${OTB_APPLE_ID:-}" && -n "${OTB_APP_SPECIFIC_PASSWORD:-}" ]]; then
  log "Uploading to App Store Connect (TestFlight) as ${OTB_APPLE_ID}"
  xcrun altool --upload-app -f "$IPA" \
    -u "$OTB_APPLE_ID" -p "@env:OTB_APP_SPECIFIC_PASSWORD"
elif [[ -n "${OTB_API_KEY:-}" && -n "${OTB_API_ISSUER:-}" ]]; then
  log "Uploading to App Store Connect (TestFlight) via API key"
  xcrun altool --upload-app -f "$IPA" \
    --api-key "$OTB_API_KEY" --api-issuer "$OTB_API_ISSUER"
else
  log "Signed .ipa ready: $IPA"
  echo "  No upload credentials in the environment. Upload it with either:"
  echo "    OTB_APPLE_ID='you@example.com' OTB_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx' \\"
  echo "      bun run ios:archive -- --upload"
  echo "    (or drag $IPA onto Apple's Transporter app and click Deliver)"
  exit 0
fi

log "Uploaded. The build appears in App Store Connect ▸ TestFlight in ~10-15 min"
echo "  once it finishes processing; then it's installable by internal testers."

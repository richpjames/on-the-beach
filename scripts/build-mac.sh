#!/usr/bin/env bash
# Build and launch the native Mac app locally — no Xcode UI, one command.
#
#   bun run mac
#
# On The Beach ships as a thin Capacitor shell (a WKWebView pointed at the live
# site) plus a native Share Extension. The whole `ios/` Xcode project is
# generated, not committed (see docs/ios-native-app.md), so this script does the
# full loop the way CI does — regenerate the project from scratch, inject the
# Share Extension target — then goes one step further than CI: it *signs, builds,
# and launches* the Mac Catalyst app on this machine, so you can actually use it
# (and test the macOS share menu) without ever opening Xcode.
#
# Regeneration is cheap here: the Podfile has only two *local* pods (Capacitor +
# CapacitorCordova, both `:path` into node_modules), so `pod install` does no
# network work. That's why we always regenerate rather than trying to detect a
# stale project — it can never drift, and it costs seconds. The real cost is the
# xcodebuild *compile*, which we keep fast by pinning -derivedDataPath to a fixed
# location so Xcode's incremental compile cache survives across runs.
#
# What this needs that CI doesn't: your Apple signing identity. CI compiles with
# CODE_SIGNING_ALLOWED=NO (a build is enough to catch breakage); to *run* a
# Catalyst app macOS requires it signed. We sign automatically with your team
# (override with OTB_DEV_TEAM=... if it ever changes).

set -euo pipefail

# Run from the repo root regardless of where the script was invoked from, so all
# the relative paths below (native/, ios/, build/) resolve.
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

# Your Apple Developer Team ID, used for automatic signing. Overridable via env
# so the script isn't the source of truth for a value that can change.
DEV_TEAM="${OTB_DEV_TEAM:-W2BS7F6CHM}"

# Fixed derived-data path: keeps Xcode's compile cache between runs even though
# we blow away and regenerate ios/ each time (derived data is keyed by project
# location, so a fresh project at the same path still hits the cache).
DERIVED="build/ios"

log() { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }

# --- 1. Preflight -------------------------------------------------------------
# The Share Extension substitutes OTB_INGEST_API_KEY (from the gitignored
# Secrets.xcconfig) into its Info.plist at build time. Precedence: keep a real
# key you've already set up, otherwise lift it from .env, otherwise fall back to
# a placeholder so the app still compiles and launches (shares just won't post).
SECRETS="native/ShareExtension/Secrets.xcconfig"
if [[ -f "$SECRETS" ]]; then
  log "Using existing $SECRETS"
elif key=$(grep -E '^OTB_INGEST_API_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2-) && [[ -n "${key:-}" ]]; then
  printf 'OTB_INGEST_API_KEY = %s\n' "$key" > "$SECRETS"
  log "Wrote $SECRETS from .env"
else
  printf 'OTB_INGEST_API_KEY = placeholder-key\n' > "$SECRETS"
  log "No key found — wrote placeholder $SECRETS (shares won't post until you set a real key)"
fi

# `cap sync` copies webDir (build/client) into the app and fails if it's absent.
# server.url serves the live site, so the copied bundle is never used — a
# placeholder satisfies the check without a full `bun run build`. Leave a real
# build in place if one already exists.
if [[ ! -f build/client/index.html ]]; then
  mkdir -p build/client
  printf '<!doctype html><title>On The Beach</title>' > build/client/index.html
fi

# --- 2. Regenerate the iOS project --------------------------------------------
# `cap add` runs a CocoaPods "checkBundler" pre-flight that, under macOS's
# read-only system Ruby (/usr/bin/ruby 2.6), tries to gem-install bundler into a
# read-only dir and aborts with Gem::FilePermissionError (see the troubleshooting
# section of docs/ios-native-app.md). Put a writable Homebrew Ruby ahead of the
# system one on PATH so gem/bundle/pod — and the xcodeproj gem that
# add-share-extension.rb needs — all resolve to a writable toolchain.
if [[ "$(command -v ruby)" == "/usr/bin/ruby" ]]; then
  brew_ruby="$(brew --prefix ruby 2>/dev/null)/bin"
  if [[ -x "$brew_ruby/ruby" ]]; then
    export PATH="$brew_ruby:$PATH"
    log "Using Homebrew Ruby for project generation ($brew_ruby)"
  else
    echo "build-mac: active Ruby is the read-only system Ruby and no Homebrew Ruby found." >&2
    echo "  Fix: brew install ruby  (see docs/ios-native-app.md troubleshooting)" >&2
    exit 1
  fi
fi

log "Regenerating ios/ project"
rm -rf ios
bun run cap:add
ruby scripts/add-share-extension.rb

# --- 3. Build (signed, Mac Catalyst) ------------------------------------------
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

# --- 4. Launch ----------------------------------------------------------------
APP=$(find "$DERIVED/Build/Products" -maxdepth 2 -name '*.app' -type d | head -1)
[[ -n "$APP" ]] || { echo "build-mac: no .app found under $DERIVED/Build/Products" >&2; exit 1; }
log "Launching $APP"
open "$APP"

# shellcheck shell=bash
# Shared setup for the local native-app build scripts (build-mac.sh, build-ios.sh).
#
# Both scripts do the same first half — make the Share Extension key + web
# placeholder available, sidestep the system-Ruby CocoaPods failure, and
# regenerate the (gitignored, generated) ios/ project from scratch — then differ
# only in how they build, install, and launch. That common half lives here so it
# can't drift between the two.
#
# Source this AFTER `set -euo pipefail` and after cd'ing to the repo root, then
# call `native_preflight` and `native_regenerate` before your platform-specific
# xcodebuild.

# Your Apple Developer Team ID, used for automatic signing. Overridable via env
# so no script is the source of truth for a value that can change.
DEV_TEAM="${OTB_DEV_TEAM:-W2BS7F6CHM}"

# Fixed derived-data path: keeps Xcode's compile cache between runs even though
# we blow away and regenerate ios/ each time (derived data is keyed by project
# location, so a fresh project at the same path still hits the cache).
DERIVED="build/ios"

log() { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }

# --- Preflight ----------------------------------------------------------------
# The Share Extension substitutes OTB_INGEST_API_KEY (from the gitignored
# Secrets.xcconfig) into its Info.plist at build time. Precedence: keep a real
# key you've already set up, otherwise lift it from .env, otherwise fall back to
# a placeholder so the app still compiles and launches (shares just won't post).
native_preflight() {
  local secrets="native/ShareExtension/Secrets.xcconfig" key
  if [[ -f "$secrets" ]]; then
    log "Using existing $secrets"
  elif key=$(grep -E '^OTB_INGEST_API_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2-) && [[ -n "${key:-}" ]]; then
    printf 'OTB_INGEST_API_KEY = %s\n' "$key" > "$secrets"
    log "Wrote $secrets from .env"
  else
    printf 'OTB_INGEST_API_KEY = placeholder-key\n' > "$secrets"
    log "No key found — wrote placeholder $secrets (shares won't post until you set a real key)"
  fi

  # `cap sync` copies webDir (build/client) into the app and fails if it's
  # absent. server.url serves the live site, so the copied bundle is never used —
  # a placeholder satisfies the check without a full `bun run build`. Leave a real
  # build in place if one already exists.
  if [[ ! -f build/client/index.html ]]; then
    mkdir -p build/client
    printf '<!doctype html><title>On The Beach</title>' > build/client/index.html
  fi
}

# --- Regenerate the iOS project -----------------------------------------------
# Regeneration is cheap here (the Podfile has only two *local* pods, so
# `pod install` does no network work), so we always regenerate rather than try to
# detect a stale project — it can never drift and costs seconds.
native_regenerate() {
  # `cap add` runs a CocoaPods "checkBundler" pre-flight that, under macOS's
  # read-only system Ruby (/usr/bin/ruby 2.6), tries to gem-install bundler into a
  # read-only dir and aborts with Gem::FilePermissionError (see the troubleshooting
  # section of docs/ios-native-app.md). Put a writable Homebrew Ruby ahead of the
  # system one on PATH so gem/bundle/pod — and the xcodeproj gem that
  # add-share-extension.rb needs — all resolve to a writable toolchain.
  if [[ "$(command -v ruby)" == "/usr/bin/ruby" ]]; then
    local brew_ruby
    brew_ruby="$(brew --prefix ruby 2>/dev/null)/bin"
    if [[ -x "$brew_ruby/ruby" ]]; then
      export PATH="$brew_ruby:$PATH"
      log "Using Homebrew Ruby for project generation ($brew_ruby)"
    else
      echo "native-build: active Ruby is the read-only system Ruby and no Homebrew Ruby found." >&2
      echo "  Fix: brew install ruby  (see docs/ios-native-app.md troubleshooting)" >&2
      exit 1
    fi
  fi

  log "Regenerating ios/ project"
  rm -rf ios
  bun run cap:add
  native_restore_app_icon
  ruby scripts/add-share-extension.rb
}

# --- Restore the committed app icon ------------------------------------------
# `cap add` regenerates AppIcon.appiconset with Capacitor's placeholder icon
# (and only the iOS `universal` idiom — no Mac Catalyst `mac` idiom, so Catalyst
# falls back to a generic placeholder). Copy our committed set — the capybara,
# same source as the web favicon, incl. every `mac` rendition — over it so every
# build is branded without a separate `bun run brand:assets` step. This is the
# icon analogue of how the Share Extension is injected after cap add.
#
# Source of truth is native/AppIcon.appiconset; regenerate it via
# `bun run brand:assets` whenever assets/logo.png changes, then commit.
native_restore_app_icon() {
  local committed="native/AppIcon.appiconset"
  local project="ios/App/App/Assets.xcassets/AppIcon.appiconset"
  if [[ -d "$committed" ]]; then
    rm -rf "$project"
    cp -R "$committed" "$project"
    log "Restored app icon from $committed"
  else
    log "No committed app icon at $committed — run 'bun run brand:assets'; using Capacitor default"
  fi
}

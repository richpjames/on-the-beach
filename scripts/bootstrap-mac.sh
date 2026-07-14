#!/usr/bin/env bash
# One-time setup for building the native Mac app on a fresh Mac — one command.
#
#   bun run mac:bootstrap    (or: bash scripts/bootstrap-mac.sh)
#
# `bun run mac` / `mac:install` can build, sign, and launch the Catalyst app
# without ever opening Xcode — but only once the toolchain it shells out to is in
# place. That toolchain (Xcode, Bun, CocoaPods, a writable Ruby, ImageMagick) and
# a signing identity are exactly the friction when you move to a *second* Mac.
# This script installs and verifies all of it, so a new machine goes from a bare
# checkout to a runnable share-sheet build in two commands:
#
#   bash scripts/bootstrap-mac.sh   # this — installs + verifies prerequisites
#   bun run mac:install             # build → sign → /Applications → launch
#
# It's idempotent: every step checks first and only acts on what's missing, so
# re-running it is a safe way to diagnose a half-set-up machine. It never uses
# sudo silently — anything needing elevation (Xcode license, the Xcode path) is
# printed as an instruction, not run for you.
#
# See docs/ios-native-app.md for the why behind each prerequisite.

set -euo pipefail
cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

# Reuse the same team default and logger shape as the build scripts so output
# reads consistently across the native tooling.
DEV_TEAM="${OTB_DEV_TEAM:-W2BS7F6CHM}"
log()  { printf '\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; }

# Track soft failures (things we can't fix for the user, like a full-Xcode or
# Apple-ID install) so we can exit non-zero with a single summary at the end
# rather than aborting on the first one — the user should see the whole list.
BLOCKERS=()

[[ "$(uname)" == "Darwin" ]] || { fail "This script only runs on macOS."; exit 1; }

# --- Homebrew -----------------------------------------------------------------
# Everything below installs through Homebrew, so it comes first. We don't attempt
# the interactive Homebrew installer here (it wants its own confirmation and sudo
# flow); if it's absent we point at the one-liner and stop, since nothing else
# can proceed without it.
if ! command -v brew >/dev/null 2>&1; then
  fail "Homebrew not found — install it first, then re-run this script:"
  echo '    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' >&2
  exit 1
fi
ok "Homebrew present"

# --- Homebrew formulae --------------------------------------------------------
# command -v is the truth for "is it usable", not `brew list` — a formula can be
# installed but shadowed, and the build scripts call these by name on PATH.
#   bun         — the project runtime / task runner
#   cocoapods   — `pod install` during cap add (two local pods, no network)
#   ruby        — a *writable* Ruby; native_regenerate refuses system Ruby 2.6
#   imagemagick — `magick`, needed by brand:assets for the app icon + splash
install_formula() {
  local cmd="$1" formula="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd present"
  else
    log "Installing $formula"
    brew install "$formula"
    ok "$cmd installed"
  fi
}

install_formula bun    oven-sh/bun/bun
install_formula pod    cocoapods
install_formula magick imagemagick

# Ruby is special. The system Ruby at /usr/bin/ruby satisfies `command -v ruby`
# but is the exact read-only 2.6 the build refuses, and Homebrew's ruby is
# keg-only (not linked, to avoid clobbering system Ruby) — so `command -v ruby`
# stays /usr/bin/ruby even once it's installed. Check for the *keg* directly,
# which is precisely what native_regenerate resolves against.
brew_ruby="$(brew --prefix ruby 2>/dev/null)/bin/ruby"
if [[ -x "$brew_ruby" ]]; then
  ok "Homebrew ruby present ($brew_ruby)"
else
  log "Installing ruby (system Ruby is read-only and rejected by the build)"
  brew install ruby
  ok "ruby installed — the build resolves it via \`brew --prefix ruby\`, no linking needed"
fi

# --- Xcode --------------------------------------------------------------------
# A Catalyst app has to be *compiled*, so the full Xcode is non-negotiable — the
# Command Line Tools alone can't build it. Xcode ships only through the App Store,
# which we can't script, so here we can only detect and instruct.
if xcodebuild -version >/dev/null 2>&1; then
  ok "Xcode present ($(xcodebuild -version | head -1))"
else
  fail "Full Xcode not found (Command Line Tools alone can't build a Catalyst app)."
  echo "    1. Install Xcode from the App Store." >&2
  echo "    2. Point the toolchain at it: sudo xcode-select -s /Applications/Xcode.app" >&2
  echo "    3. Accept the license:        sudo xcodebuild -license accept" >&2
  BLOCKERS+=("Install full Xcode and select it with xcode-select")
fi

# --- Signing identity ---------------------------------------------------------
# `mac:install` signs automatically, but only with a *valid* "Apple Development"
# identity — one whose whole chain validates: leaf cert → Apple WWDR intermediate
# → Apple root. `find-identity -v` lists only valid ones; the same call without
# -v also lists identities whose chain is broken. Splitting those two apart lets
# us name which of three very different states we're in and give advice that fits
# it, instead of always saying "add your Apple ID" — useless once it already is:
#   valid              → nothing to do.
#   present but broken → the leaf and its private key exist, but an intermediate
#                        is missing or expired. The classic trap on a second Mac:
#                        only the WWDR G1 that expired in 2023 is installed, while
#                        any cert minted since is issued by G3+. No Xcode needed —
#                        importing the current intermediate repairs it.
#   absent             → no cert at all; only Xcode can mint one.
codesign_valid()   { security find-identity -v -p codesigning 2>/dev/null | grep -q "Apple Development"; }
codesign_present() { security find-identity    -p codesigning 2>/dev/null | grep -q "Apple Development"; }

if codesign_valid; then
  ok "Apple Development signing identity present and valid"
elif codesign_present; then
  warn "An 'Apple Development' cert exists but its chain won't validate — a missing or expired Apple WWDR intermediate."
  # The leaf names the intermediate generation it needs in its issuer OU (e.g.
  # G3), so fetch exactly that one from Apple's certificate authority and import
  # it into the login keychain — the same official cert Xcode would install, and
  # no sudo. Fall back to G3 (today's default) if the OU can't be read.
  leaf_ou="$(security find-certificate -c "Apple Development" -p 2>/dev/null \
             | openssl x509 -noout -issuer 2>/dev/null \
             | grep -oE 'OU=G[0-9]+' | head -1 | cut -d= -f2 || true)"
  wwdr="AppleWWDRCA${leaf_ou:-G3}"
  log "Installing Apple WWDR intermediate ($wwdr)"
  tmp_dir="$(mktemp -d)"
  if curl -fsSL -o "$tmp_dir/$wwdr.cer" "https://www.apple.com/certificateauthority/$wwdr.cer"; then
    security import "$tmp_dir/$wwdr.cer" -k "$HOME/Library/Keychains/login.keychain-db" >/dev/null 2>&1 || true
    if codesign_valid; then
      ok "WWDR intermediate installed — signing identity now valid"
    else
      fail "Imported $wwdr but the identity still won't validate."
      echo "    Check https://www.apple.com/certificateauthority/ for the intermediate your cert needs." >&2
      BLOCKERS+=("Repair the Apple Development certificate chain (see Apple's certificate authority page)")
    fi
  else
    fail "Couldn't download the WWDR intermediate ($wwdr)."
    echo "    Download it from https://www.apple.com/certificateauthority/ and double-click to install." >&2
    BLOCKERS+=("Install the current Apple WWDR intermediate certificate")
  fi
  rm -rf "$tmp_dir"
else
  fail "No 'Apple Development' signing certificate found."
  echo "    In Xcode ▸ Settings ▸ Accounts, add the Apple ID for team $DEV_TEAM if it isn't already," >&2
  echo "    then select the team ▸ Manage Certificates… ▸ + ▸ Apple Development to create one." >&2
  BLOCKERS+=("Create an Apple Development certificate in Xcode ▸ Settings ▸ Accounts ▸ Manage Certificates")
fi

# --- Ingest key (soft) --------------------------------------------------------
# Not required to *build* — the build falls back to a placeholder — but without a
# real key the share sheet posts to nowhere, which is the whole point on a second
# machine. Warn, don't block.
if grep -q '^OTB_INGEST_API_KEY=' .env 2>/dev/null; then
  ok "OTB_INGEST_API_KEY found in .env"
else
  warn "No OTB_INGEST_API_KEY in .env — the app will build, but shares won't post."
  warn "  Copy a .env with a real key from your other machine before mac:install."
fi

# --- Summary ------------------------------------------------------------------
echo
if (( ${#BLOCKERS[@]} == 0 )); then
  ok "All build prerequisites satisfied. Next:  bun install && bun run mac:install"
else
  fail "Setup incomplete — resolve these, then re-run this script:"
  for b in "${BLOCKERS[@]}"; do echo "    • $b" >&2; done
  exit 1
fi

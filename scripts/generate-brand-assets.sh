#!/usr/bin/env bash
#
# Regenerate ALL brand imagery from a SINGLE source image.
#
#   Source of truth:  assets/logo.png   (the capybara, a transparent square PNG)
#
# From that one file this produces:
#   - Web favicons in public/  (favicon.ico / -16 / -32, apple-touch, android-chrome)
#       kept transparent, so the mascot sits on any page background.
#   - Native iOS + Mac Catalyst app icon and splash, composited on white
#       (iOS app icons must be fully opaque).
#
# To rebrand, replace assets/logo.png with a higher-res transparent square and
# re-run this script. Ideally the source is >= 1024x1024.
#
# Requires: ImageMagick (`magick`) and @capacitor/assets (a devDependency).
#
# NOTE: @capacitor/assets rewrites AppIcon.appiconset/Contents.json on every run
# and only emits the iOS "universal" icon -- it drops the Mac Catalyst `mac`
# idiom. Without that idiom, Catalyst shows a generic placeholder icon. So we
# regenerate the mac renditions from the produced icon and rewrite Contents.json
# to include them.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="assets/logo.png"
ICONSET="ios/App/App/Assets.xcassets/AppIcon.appiconset"
PUBLIC="public"
BG="#ffffff"

command -v magick >/dev/null || { echo "error: ImageMagick (magick) is required" >&2; exit 1; }
[ -f "$SRC" ] || { echo "error: missing source image $SRC" >&2; exit 1; }

echo "==> Native iOS icon + splash (via @capacitor/assets; logo composited on $BG)"
npx capacitor-assets generate --ios \
  --iconBackgroundColor "$BG"   --iconBackgroundColorDark "$BG" \
  --splashBackgroundColor "$BG" --splashBackgroundColorDark "$BG"

echo "==> Mac Catalyst idiom (@capacitor/assets omits it; rebuild from produced icon)"
MASTER="$ICONSET/AppIcon-512@2x.png"
for pair in 16:16 16@2x:32 32:32 32@2x:64 128:128 128@2x:256 256:256 256@2x:512 512:512 512@2x:1024; do
  name="${pair%%:*}"; px="${pair##*:}"
  magick "$MASTER" -filter Lanczos -resize "${px}x${px}" "$ICONSET/AppIcon-mac-${name}.png"
done

echo "==> Rewrite AppIcon Contents.json with iOS universal + mac idiom"
cat > "$ICONSET/Contents.json" <<'JSON'
{
  "images": [
    { "idiom": "universal", "size": "1024x1024", "filename": "AppIcon-512@2x.png", "platform": "ios" },
    { "filename": "AppIcon-mac-16.png",     "idiom": "mac", "scale": "1x", "size": "16x16" },
    { "filename": "AppIcon-mac-16@2x.png",  "idiom": "mac", "scale": "2x", "size": "16x16" },
    { "filename": "AppIcon-mac-32.png",     "idiom": "mac", "scale": "1x", "size": "32x32" },
    { "filename": "AppIcon-mac-32@2x.png",  "idiom": "mac", "scale": "2x", "size": "32x32" },
    { "filename": "AppIcon-mac-128.png",    "idiom": "mac", "scale": "1x", "size": "128x128" },
    { "filename": "AppIcon-mac-128@2x.png", "idiom": "mac", "scale": "2x", "size": "128x128" },
    { "filename": "AppIcon-mac-256.png",    "idiom": "mac", "scale": "1x", "size": "256x256" },
    { "filename": "AppIcon-mac-256@2x.png", "idiom": "mac", "scale": "2x", "size": "256x256" },
    { "filename": "AppIcon-mac-512.png",    "idiom": "mac", "scale": "1x", "size": "512x512" },
    { "filename": "AppIcon-mac-512@2x.png", "idiom": "mac", "scale": "2x", "size": "512x512" }
  ],
  "info": { "author": "xcode", "version": 1 }
}
JSON

echo "==> Web favicons (transparent), matching the filenames the app references"
magick "$SRC" -resize 16x16   "$PUBLIC/favicon-16x16.png"
magick "$SRC" -resize 32x32   "$PUBLIC/favicon-32x32.png"
magick "$SRC" -resize 180x180 "$PUBLIC/apple-touch-icon.png"
magick "$SRC" -resize 192x192 "$PUBLIC/android-chrome-192x192.png"
magick "$SRC" -resize 512x512 "$PUBLIC/android-chrome-512x512.png"
magick "$SRC" -define icon:auto-resize=16,32,48 "$PUBLIC/favicon.ico"

echo "==> Done. Next: 'npx cap sync ios' to copy web assets into the native project."

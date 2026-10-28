#!/bin/bash
# Builds B5 Code.app (the native window) into ~/Applications.
# Needs only the Command Line Tools' swiftc. Run again after changing mac/.
set -euo pipefail

B5_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$HOME/Applications/B5 Code.app}"
VERSION="$(node -p "require('$B5_DIR/package.json').version")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/B5Code.app/Contents/MacOS" "$TMP/B5Code.app/Contents/Resources"
swiftc -O -target x86_64-apple-macos12.0 \
  -framework Cocoa -framework WebKit -framework UserNotifications -framework Speech -framework AVFoundation \
  "$B5_DIR/mac/main.swift" -o "$TMP/B5Code.app/Contents/MacOS/B5Code"
cp "$B5_DIR/mac/B5Code.icns" "$TMP/B5Code.app/Contents/Resources/B5Code.icns"

cat > "$TMP/B5Code.app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>B5 Code</string>
  <key>CFBundleDisplayName</key><string>B5 Code</string>
  <key>CFBundleIdentifier</key><string>local.b5code.app</string>
  <key>CFBundleExecutable</key><string>B5Code</string>
  <key>CFBundleIconFile</key><string>B5Code</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key><string>B5 Code listens while you dictate a message.</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>B5 Code turns your speech into the message you are writing.</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>DeskDir</key><string>$B5_DIR</string>
  <key>DeskPort</key><string>${B5_PORT:-4317}</string>
</dict>
</plist>
PLIST

# Ad-hoc signed: enough for this Mac to run it and show its notifications.
codesign --force --sign - "$TMP/B5Code.app" >/dev/null

rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
mv "$TMP/B5Code.app" "$OUT"
touch "$OUT"
echo "Built $OUT"

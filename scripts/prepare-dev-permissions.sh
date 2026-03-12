#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_APP="$ROOT_DIR/node_modules/electron/dist/Electron.app"
PLIST_PATH="$ELECTRON_APP/Contents/Info.plist"
USAGE_TEXT="WhisperAlone needs Automation permission to paste transcribed text."

if [[ ! -f "$PLIST_PATH" ]]; then
  echo "[prepare-dev-permissions] Electron Info.plist not found at $PLIST_PATH"
  exit 0
fi

if /usr/libexec/PlistBuddy -c "Print :NSAppleEventsUsageDescription" "$PLIST_PATH" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Set :NSAppleEventsUsageDescription $USAGE_TEXT" "$PLIST_PATH"
else
  /usr/libexec/PlistBuddy -c "Add :NSAppleEventsUsageDescription string $USAGE_TEXT" "$PLIST_PATH"
fi

# Re-sign ad-hoc after Info.plist mutation so macOS does not treat the app as tampered.
if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep --sign - "$ELECTRON_APP" >/dev/null 2>&1 || true
fi

echo "[prepare-dev-permissions] Patched Electron.app Info.plist with NSAppleEventsUsageDescription."

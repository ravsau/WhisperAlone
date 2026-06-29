#!/usr/bin/env bash
set -euo pipefail

SOURCE_APP="${1:-dist/mac-arm64/WhisperAlone.app}"
TARGET_APP="${WHISPERALONE_INSTALL_PATH:-/Applications/WhisperAlone.app}"

if [[ ! -d "$SOURCE_APP" ]]; then
  echo "[install-local] Signed app bundle not found: $SOURCE_APP" >&2
  exit 1
fi

echo "[install-local] Stopping running WhisperAlone processes"
osascript -e 'tell application "WhisperAlone" to quit' >/dev/null 2>&1 || true
sleep 2
pkill -x "WhisperAlone" >/dev/null 2>&1 || true
pkill -f "WhisperAlone Helper" >/dev/null 2>&1 || true
pkill -f "whisper-alone/scripts/mlx-server.py" >/dev/null 2>&1 || true
sleep 1

echo "[install-local] Installing $SOURCE_APP -> $TARGET_APP"
rm -rf "$TARGET_APP"
ditto "$SOURCE_APP" "$TARGET_APP"

codesign --verify --deep --strict --verbose=2 "$TARGET_APP"
codesign -dv --verbose=4 "$TARGET_APP" 2>&1 | sed -n '1,80p'

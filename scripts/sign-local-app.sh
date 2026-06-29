#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:-dist/mac-arm64/WhisperAlone.app}"
ENTITLEMENTS_PATH="${WHISPERALONE_ENTITLEMENTS_PATH:-build/entitlements.mac.plist}"

if [[ ! -d "$APP_PATH" ]]; then
  echo "[sign-local] App bundle not found: $APP_PATH" >&2
  echo "[sign-local] Run npm run dist:dir first." >&2
  exit 1
fi

if [[ ! -f "$ENTITLEMENTS_PATH" ]]; then
  echo "[sign-local] Entitlements file not found: $ENTITLEMENTS_PATH" >&2
  exit 1
fi

IDENTITY="${WHISPERALONE_CODESIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(
    security find-identity -v -p codesigning |
      awk -F'"' '/Apple Development:/ { print $2; exit }'
  )"
fi
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(
    security find-identity -v -p codesigning |
      awk -F'"' '/Apple Distribution:/ { print $2; exit }'
  )"
fi
if [[ -z "$IDENTITY" ]]; then
  echo "[sign-local] No Apple Development or Apple Distribution signing identity found." >&2
  exit 1
fi

echo "[sign-local] Signing $APP_PATH"
echo "[sign-local] Identity: $IDENTITY"

codesign \
  --force \
  --deep \
  --options runtime \
  --entitlements "$ENTITLEMENTS_PATH" \
  --sign "$IDENTITY" \
  "$APP_PATH"

codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign -dv --verbose=4 "$APP_PATH" 2>&1 | sed -n '1,80p'

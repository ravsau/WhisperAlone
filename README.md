# WhisperAlone

A lightweight macOS menu bar app for voice-to-text. Double-tap the Command key to start recording, tap it again to stop. Your speech gets transcribed using OpenAI's Whisper API and pasted directly at your cursor.

No electron window in your face. No dock icon. Just a tiny mic in your menu bar.

## How it works

1. Double-tap `Cmd` — recording starts (menu bar icon changes, overlay appears)
2. Speak naturally
3. Tap `Cmd` once — recording stops
4. Transcribed text is pasted at your cursor in whatever app you're using
5. Your clipboard is preserved (saved before paste, restored after)

Keyboard shortcuts like `Cmd+C`, `Cmd+V`, etc. won't accidentally trigger recording.

## Setup

### Prerequisites

- macOS (Apple Silicon or Intel)
- Node.js 18+
- An [OpenAI API key](https://platform.openai.com/api-keys)

### Install

```bash
git clone https://github.com/ravsau/WhisperAlone.git
cd WhisperAlone
npm install
```

Add your API key to `~/.env`:

```
OPENAI_API_KEY=sk-your-key-here
```

### Run (development)

```bash
npm start
```

### Build the app

```bash
npm run dist
```

This creates a `.dmg` in `dist/`. Drag WhisperAlone to Applications and run it.

### macOS Permissions

WhisperAlone needs three permissions (you'll be prompted on first launch):

- **Accessibility** — for global Command key detection and text injection
- **Microphone** — for audio recording
- **Automation** — for simulating Cmd+V paste into the active app

Go to **System Settings > Privacy & Security** to grant these.

## Features

- **Double-tap Command** to toggle recording (won't interfere with shortcuts)
- **Menu bar tray app** — no dock icon, no window clutter
- **Recording overlay** — small pill at the bottom of your screen shows recording state
- **Transcription history** — right-click the tray icon > Show History
- **Clipboard preservation** — your clipboard is saved and restored after each paste

## Tech Stack

- Electron + TypeScript
- [uiohook-napi](https://github.com/SergioBenitez/uiohook-napi) for global key detection
- OpenAI Whisper API for transcription
- MediaRecorder (WebM/Opus) for audio capture
- JXA/CoreGraphics for text injection

## License

MIT

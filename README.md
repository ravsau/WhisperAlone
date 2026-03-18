# WhisperAlone

A lightweight macOS menu bar app for voice-to-text. Double-tap the Command key to start recording, tap it again to stop. Your speech gets transcribed and pasted directly at your cursor.

Supports both **OpenAI Whisper API** (cloud) and **MLX Whisper** (fully local, on-device, Apple Silicon).

No electron window in your face. No dock icon. Just a tiny mic in your menu bar.

## How it works

1. Double-tap `Cmd` to start recording (menu bar icon changes, overlay appears)
2. Speak naturally
3. Tap `Cmd` once to stop recording
4. Transcribed text is pasted at your cursor in whatever app you're using
5. Your clipboard is preserved (saved before paste, restored after)

Keyboard shortcuts like `Cmd+C`, `Cmd+V`, etc. won't accidentally trigger recording.

## Setup

### Prerequisites

- macOS (Apple Silicon recommended for MLX local models)
- Node.js 18+
- Python 3.10+ (only needed for MLX local mode; installed by default on macOS)

### Install

```bash
git clone https://github.com/ravsau/WhisperAlone.git
cd WhisperAlone
npm install
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

- **Accessibility** for global Command key detection and text injection
- **Microphone** for audio recording
- **Automation** for simulating Cmd+V paste into the active app

Go to **System Settings > Privacy & Security** to grant these.

## Transcription Engines

### OpenAI Whisper API (Cloud)

Uses OpenAI's hosted Whisper model. Requires an API key.

Add your key to `~/.env`:

```
OPENAI_API_KEY=sk-your-key-here
```

### MLX Whisper (Local, On-Device)

Runs Whisper models locally on your Mac using Apple's [MLX framework](https://github.com/ml-explore/mlx). No API key needed. Your audio never leaves your machine.

**First-time setup is automatic.** When you select an MLX model from the tray menu, WhisperAlone will:

1. Create a Python virtual environment in the app's data directory
2. Install `mlx-whisper` and its dependencies via pip
3. Start a local transcription server on `localhost:18456`
4. Download the selected model from HuggingFace on first use

No manual `pip install` required.

**Available models** (selectable from the tray menu):

| Model | Size | Speed | Quality |
|-------|------|-------|---------|
| Whisper Tiny | ~75 MB | Fastest | Basic |
| Whisper Base | ~140 MB | Fast | Good |
| Whisper Small | ~460 MB | Balanced | Great |
| Whisper Medium | ~1.5 GB | Slower | Very good |
| Whisper Large v3 Turbo | ~1.6 GB | Moderate | Best (optimized) |
| Whisper Large v3 | ~3 GB | Slowest | Best |

### Switching Engines

Right-click the menu bar icon to switch between OpenAI and MLX, or pick a specific MLX model. The MLX server starts and stops automatically.

### Benchmarks

Tested on Apple M3 with a 5-second spoken sentence:

| Engine | Model | Avg Latency | Accuracy |
|--------|-------|-------------|----------|
| MLX (local) | whisper-tiny | 0.15s | Fair (struggles with proper nouns) |
| MLX (local) | whisper-large-v3-turbo | 0.70s | Excellent |
| OpenAI (cloud) | whisper-1 | 2.25s | Excellent |

Local MLX models are 3-15x faster than the cloud API since there's no network round-trip. The `whisper-large-v3-turbo` model hits the sweet spot of speed and accuracy for most use cases and is the recommended local model.

## Features

- **Double-tap Command** to toggle recording (won't interfere with shortcuts)
- **Menu bar tray app** with no dock icon or window clutter
- **OpenAI or local MLX** transcription with model picker
- **Auto-managed MLX server** starts with the app, installs dependencies automatically
- **Recording overlay** shows a small pill at the bottom of your screen
- **Transcription history** accessible via tray icon > Show History
- **Clipboard preservation** saves and restores your clipboard after each paste

## Project Structure

```
src/
  main/
    main.ts           App lifecycle, tray menu, IPC, model selection
    transcriber.ts     Routes audio to OpenAI or MLX backend
    mlx-server.ts      Manages MLX Python venv, server lifecycle
    hotkey.ts          Double-tap Command key detection
    injector.ts        Text injection via JXA/CoreGraphics
    store.ts           Settings + transcription history persistence
    logger.ts          File-based logging
  preload/
    preload.ts         IPC bridge (context isolation)
  renderer/
    index.html         History window
    renderer.ts        History UI logic
    audio-capture.*    Hidden recording window (MediaRecorder)
    overlay.*          Recording indicator overlay with waveform
scripts/
  mlx-server.py        MLX Whisper HTTP server
  mlx-transcribe.py    Standalone MLX transcription script
tests/
  store.test.ts        Settings and history tests
  hotkey.test.ts       Hotkey state machine tests
  transcriber.test.ts  Backend routing tests
```

## Tech Stack

- Electron + TypeScript
- [uiohook-napi](https://github.com/SergioBenitez/uiohook-napi) for global key detection
- OpenAI Whisper API for cloud transcription
- [mlx-whisper](https://github.com/ml-explore/mlx-examples/tree/main/whisper) for local transcription
- MediaRecorder (WebM/Opus) for audio capture
- JXA/CoreGraphics for text injection

## Testing

```bash
npm test
```

## License

MIT

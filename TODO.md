# WhisperAlone — Feature Roadmap

Inspired by how Wispr Flow achieves sub-700ms perceived latency and high accuracy.
Each feature is independent and can be shipped incrementally.

---

## 1. Stream Audio to Server While Recording (HIGHEST IMPACT)

**Current:** Audio is captured in chunks, assembled into a single blob on stop, then sent to the MLX server as one batch. The user waits for the full upload + transcription after releasing the key.

**Target:** Stream audio chunks to the MLX server in real-time via WebSocket while the user is still speaking. By the time they release the key, the server has already processed most of the audio. Perceived latency drops from seconds to ~200ms.

**Implementation:**
- Add a WebSocket endpoint to `mlx-server.py` (or a chunked HTTP streaming endpoint)
- `audio-capture.ts` sends each `ondataavailable` chunk (every 100ms) to main process immediately via IPC
- Main process forwards chunks to the server over a persistent connection
- Server accumulates chunks, runs transcription on the full buffer when signaled "done"
- Optionally: run incremental transcription on chunks received so far for partial results

**Complexity:** Medium — touches audio-capture, IPC, mlx-server.py, mlx-server.ts

---

## 2. Trim Silence / VAD Pre-processing (HIGH IMPACT)

**Current:** The full audio blob (including leading/trailing silence) is sent to the model.

**Target:** Run basic Voice Activity Detection locally to trim silence before transcription. This reduces audio size and speeds up model inference.

**Implementation:**
- Add a simple energy-based VAD in `audio-capture.ts` (compute RMS per chunk, skip silence)
- Or use WebAudio API's AnalyserNode to detect speech onset/offset
- Trim leading silence so the model starts processing speech immediately
- Trim trailing silence so the model doesn't waste time on dead air

**Complexity:** Low — mostly in audio-capture.ts

---

## 3. Model Pre-warming / Keep-Alive (HIGH IMPACT)

**Current:** The MLX server loads the model on first transcription request, which adds seconds to the first use after launch.

**Target:** Pre-load the model into memory at server startup so the first transcription is just as fast as subsequent ones. Keep the model hot.

**Implementation:**
- In `mlx-server.py`, import and warm the model at startup (run a dummy transcription on silence)
- Add a `--preload-model <model_name>` CLI arg
- Pass the default model name from the Electron app when spawning the server
- Show "Loading model..." in the setup progress window

**Complexity:** Low — only changes mlx-server.py and mlx-server.ts spawn args

---

## 4. LLM Post-Processing Pass (HIGH IMPACT)

**Current:** Raw Whisper output is pasted directly — includes filler words, no punctuation fixing, no formatting.

**Target:** Run a fast LLM pass on the raw transcript to clean it up: remove filler words ("um", "uh", "like"), fix punctuation, match tone to context. This is what makes Wispr Flow's output feel polished.

**Implementation:**
- Add optional LLM cleanup step in `transcriber.ts` after Whisper returns
- Use local Ollama/MLX LLM or OpenAI API (user-configurable)
- Prompt: "Clean up this dictated text. Remove filler words, fix punctuation. Keep the meaning exactly. Output only the cleaned text."
- Add a setting to enable/disable (some users want raw output)
- Keep it fast: use a small model (Llama 3.2 1B or similar) or stream tokens

**Complexity:** Medium — new post-processing step, settings UI, optional dependency

---

## 5. Partial/Live Results in Overlay (MEDIUM IMPACT)

**Current:** Overlay shows a pulsing "recording" animation. Text only appears after full transcription.

**Target:** Show partial transcription results in the overlay as the user speaks, so they get real-time feedback.

**Implementation:**
- Requires streaming transcription (Feature #1) to produce partial results
- Overlay window receives partial text via IPC and displays it
- Final text replaces partial text and gets pasted

**Complexity:** Medium — depends on Feature #1, touches overlay.ts/html

---

## 6. Context-Aware Formatting (MEDIUM IMPACT)

**Current:** Same output format regardless of where you're typing.

**Target:** Detect the active application and adjust formatting. Casual for Slack/iMessage, proper sentences for email/docs, code-aware for terminals/IDEs.

**Implementation:**
- Use macOS Accessibility API or AppleScript to get the frontmost app name
- Pass app context to the LLM post-processing step (Feature #4)
- Adjust prompt: "User is typing in Slack — keep it casual" vs "User is typing in Mail — use proper grammar"
- Could also detect if user is in a code editor and preserve technical terms

**Complexity:** Medium — needs app detection + LLM integration (Feature #4)

---

## 7. Personal Dictionary / Correction Learning (MEDIUM IMPACT)

**Current:** No memory of corrections. Same mistakes repeated.

**Target:** Learn from user corrections over time. If a user consistently fixes "Claud" to "Claude", auto-apply that correction.

**Implementation:**
- Track when user immediately edits pasted text (via clipboard monitoring or accessibility)
- Store correction pairs in a local JSON file
- Apply corrections as a post-processing step (simple find/replace before or after LLM pass)
- Add a custom vocabulary list in settings for domain-specific terms

**Complexity:** Medium — new correction tracking system, persistent storage

---

## 8. Configurable Hotkey (LOW IMPACT, NICE TO HAVE)

**Current:** Hardcoded double-tap Command key.

**Target:** Let users configure their trigger: Fn key (like Wispr Flow), Caps Lock, or custom combo.

**Implementation:**
- Add hotkey setting in store
- Update `hotkey.ts` to support configurable key codes
- Add UI for hotkey selection in tray menu or settings window

**Complexity:** Low-Medium

---

## 9. Recording Time Limit + Progress Indicator (LOW IMPACT)

**Current:** No time limit on recording, no visual indicator of elapsed time.

**Target:** Show elapsed recording time in overlay. Optionally set a max duration (Wispr caps at 6-20 min).

**Implementation:**
- Add a timer display to overlay.html/ts
- Send elapsed time updates via IPC
- Auto-stop at configurable max duration

**Complexity:** Low

---

## Priority Order for Implementation

| # | Feature | Impact | Effort | Do First? |
|---|---------|--------|--------|-----------|
| 1 | Stream audio while recording | Highest | Medium | Yes |
| 3 | Model pre-warming | High | Low | Yes |
| 2 | VAD silence trimming | High | Low | Yes |
| 4 | LLM post-processing | High | Medium | After 1-3 |
| 5 | Partial live results | Medium | Medium | After 1 |
| 6 | Context-aware formatting | Medium | Medium | After 4 |
| 7 | Correction learning | Medium | Medium | Standalone |
| 8 | Configurable hotkey | Low | Low | Anytime |
| 9 | Recording time + progress | Low | Low | Anytime |

console.log('[AudioCapture] Loaded');

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let currentStream: MediaStream | null = null;
let recorderActive = false;
let stopRequested = false;
let recordingStartedAt = 0;
let recordingAudioSizeBytes = 0;

// VAD state — track which chunks contain speech so we can trim silence
let analyser: AnalyserNode | null = null;
let audioContext: AudioContext | null = null;
let vadInterval: ReturnType<typeof setInterval> | null = null;
let speechDetected = false;
let speechStartMs = 0;
let speechEndMs = 0;

const VAD_RMS_THRESHOLD = 0.015; // minimum RMS to count as speech
const VAD_CHECK_INTERVAL_MS = 50;
const SPEECH_LEADING_PADDING_MS = 250;
const SPEECH_TRAILING_PADDING_MS = 600;

function currentRecordingDurationMs(): number | undefined {
  if (recordingStartedAt <= 0) return undefined;
  return Math.max(0, Math.round(performance.now() - recordingStartedAt));
}

function sendFinalAudioData(bytes: number[], audioSizeBytes = bytes.length): void {
  const durationMs = currentRecordingDurationMs();
  window.api.sendAudioData({
    bytes,
    durationMs,
    audioSizeBytes,
    speechDetected,
    speechStartMs: speechDetected ? Math.max(0, speechStartMs - SPEECH_LEADING_PADDING_MS) : undefined,
    speechEndMs: speechDetected && durationMs !== undefined
      ? Math.min(durationMs, speechEndMs + SPEECH_TRAILING_PADDING_MS)
      : undefined,
  });
}

function checkVAD(): void {
  if (!analyser) return;
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);

  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
  }
  const rms = Math.sqrt(sum / data.length);

  if (rms > VAD_RMS_THRESHOLD) {
    const elapsedMs = currentRecordingDurationMs() ?? 0;
    if (!speechDetected) {
      speechStartMs = elapsedMs;
      speechDetected = true;
      console.log('[AudioCapture] VAD: speech start at', speechStartMs, 'ms');
    }
    speechEndMs = elapsedMs;
  }
}

function startVAD(stream: MediaStream): void {
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  speechDetected = false;
  speechStartMs = 0;
  speechEndMs = 0;

  vadInterval = setInterval(checkVAD, VAD_CHECK_INTERVAL_MS);
}

function stopVAD(): void {
  if (vadInterval) {
    clearInterval(vadInterval);
    vadInterval = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  analyser = null;
}

window.api.onStartRecording(async () => {
  console.log('[AudioCapture] Start recording requested');
  stopRequested = false;
  recordingStartedAt = 0;
  recordingAudioSizeBytes = 0;
  speechDetected = false;
  speechStartMs = 0;
  speechEndMs = 0;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    if (stopRequested) {
      console.log('[AudioCapture] Stop was requested during mic init, sending empty');
      stream.getTracks().forEach((track) => track.stop());
      sendFinalAudioData([]);
      return;
    }

    console.log('[AudioCapture] Got mic stream');
    currentStream = stream;
    audioChunks = [];

    startVAD(stream);

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    console.log('[AudioCapture] Using mimeType:', mimeType);
    mediaRecorder = new MediaRecorder(stream, { mimeType });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
        recordingAudioSizeBytes += event.data.size;
      }
    };

    mediaRecorder.onstop = async () => {
      recorderActive = false;
      stopVAD();
      if (!speechDetected) {
        console.log('[AudioCapture] VAD: no speech detected in recording');
      }

      // Send one complete WebM. The server uses the VAD timestamps to decode
      // only the speech window without corrupting the media container.
      console.log('[AudioCapture] Recorder stopped, chunks:', audioChunks.length);
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const arrayBuffer = await audioBlob.arrayBuffer();
      console.log('[AudioCapture] Sending', arrayBuffer.byteLength, 'bytes to main');
      sendFinalAudioData(Array.from(new Uint8Array(arrayBuffer)), arrayBuffer.byteLength);

      if (currentStream) {
        currentStream.getTracks().forEach((track) => track.stop());
        currentStream = null;
      }
    };

    mediaRecorder.start(100);
    recorderActive = true;
    recordingStartedAt = performance.now();
    console.log('[AudioCapture] Recording started');
  } catch (err) {
    console.error('[AudioCapture] Error:', err);
    window.api.sendRecordingError((err as Error).message);
  }
});

window.api.onStopRecording(() => {
  console.log('[AudioCapture] Stop recording requested, state:', mediaRecorder?.state, 'recorderActive:', recorderActive);
  stopRequested = true;

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  } else if (!recorderActive) {
    console.log('[AudioCapture] Recorder not active, sending empty data');
    sendFinalAudioData([]);
  }
});

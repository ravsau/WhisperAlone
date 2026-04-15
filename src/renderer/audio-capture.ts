console.log('[AudioCapture] Loaded');

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let currentStream: MediaStream | null = null;
let recorderActive = false;
let stopRequested = false;

// VAD state — track which chunks contain speech so we can trim silence
let analyser: AnalyserNode | null = null;
let audioContext: AudioContext | null = null;
let vadInterval: ReturnType<typeof setInterval> | null = null;
let speechDetected = false;
let firstSpeechChunkIndex = 0;
let lastSpeechChunkIndex = 0;

const VAD_RMS_THRESHOLD = 0.015; // minimum RMS to count as speech
const VAD_CHECK_INTERVAL_MS = 50;

function checkVAD(): void {
  if (!analyser) return;
  const data = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(data);

  // Compute RMS
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
  }
  const rms = Math.sqrt(sum / data.length);

  if (rms > VAD_RMS_THRESHOLD) {
    if (!speechDetected) {
      // Mark the first chunk with speech (use current chunk count minus 1 for a small buffer)
      firstSpeechChunkIndex = Math.max(0, audioChunks.length - 1);
      speechDetected = true;
      console.log('[AudioCapture] VAD: speech start at chunk', firstSpeechChunkIndex);
    }
    lastSpeechChunkIndex = audioChunks.length;
  }
}

function startVAD(stream: MediaStream): void {
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  speechDetected = false;
  firstSpeechChunkIndex = 0;
  lastSpeechChunkIndex = 0;

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

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    // If stop was requested while we were awaiting the mic, abort immediately
    if (stopRequested) {
      console.log('[AudioCapture] Stop was requested during mic init, sending empty');
      stream.getTracks().forEach((track) => track.stop());
      window.api.sendAudioData([]);
      return;
    }

    console.log('[AudioCapture] Got mic stream');
    currentStream = stream;
    audioChunks = [];

    // Start VAD analysis on the raw stream
    startVAD(stream);

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    console.log('[AudioCapture] Using mimeType:', mimeType);
    mediaRecorder = new MediaRecorder(stream, { mimeType });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      recorderActive = false;
      stopVAD();

      // Trim silent chunks from start and end
      let trimmedChunks = audioChunks;
      if (speechDetected && audioChunks.length > 0) {
        // Keep one extra chunk before/after speech for safety
        const start = Math.max(0, firstSpeechChunkIndex - 1);
        const end = Math.min(audioChunks.length, lastSpeechChunkIndex + 2);
        trimmedChunks = audioChunks.slice(start, end);
        const trimmed = audioChunks.length - trimmedChunks.length;
        if (trimmed > 0) {
          console.log(`[AudioCapture] VAD trimmed ${trimmed} silent chunks (${audioChunks.length} -> ${trimmedChunks.length})`);
        }
      } else if (!speechDetected) {
        console.log('[AudioCapture] VAD: no speech detected in recording');
      }

      console.log('[AudioCapture] Recorder stopped, chunks:', trimmedChunks.length);
      const audioBlob = new Blob(trimmedChunks, { type: 'audio/webm' });
      const arrayBuffer = await audioBlob.arrayBuffer();
      console.log('[AudioCapture] Sending', arrayBuffer.byteLength, 'bytes to main');
      window.api.sendAudioData(Array.from(new Uint8Array(arrayBuffer)));

      // Release microphone
      if (currentStream) {
        currentStream.getTracks().forEach((track) => track.stop());
        currentStream = null;
      }
    };

    mediaRecorder.start(100);
    recorderActive = true;
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
    // MediaRecorder hasn't started yet — the onstop handler won't fire
    // Send empty data so main process doesn't hang
    console.log('[AudioCapture] Recorder not active, sending empty data');
    window.api.sendAudioData([]);
  }
});

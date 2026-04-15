console.log('[AudioCapture] Loaded');

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let currentStream: MediaStream | null = null;
let recorderActive = false;
let stopRequested = false;
let chunksSentToStream = 0;

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

  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
  }
  const rms = Math.sqrt(sum / data.length);

  if (rms > VAD_RMS_THRESHOLD) {
    if (!speechDetected) {
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

async function sendChunkToStream(blob: Blob): Promise<void> {
  const arrayBuffer = await blob.arrayBuffer();
  window.api.sendAudioChunk(Array.from(new Uint8Array(arrayBuffer)));
  chunksSentToStream++;
}

window.api.onStartRecording(async () => {
  console.log('[AudioCapture] Start recording requested');
  stopRequested = false;
  chunksSentToStream = 0;

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
      window.api.sendAudioData([]);
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
        // Stream every chunk to the server in real-time (including the webm header in chunk 0)
        sendChunkToStream(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      recorderActive = false;
      stopVAD();

      if (chunksSentToStream > 0) {
        // Streaming mode: all chunks already sent to server.
        // Send empty audio-data to signal main process to call /stream/finish.
        console.log(`[AudioCapture] Streamed ${chunksSentToStream} chunks, signaling finish`);
        window.api.sendAudioData([]);
        if (currentStream) {
          currentStream.getTracks().forEach((track) => track.stop());
          currentStream = null;
        }
        return;
      }

      // Fallback: batch mode with VAD trimming (if streaming wasn't active)
      let trimmedChunks = audioChunks;
      if (speechDetected && audioChunks.length > 0) {
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
    console.log('[AudioCapture] Recorder not active, sending empty data');
    window.api.sendAudioData([]);
  }
});

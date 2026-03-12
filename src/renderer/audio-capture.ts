console.log('[AudioCapture] Loaded');

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let currentStream: MediaStream | null = null;
let recorderActive = false;
let stopRequested = false;

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
      console.log('[AudioCapture] Recorder stopped, chunks:', audioChunks.length);
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
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

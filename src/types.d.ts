interface WhisperAloneAPI {
  // Audio capture
  onStartRecording: (callback: () => void) => void;
  onStopRecording: (callback: () => void) => void;
  sendAudioData: (data: number[]) => void;
  sendRecordingError: (message: string) => void;

  // History
  getHistory: () => Promise<
    Array<{ id: string; text: string; timestamp: number; duration: number }>
  >;
  onHistoryUpdate: (
    callback: (
      entries: Array<{
        id: string;
        text: string;
        timestamp: number;
        duration: number;
      }>
    ) => void
  ) => void;
}

interface Window {
  api: WhisperAloneAPI;
}

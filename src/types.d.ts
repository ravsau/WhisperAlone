interface MLXModel {
  id: string;
  name: string;
  size: string;
  speed: string;
}

interface AppSettings {
  backend: 'openai' | 'mlx';
  mlxModel: string;
}

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

  // Settings
  getSettings: () => Promise<AppSettings>;
  setSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  getMLXModels: () => Promise<MLXModel[]>;
}

interface Window {
  api: WhisperAloneAPI;
}

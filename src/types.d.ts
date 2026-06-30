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

interface AudioDataPayload {
  bytes: number[];
  durationMs?: number;
  audioSizeBytes?: number;
}

interface DailyUsageStats {
  sessions: number;
  words: number;
  dictationSeconds: number;
  trackedDictationSeconds?: number;
  trackedDictationSessions?: number;
}

interface UsageStats {
  schemaVersion?: number;
  initializedFromHistory: boolean;
  totalSessions: number;
  totalWords: number;
  totalDictationSeconds: number;
  trackedDictationSeconds?: number;
  trackedDictationSessions?: number;
  firstRecordedAt: number | null;
  lastRecordedAt: number | null;
  daily: Record<string, DailyUsageStats>;
}

interface WhisperAloneAPI {
  // Audio capture
  onStartRecording: (callback: () => void) => void;
  onStopRecording: (callback: () => void) => void;
  sendAudioData: (payload: number[] | AudioDataPayload) => void;
  sendAudioChunk: (data: number[]) => void;
  sendRecordingError: (message: string) => void;

  // History
  getHistory: () => Promise<
    Array<{
      id: string;
      text: string;
      timestamp: number;
      duration: number;
      wordCount?: number;
      durationSource?: 'recorded' | 'estimated' | 'recovered';
    }>
  >;
  onHistoryUpdate: (
    callback: (
      entries: Array<{
        id: string;
        text: string;
        timestamp: number;
        duration: number;
        wordCount?: number;
        durationSource?: 'recorded' | 'estimated' | 'recovered';
      }>
    ) => void
  ) => void;
  getUsageStats: () => Promise<UsageStats>;
  onUsageStatsUpdate: (callback: (stats: UsageStats) => void) => void;

  // Settings
  getSettings: () => Promise<AppSettings>;
  setSettings: (settings: Partial<AppSettings>) => Promise<AppSettings>;
  getMLXModels: () => Promise<MLXModel[]>;

  // Setup progress
  onSetupProgress: (callback: (data: { step: string; state: string; message: string }) => void) => void;
}

interface Window {
  api: WhisperAloneAPI;
}

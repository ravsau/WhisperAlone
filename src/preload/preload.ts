import { contextBridge, ipcRenderer } from 'electron';

type AudioDataPayload = number[] | {
  bytes: number[];
  durationMs?: number;
  audioSizeBytes?: number;
  speechDetected?: boolean;
  speechStartMs?: number;
  speechEndMs?: number;
};

contextBridge.exposeInMainWorld('api', {
  // Audio capture window APIs
  onStartRecording: (callback: () => void) => {
    ipcRenderer.on('start-recording', () => callback());
  },
  onStopRecording: (callback: () => void) => {
    ipcRenderer.on('stop-recording', () => callback());
  },
  sendAudioData: (payload: AudioDataPayload) => {
    ipcRenderer.send('audio-data', payload);
  },
  sendRecordingError: (message: string) => {
    ipcRenderer.send('recording-error', message);
  },

  // History window APIs
  onHistoryUpdate: (callback: (entries: any[]) => void) => {
    ipcRenderer.on('history-update', (_event, entries) => callback(entries));
  },
  getHistory: () => ipcRenderer.invoke('get-history'),
  onUsageStatsUpdate: (callback: (stats: any) => void) => {
    ipcRenderer.on('usage-stats-update', (_event, stats) => callback(stats));
  },
  getUsageStats: () => ipcRenderer.invoke('get-usage-stats'),

  // Settings APIs
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (settings: any) => ipcRenderer.invoke('set-settings', settings),
  getMLXModels: () => ipcRenderer.invoke('get-mlx-models'),

  // Setup progress
  onSetupProgress: (callback: (data: any) => void) => {
    ipcRenderer.on('setup-progress', (_event, data) => callback(data));
  },
});

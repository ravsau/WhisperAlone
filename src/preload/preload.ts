import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  // Audio capture window APIs
  onStartRecording: (callback: () => void) => {
    ipcRenderer.on('start-recording', () => callback());
  },
  onStopRecording: (callback: () => void) => {
    ipcRenderer.on('stop-recording', () => callback());
  },
  sendAudioData: (data: number[]) => {
    ipcRenderer.send('audio-data', data);
  },
  sendAudioChunk: (data: number[]) => {
    ipcRenderer.send('audio-chunk', data);
  },
  sendRecordingError: (message: string) => {
    ipcRenderer.send('recording-error', message);
  },

  // History window APIs
  onHistoryUpdate: (callback: (entries: any[]) => void) => {
    ipcRenderer.on('history-update', (_event, entries) => callback(entries));
  },
  getHistory: () => ipcRenderer.invoke('get-history'),

  // Settings APIs
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (settings: any) => ipcRenderer.invoke('set-settings', settings),
  getMLXModels: () => ipcRenderer.invoke('get-mlx-models'),

  // Setup progress
  onSetupProgress: (callback: (data: any) => void) => {
    ipcRenderer.on('setup-progress', (_event, data) => callback(data));
  },
});

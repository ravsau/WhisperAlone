import { Conf } from 'electron-conf';
import type { TranscriberBackend } from './transcriber';

export interface TranscriptionEntry {
  id: string;
  text: string;
  timestamp: number;
  duration: number;
}

export interface AppSettings {
  backend: TranscriberBackend;
  mlxModel: string;
}

interface StoreSchema {
  history: TranscriptionEntry[];
  settings: AppSettings;
}

const DEFAULT_SETTINGS: AppSettings = {
  backend: 'mlx',
  mlxModel: 'mlx-community/whisper-large-v3-turbo',
};

const store = new Conf<StoreSchema>({
  defaults: {
    history: [],
    settings: DEFAULT_SETTINGS,
  },
});

// --- History ---

export function addHistoryEntry(text: string, audioSizeBytes: number): TranscriptionEntry {
  const entry: TranscriptionEntry = {
    id: crypto.randomUUID(),
    text,
    timestamp: Date.now(),
    // Rough estimate: webm/opus at ~32kbps ≈ 4KB/sec
    duration: Math.max(1, Math.round(audioSizeBytes / 4000)),
  };

  const history = store.get('history');
  history.unshift(entry);

  // Cap at 500 entries
  if (history.length > 500) {
    history.length = 500;
  }

  store.set('history', history);
  return entry;
}

export function getHistory(): TranscriptionEntry[] {
  return store.get('history');
}

export function clearHistory(): void {
  store.set('history', []);
}

// --- Settings ---

export function getSettings(): AppSettings {
  return store.get('settings') || DEFAULT_SETTINGS;
}

export function setSettings(settings: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const updated = { ...current, ...settings };
  store.set('settings', updated);
  return updated;
}

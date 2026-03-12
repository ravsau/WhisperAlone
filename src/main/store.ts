import { Conf } from 'electron-conf';

export interface TranscriptionEntry {
  id: string;
  text: string;
  timestamp: number;
  duration: number;
}

interface StoreSchema {
  history: TranscriptionEntry[];
}

const store = new Conf<StoreSchema>({
  defaults: {
    history: [],
  },
});

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

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockStore } = vi.hoisted(() => {
  const mockStore = new Map<string, any>();
  return { mockStore };
});

vi.mock('electron-conf', () => ({
  Conf: class {
    private defaults: Record<string, any>;
    constructor(opts: { defaults: Record<string, any> }) {
      this.defaults = opts.defaults;
      for (const [key, val] of Object.entries(opts.defaults)) {
        if (!mockStore.has(key)) {
          mockStore.set(key, JSON.parse(JSON.stringify(val)));
        }
      }
    }
    get(key: string) {
      return mockStore.has(key) ? mockStore.get(key) : this.defaults[key];
    }
    set(key: string, value: any) {
      mockStore.set(key, value);
    }
  },
}));

vi.mock('../src/main/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
}));

vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid-1234' });

import {
  addHistoryEntry,
  getHistory,
  clearHistory,
  getSettings,
  getUsageStats,
  setSettings,
} from '../src/main/store';

beforeEach(() => {
  process.env.WHISPERALONE_DISABLE_LOG_RECOVERY = '1';
  mockStore.clear();
  mockStore.set('history', []);
  mockStore.set('settings', { backend: 'mlx', mlxModel: 'mlx-community/whisper-large-v3-turbo' });
});

describe('History', () => {
  it('adds an entry to history', () => {
    const entry = addHistoryEntry('hello world', 8000);
    expect(entry.text).toBe('hello world');
    expect(entry.id).toBe('test-uuid-1234');
    expect(entry.duration).toBe(2);
    expect(entry.wordCount).toBe(2);
    expect(entry.durationSource).toBe('estimated');
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  it('prepends new entries', () => {
    addHistoryEntry('first', 4000);
    addHistoryEntry('second', 4000);
    const history = getHistory();
    expect(history.length).toBe(2);
    expect(history[0].text).toBe('second');
    expect(history[1].text).toBe('first');
  });

  it('keeps history entries instead of capping at 500', () => {
    for (let i = 0; i < 510; i++) {
      addHistoryEntry(`entry ${i}`, 4000);
    }
    const history = getHistory();
    expect(history.length).toBe(510);
  });

  it('clears history', () => {
    addHistoryEntry('test', 4000);
    clearHistory();
    expect(getHistory().length).toBe(0);
  });

  it('migrates past repetition loops and rebuilds word counts', () => {
    mockStore.set('transcriptCleanupVersion', 0);
    mockStore.set('history', [
      {
        id: 'corrupt-entry',
        text: `Keep this. ${'On '.repeat(30)}`,
        timestamp: Date.now(),
        duration: 10,
        wordCount: 32,
      },
      {
        id: 'loop-only-entry',
        text: 'page '.repeat(30),
        timestamp: Date.now() - 1000,
        duration: 5,
        wordCount: 30,
      },
    ]);

    const history = getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe('Keep this.');
    expect(history[0].wordCount).toBe(2);
    expect(getUsageStats().totalWords).toBe(2);
  });

  it('estimates duration from audio size', () => {
    const entry = addHistoryEntry('test', 20000);
    expect(entry.duration).toBe(5);
    expect(entry.durationSource).toBe('estimated');
  });

  it('records explicit duration from recorder timing', () => {
    const entry = addHistoryEntry('test', 20000, 4200);
    expect(entry.duration).toBe(4);
    expect(entry.durationSource).toBe('recorded');
  });

  it('sets minimum duration to 1 second', () => {
    const entry = addHistoryEntry('test', 100);
    expect(entry.duration).toBe(1);
  });
});

describe('Usage stats', () => {
  it('tracks totals when adding a history entry', () => {
    addHistoryEntry('hello world from whisper', 8000, 4200);

    const stats = getUsageStats();
    const daily = Object.values(stats.daily);

    expect(stats.totalSessions).toBe(1);
    expect(stats.totalWords).toBe(4);
    expect(stats.totalDictationSeconds).toBe(4);
    expect(stats.trackedDictationSeconds).toBe(4);
    expect(stats.trackedDictationSessions).toBe(1);
    expect(stats.firstRecordedAt).toBeGreaterThan(0);
    expect(stats.lastRecordedAt).toBe(stats.firstRecordedAt);
    expect(daily).toHaveLength(1);
    expect(daily[0]).toMatchObject({
      sessions: 1,
      words: 4,
      dictationSeconds: 4,
      trackedDictationSeconds: 4,
      trackedDictationSessions: 1,
    });
  });

  it('initializes usage stats from existing history once', () => {
    mockStore.set('history', [
      {
        id: 'old-entry',
        text: 'existing dictated words',
        timestamp: Date.now() - 1000,
        duration: 5,
      },
    ]);

    const initialized = getUsageStats();
    const secondRead = getUsageStats();

    expect(initialized.initializedFromHistory).toBe(true);
    expect(initialized.totalSessions).toBe(1);
    expect(initialized.totalWords).toBe(3);
    expect(initialized.totalDictationSeconds).toBe(5);
    expect(initialized.trackedDictationSeconds).toBe(0);
    expect(initialized.trackedDictationSessions).toBe(0);
    expect(secondRead.totalSessions).toBe(1);
    expect(secondRead.totalWords).toBe(3);
  });

  it('rebuilds old usage stats schemas from history', () => {
    mockStore.set('history', [
      {
        id: 'old-entry',
        text: 'existing dictated words',
        timestamp: Date.now() - 1000,
        duration: 5,
      },
    ]);
    mockStore.set('usageStats', {
      initializedFromHistory: true,
      totalSessions: 999,
      totalWords: 999,
      totalDictationSeconds: 999,
      firstRecordedAt: Date.now(),
      lastRecordedAt: Date.now(),
      daily: {},
    });

    const rebuilt = getUsageStats();

    expect(rebuilt.schemaVersion).toBe(4);
    expect(rebuilt.totalSessions).toBe(1);
    expect(rebuilt.totalWords).toBe(3);
    expect(rebuilt.trackedDictationSeconds).toBe(0);
  });
});

describe('Settings', () => {
  it('returns default settings', () => {
    const settings = getSettings();
    expect(settings.backend).toBe('mlx');
    expect(settings.mlxModel).toBe('mlx-community/whisper-large-v3-turbo');
  });

  it('updates backend setting', () => {
    setSettings({ backend: 'mlx' });
    const settings = getSettings();
    expect(settings.backend).toBe('mlx');
    expect(settings.mlxModel).toBe('mlx-community/whisper-large-v3-turbo');
  });

  it('updates model setting', () => {
    setSettings({ mlxModel: 'mlx-community/whisper-large-v3' });
    const settings = getSettings();
    expect(settings.mlxModel).toBe('mlx-community/whisper-large-v3');
  });

  it('updates multiple settings at once', () => {
    const updated = setSettings({ backend: 'mlx', mlxModel: 'mlx-community/whisper-tiny' });
    expect(updated.backend).toBe('mlx');
    expect(updated.mlxModel).toBe('mlx-community/whisper-tiny');
  });
});

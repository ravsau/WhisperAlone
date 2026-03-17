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

vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid-1234' });

import { addHistoryEntry, getHistory, clearHistory, getSettings, setSettings } from '../src/main/store';

beforeEach(() => {
  mockStore.clear();
  mockStore.set('history', []);
  mockStore.set('settings', { backend: 'openai', mlxModel: 'mlx-community/whisper-small' });
});

describe('History', () => {
  it('adds an entry to history', () => {
    const entry = addHistoryEntry('hello world', 8000);
    expect(entry.text).toBe('hello world');
    expect(entry.id).toBe('test-uuid-1234');
    expect(entry.duration).toBe(2);
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

  it('caps history at 500 entries', () => {
    for (let i = 0; i < 510; i++) {
      addHistoryEntry(`entry ${i}`, 4000);
    }
    const history = getHistory();
    expect(history.length).toBe(500);
  });

  it('clears history', () => {
    addHistoryEntry('test', 4000);
    clearHistory();
    expect(getHistory().length).toBe(0);
  });

  it('estimates duration from audio size', () => {
    const entry = addHistoryEntry('test', 20000);
    expect(entry.duration).toBe(5);
  });

  it('sets minimum duration to 1 second', () => {
    const entry = addHistoryEntry('test', 100);
    expect(entry.duration).toBe(1);
  });
});

describe('Settings', () => {
  it('returns default settings', () => {
    const settings = getSettings();
    expect(settings.backend).toBe('openai');
    expect(settings.mlxModel).toBe('mlx-community/whisper-small');
  });

  it('updates backend setting', () => {
    setSettings({ backend: 'mlx' });
    const settings = getSettings();
    expect(settings.backend).toBe('mlx');
    expect(settings.mlxModel).toBe('mlx-community/whisper-small');
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

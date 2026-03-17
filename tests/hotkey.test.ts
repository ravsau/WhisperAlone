import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock uiohook-napi
const handlers: Record<string, Function[]> = {};
vi.mock('uiohook-napi', () => ({
  uIOhook: {
    on: (event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    start: vi.fn(),
    stop: vi.fn(),
  },
  UiohookKey: {
    Meta: 55,
    MetaRight: 3675,
  },
}));

import { HotkeyManager } from '../src/main/hotkey';

function fireKeydown(keycode: number) {
  for (const h of handlers['keydown'] || []) h({ keycode });
}

function fireKeyup(keycode: number) {
  for (const h of handlers['keyup'] || []) h({ keycode });
}

const META = 55;
const KEY_A = 30;

beforeEach(() => {
  handlers['keydown'] = [];
  handlers['keyup'] = [];
});

describe('HotkeyManager', () => {
  it('starts in IDLE state', () => {
    const hm = new HotkeyManager();
    expect(hm.getState()).toBe('IDLE');
  });

  it('emits recording-start on double-tap Command', () => {
    const hm = new HotkeyManager();
    const startSpy = vi.fn();
    hm.on('recording-start', startSpy);
    hm.start();

    // First tap
    fireKeydown(META);
    fireKeyup(META);

    // Second tap (within window)
    fireKeydown(META);
    fireKeyup(META);

    expect(startSpy).toHaveBeenCalledOnce();
    expect(hm.getState()).toBe('RECORDING');
  });

  it('emits recording-stop on single tap while recording', () => {
    const hm = new HotkeyManager();
    const stopSpy = vi.fn();
    hm.on('recording-stop', stopSpy);
    hm.start();

    // Double-tap to start recording
    fireKeydown(META);
    fireKeyup(META);
    fireKeydown(META);
    fireKeyup(META);

    // Single tap to stop
    fireKeydown(META);
    fireKeyup(META);

    expect(stopSpy).toHaveBeenCalledOnce();
    expect(hm.getState()).toBe('PROCESSING');
  });

  it('ignores Command when combined with other keys (shortcuts)', () => {
    const hm = new HotkeyManager();
    const startSpy = vi.fn();
    hm.on('recording-start', startSpy);
    hm.start();

    // First tap (clean)
    fireKeydown(META);
    fireKeyup(META);

    // Cmd+A (should not count as second tap)
    fireKeydown(META);
    fireKeydown(KEY_A);
    fireKeyup(KEY_A);
    fireKeyup(META);

    expect(startSpy).not.toHaveBeenCalled();
    expect(hm.getState()).toBe('IDLE');
  });

  it('setIdle resets to IDLE from PROCESSING', () => {
    const hm = new HotkeyManager();
    hm.start();

    // Get to PROCESSING state
    fireKeydown(META);
    fireKeyup(META);
    fireKeydown(META);
    fireKeyup(META);
    fireKeydown(META);
    fireKeyup(META);

    expect(hm.getState()).toBe('PROCESSING');
    hm.setIdle();
    expect(hm.getState()).toBe('IDLE');
  });

  it('ignores key events during PROCESSING state', () => {
    const hm = new HotkeyManager();
    const startSpy = vi.fn();
    hm.on('recording-start', startSpy);
    hm.start();

    // Get to PROCESSING
    fireKeydown(META);
    fireKeyup(META);
    fireKeydown(META);
    fireKeyup(META);
    fireKeydown(META);
    fireKeyup(META);

    // Should be ignored
    fireKeydown(META);
    fireKeyup(META);
    fireKeydown(META);
    fireKeyup(META);

    expect(startSpy).toHaveBeenCalledOnce(); // Only the initial one
  });
});

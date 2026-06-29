import { uIOhook, UiohookKey, type UiohookKeyboardEvent } from 'uiohook-napi';
import { EventEmitter } from 'events';

export type AppState = 'IDLE' | 'RECORDING' | 'PROCESSING';

const DOUBLE_TAP_WINDOW_MS = 400;

export class HotkeyManager extends EventEmitter {
  private state: AppState = 'IDLE';
  private lastMetaReleaseTime = 0;
  private metaDownWithoutOtherKeys = false;
  private started = false;
  private readonly handleKeydown = (e: UiohookKeyboardEvent): void => {
    const isMeta = e.keycode === UiohookKey.Meta || e.keycode === UiohookKey.MetaRight;
    if (isMeta) {
      this.metaDownWithoutOtherKeys = true;
    } else {
      // Another key pressed while Meta held = shortcut (Cmd+C, etc.), not a tap
      this.metaDownWithoutOtherKeys = false;
    }
  };
  private readonly handleKeyup = (e: UiohookKeyboardEvent): void => {
    const isMeta = e.keycode === UiohookKey.Meta || e.keycode === UiohookKey.MetaRight;
    if (!isMeta) return;
    if (!this.metaDownWithoutOtherKeys) return;

    const now = Date.now();

    if (this.state === 'IDLE') {
      const elapsed = now - this.lastMetaReleaseTime;
      if (elapsed < DOUBLE_TAP_WINDOW_MS && this.lastMetaReleaseTime > 0) {
        this.state = 'RECORDING';
        this.lastMetaReleaseTime = 0;
        this.emit('recording-start');
      } else {
        this.lastMetaReleaseTime = now;
      }
    } else if (this.state === 'RECORDING') {
      this.state = 'PROCESSING';
      this.emit('recording-stop');
    }
    // PROCESSING state: ignore all key events
  };

  start(): void {
    if (this.started) return;

    uIOhook.on('keydown', this.handleKeydown);
    uIOhook.on('keyup', this.handleKeyup);

    try {
      uIOhook.start();
      this.started = true;
    } catch (err) {
      this.detachListeners();
      throw err;
    }
  }

  setIdle(): void {
    this.state = 'IDLE';
    this.lastMetaReleaseTime = 0;
  }

  getState(): AppState {
    return this.state;
  }

  stop(): void {
    if (!this.started) {
      this.detachListeners();
      return;
    }
    uIOhook.stop();
    this.started = false;
    this.detachListeners();
  }

  private detachListeners(): void {
    const hook = uIOhook as unknown as {
      off?: (event: 'keydown' | 'keyup', listener: (e: UiohookKeyboardEvent) => void) => void;
      removeListener?: (event: 'keydown' | 'keyup', listener: (e: UiohookKeyboardEvent) => void) => void;
    };
    if (hook.off) {
      hook.off('keydown', this.handleKeydown);
      hook.off('keyup', this.handleKeyup);
      return;
    }
    if (hook.removeListener) {
      hook.removeListener('keydown', this.handleKeydown);
      hook.removeListener('keyup', this.handleKeyup);
    }
  }
}

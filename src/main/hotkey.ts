import { uIOhook, UiohookKey } from 'uiohook-napi';
import { EventEmitter } from 'events';

export type AppState = 'IDLE' | 'RECORDING' | 'PROCESSING';

const DOUBLE_TAP_WINDOW_MS = 400;

export class HotkeyManager extends EventEmitter {
  private state: AppState = 'IDLE';
  private lastMetaReleaseTime = 0;
  private metaDownWithoutOtherKeys = false;

  start(): void {
    uIOhook.on('keydown', (e) => {
      const isMeta = e.keycode === UiohookKey.Meta || e.keycode === UiohookKey.MetaRight;
      if (isMeta) {
        this.metaDownWithoutOtherKeys = true;
      } else {
        // Another key pressed while Meta held = shortcut (Cmd+C, etc.), not a tap
        this.metaDownWithoutOtherKeys = false;
      }
    });

    uIOhook.on('keyup', (e) => {
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
    });

    uIOhook.start();
  }

  setIdle(): void {
    this.state = 'IDLE';
    this.lastMetaReleaseTime = 0;
  }

  getState(): AppState {
    return this.state;
  }

  stop(): void {
    uIOhook.stop();
  }
}

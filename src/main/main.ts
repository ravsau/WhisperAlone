import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  systemPreferences,
  dialog,
  Notification,
  screen,
} from 'electron';
import path from 'path';
import dotenv from 'dotenv';
import { HotkeyManager } from './hotkey';
import { transcribeAudio } from './transcriber';
import { injectText } from './injector';
import { addHistoryEntry, getHistory } from './store';
import { log, logError } from './logger';

import os from 'os';

// Load API key from user-level ~/.env
dotenv.config({ path: path.join(os.homedir(), '.env') });

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let audioWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let hotkey: HotkeyManager | null = null;

// Resolve asset path (works in both dev and packaged app)
function assetPath(filename: string): string {
  return path.join(__dirname, '../../assets', filename);
}

function rendererPath(filename: string): string {
  return path.join(__dirname, '../../src/renderer', filename);
}

function preloadPath(): string {
  return path.join(__dirname, '../preload/preload.js');
}

// --- Tray ---

function createTray(): void {
  const icon = nativeImage.createFromPath(assetPath('trayIconTemplate.png'));
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show History', click: () => showMainWindow() },
    { type: 'separator' },
    { label: 'Quit WhisperAlone', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip('WhisperAlone — Double-tap ⌘ to transcribe');
}

function setTrayRecording(isRecording: boolean): void {
  const iconName = isRecording
    ? 'trayRecordingTemplate.png'
    : 'trayIconTemplate.png';
  tray?.setImage(nativeImage.createFromPath(assetPath(iconName)));
}

// --- Windows ---

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(rendererPath('index.html'));

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow?.hide();
  });
}

function showMainWindow(): void {
  if (!mainWindow) {
    createMainWindow();
  }
  mainWindow?.show();
  mainWindow?.focus();
}

function createAudioWindow(): void {
  audioWindow = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  audioWindow.loadFile(rendererPath('audio-capture.html'));

  // Pipe renderer console to main process
  audioWindow.webContents.on('console-message', (_e, _level, message) => {
    log(`[AudioRenderer] ${message}`);
  });

  audioWindow.webContents.on('did-finish-load', () => {
    log('[Main] Audio capture window loaded');
  });
}

// --- Overlay ---

function createOverlayWindow(): void {
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;
  const overlayWidth = 280;
  const overlayHeight = 56;

  overlayWindow = new BrowserWindow({
    width: overlayWidth,
    height: overlayHeight,
    x: Math.round((screenWidth - overlayWidth) / 2),
    y: screenHeight - overlayHeight - 40,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setVisibleOnAllWorkspaces(true);
  overlayWindow.loadFile(rendererPath('overlay.html'));
}

function showOverlay(): void {
  overlayWindow?.webContents.send('start-recording');
  overlayWindow?.showInactive();
}

function hideOverlay(): void {
  overlayWindow?.webContents.send('stop-recording');
  // Keep visible briefly to show "Transcribing..." state
  setTimeout(() => {
    overlayWindow?.hide();
  }, 500);
}

function hideOverlayNow(): void {
  overlayWindow?.hide();
}

// --- Permissions ---

function checkPermissions(): void {
  // Check API key
  if (!process.env.OPENAI_API_KEY) {
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'Missing API Key',
      message: 'OPENAI_API_KEY not found.',
      detail:
        'Create a .env file in the app directory with:\nOPENAI_API_KEY=sk-your-key-here',
    });
  }

  // Check Accessibility permission
  const isTrusted = systemPreferences.isTrustedAccessibilityClient(false);
  if (!isTrusted) {
    dialog
      .showMessageBox({
        type: 'warning',
        title: 'Accessibility Permission Required',
        message:
          'WhisperAlone needs Accessibility permission to detect the Command key and inject text.',
        detail:
          'Go to System Settings > Privacy & Security > Accessibility and add WhisperAlone.',
        buttons: ['Open System Settings', 'Later'],
      })
      .then(({ response }) => {
        if (response === 0) {
          systemPreferences.isTrustedAccessibilityClient(true);
        }
      });
  }

  // Check Microphone permission
  const micStatus = systemPreferences.getMediaAccessStatus('microphone');
  if (micStatus !== 'granted') {
    systemPreferences.askForMediaAccess('microphone');
  }
}

// --- Hotkey + IPC ---

function setupHotkey(): void {
  hotkey = new HotkeyManager();

  hotkey.on('recording-start', () => {
    log('[WhisperAlone] Recording started');
    setTrayRecording(true);
    showOverlay();
    audioWindow?.webContents.send('start-recording');
  });

  hotkey.on('recording-stop', () => {
    log('[WhisperAlone] Recording stopped, processing...');
    setTrayRecording(false);
    hideOverlay();
    audioWindow?.webContents.send('stop-recording');
  });

  hotkey.start();
}

function setupIPC(): void {
  ipcMain.on('audio-data', async (_event, data: number[]) => {
    log(`[WhisperAlone] Received audio-data IPC, data length: ${data?.length ?? 'null'}`);
    try {
      const buffer = Buffer.from(new Uint8Array(data));

      // Skip very short recordings (< ~0.5s of audio)
      if (buffer.length < 2000) {
        log(`[WhisperAlone] Recording too short (${buffer.length} bytes), skipping`);
        hotkey?.setIdle();
        return;
      }

      log(`[WhisperAlone] Transcribing ${buffer.length} bytes...`);
      const text = await transcribeAudio(buffer);

      if (text && text.length > 0) {
        log(`[WhisperAlone] Transcribed: "${text}"`);

        // Inject text at cursor
        await injectText(text);

        // Save to history
        addHistoryEntry(text, buffer.length);
        mainWindow?.webContents.send('history-update', getHistory());

      } else {
        log('[WhisperAlone] Empty transcription, skipping');
      }
    } catch (err) {
      logError('[WhisperAlone] Transcription error:', err);
      new Notification({
        title: 'WhisperAlone',
        body: 'Transcription failed. Check your API key and connection.',
      }).show();
    } finally {
      hideOverlayNow();
      hotkey?.setIdle();
    }
  });

  ipcMain.on('recording-error', (_event, message: string) => {
    logError('[WhisperAlone] Recording error:', message);
    setTrayRecording(false);
    hotkey?.setIdle();
    new Notification({
      title: 'WhisperAlone',
      body: `Recording failed: ${message}`,
    }).show();
  });

  ipcMain.handle('get-history', () => {
    return getHistory();
  });
}

// --- App Lifecycle ---

app.whenReady().then(() => {
  // Hide dock icon — tray-only app
  app.dock?.hide();

  createTray();
  createMainWindow();
  createAudioWindow();
  createOverlayWindow();
  checkPermissions();
  setupIPC();
  setupHotkey();

  log('[WhisperAlone] Ready. Double-tap ⌘ Command to start recording.');
  log(`[WhisperAlone] OPENAI_API_KEY set: ${!!process.env.OPENAI_API_KEY}`);
});

app.on('window-all-closed', () => {
  // Prevent app from quitting when windows close — tray app stays alive
  // Do nothing — tray app stays alive
});

app.on('before-quit', () => {
  hotkey?.stop();
  // Allow windows to actually close on quit
  mainWindow?.removeAllListeners('close');
  mainWindow?.close();
  audioWindow?.close();
  overlayWindow?.close();
});

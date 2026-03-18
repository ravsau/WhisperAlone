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
  clipboard,
} from 'electron';
import path from 'path';
import dotenv from 'dotenv';
import { HotkeyManager } from './hotkey';
import { transcribeAudio } from './transcriber';
import { injectText } from './injector';
import { addHistoryEntry, getHistory, getSettings, setSettings } from './store';
import { log, logError } from './logger';
import { startMLXServer, stopMLXServer, isMLXServerRunning, isFirstBoot } from './mlx-server';

import os from 'os';

// Load API key from user-level ~/.env
dotenv.config({ path: path.join(os.homedir(), '.env') });

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let audioWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;
let setupWindow: BrowserWindow | null = null;
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

const defaultWebPreferences = (): Electron.WebPreferences => ({
  preload: preloadPath(),
  contextIsolation: true,
  nodeIntegration: false,
});

// --- Setup Window ---

function createSetupWindow(): void {
  const display = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;
  const winWidth = 380;
  const winHeight = 300;

  setupWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: Math.round((screenWidth - winWidth) / 2),
    y: Math.round((screenHeight - winHeight) / 2),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    vibrancy: 'under-window',
    webPreferences: defaultWebPreferences(),
  });

  setupWindow.loadFile(rendererPath('setup.html'));
  setupWindow.once('ready-to-show', () => {
    setupWindow?.show();
  });
}

function sendSetupProgress(step: string, state: string, message: string): void {
  setupWindow?.webContents.send('setup-progress', { step, state, message });
}

function closeSetupWindow(delayMs = 2000): void {
  setTimeout(() => {
    setupWindow?.close();
    setupWindow = null;
  }, delayMs);
}

async function startMLXWithProgress(): Promise<void> {
  createSetupWindow();
  const ok = await startMLXServer(sendSetupProgress);
  rebuildTrayMenu();
  closeSetupWindow(ok ? 2000 : 5000);
}

// --- Tray ---

function pasteApiKeyFromClipboard(): void {
  const settings = getSettings();

  if (settings.openaiApiKey) {
    const btn = dialog.showMessageBoxSync({
      type: 'question',
      title: 'OpenAI API Key',
      message: 'A key is already saved.',
      buttons: ['Replace from Clipboard', 'Remove Key', 'Cancel'],
    });
    if (btn === 1) {
      setSettings({ openaiApiKey: '', backend: 'mlx' });
      rebuildTrayMenu();
      log('[Settings] OpenAI API key removed');
      new Notification({ title: 'WhisperAlone', body: 'API key removed. Using local transcription.' }).show();
      return;
    }
    if (btn !== 0) return;
  }

  const key = clipboard.readText().trim();

  if (!key) {
    dialog.showMessageBoxSync({
      type: 'info',
      title: 'Paste API Key',
      message: 'Copy your OpenAI key, then click this again.',
      detail: '1. Go to platform.openai.com/api-keys\n2. Copy your key\n3. Click "Paste API Key" again',
    });
    return;
  }

  if (!key.startsWith('sk-')) {
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'Invalid Key',
      message: 'Clipboard doesn\'t contain an OpenAI key.',
      detail: 'Expected a key starting with "sk-".',
    });
    return;
  }

  setSettings({ openaiApiKey: key });
  process.env.OPENAI_API_KEY = key;
  rebuildTrayMenu();
  log('[Settings] OpenAI API key saved from clipboard');
  new Notification({ title: 'WhisperAlone', body: 'API key saved! OpenAI Cloud is now available.' }).show();
}

function buildTrayMenu(): Menu {
  const settings = getSettings();
  const mlxRunning = isMLXServerRunning();
  const hasApiKey = !!(settings.openaiApiKey || process.env.OPENAI_API_KEY);

  // Show transient status only when server is loading
  const statusItems = (settings.backend === 'mlx' && !mlxRunning)
    ? [{ label: 'Starting...', enabled: false as const }, { type: 'separator' as const }]
    : [];

  return Menu.buildFromTemplate([
    ...statusItems,
    // Local: just Fast (turbo) -- the recommended default
    {
      label: 'Local  (on-device, ~0.7s)',
      type: 'radio' as const,
      checked: settings.backend === 'mlx',
      click: async () => {
        setSettings({ backend: 'mlx' });
        rebuildTrayMenu();
        log('[Settings] Switched to MLX local');
        if (!isMLXServerRunning()) {
          await startMLXWithProgress();
        }
      },
    },
    // OpenAI Cloud option
    ...(hasApiKey
      ? [{
          label: 'OpenAI Cloud',
          type: 'radio' as const,
          checked: settings.backend === 'openai',
          click: async () => {
            setSettings({ backend: 'openai' });
            await stopMLXServer();
            rebuildTrayMenu();
            log('[Settings] Switched to OpenAI backend');
          },
        }]
      : []),
    { type: 'separator' as const },
    {
      label: hasApiKey ? 'Change API Key...' : 'Paste API Key  (for OpenAI)',
      click: () => pasteApiKeyFromClipboard(),
    },
    { label: 'Show History', click: () => showMainWindow() },
    { type: 'separator' as const },
    { label: 'Quit WhisperAlone', click: () => app.quit() },
  ]);
}

function createTray(): void {
  const icon = nativeImage.createFromPath(assetPath('trayIconTemplate.png'));
  tray = new Tray(icon);
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip('WhisperAlone — Double-tap ⌘ to transcribe');
}

function rebuildTrayMenu(): void {
  tray?.setContextMenu(buildTrayMenu());
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
    webPreferences: defaultWebPreferences(),
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
    webPreferences: defaultWebPreferences(),
  });

  audioWindow.loadFile(rendererPath('audio-capture.html'));

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
    webPreferences: defaultWebPreferences(),
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
  setTimeout(() => {
    overlayWindow?.hide();
  }, 500);
}

function hideOverlayNow(): void {
  overlayWindow?.hide();
}

// --- Permissions ---

function checkPermissions(): void {
  // Load stored API key into process.env for OpenAI SDK
  const settings = getSettings();
  if (settings.openaiApiKey) {
    process.env.OPENAI_API_KEY = settings.openaiApiKey;
  }

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

      if (buffer.length < 2000) {
        log(`[WhisperAlone] Recording too short (${buffer.length} bytes), skipping`);
        hotkey?.setIdle();
        return;
      }

      log(`[WhisperAlone] Transcribing ${buffer.length} bytes...`);
      const text = await transcribeAudio(buffer);

      if (text && text.length > 0) {
        log(`[WhisperAlone] Transcribed: "${text}"`);
        await injectText(text);
        addHistoryEntry(text, buffer.length);
        mainWindow?.webContents.send('history-update', getHistory());
      } else {
        log('[WhisperAlone] Empty transcription, skipping');
      }
    } catch (err) {
      logError('[WhisperAlone] Transcription error:', err);
      const settings = getSettings();
      const detail = settings.backend === 'mlx'
        ? 'MLX server may have stopped. Try switching to OpenAI or restart the app.'
        : 'Check your API key and connection.';
      new Notification({
        title: 'WhisperAlone',
        body: `Transcription failed. ${detail}`,
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

  ipcMain.handle('get-history', () => getHistory());
  ipcMain.handle('get-settings', () => getSettings());
  ipcMain.handle('set-settings', (_event, input: Record<string, unknown>) => {
    const safe: Record<string, unknown> = {};
    if (input.backend === 'openai' || input.backend === 'mlx') safe.backend = input.backend;
    if (typeof input.mlxModel === 'string') safe.mlxModel = input.mlxModel;
    if (typeof input.openaiApiKey === 'string') safe.openaiApiKey = input.openaiApiKey;
    const updated = setSettings(safe);
    rebuildTrayMenu();
    return updated;
  });
  ipcMain.handle('get-mlx-models', () => {
    const { MLX_MODELS } = require('./transcriber');
    return MLX_MODELS;
  });
}

// --- App Lifecycle ---

app.whenReady().then(async () => {
  app.dock?.hide();

  createTray();
  createMainWindow();
  createAudioWindow();
  createOverlayWindow();
  checkPermissions();
  setupIPC();
  setupHotkey();

  const settings = getSettings();
  const firstBoot = isFirstBoot();

  log('[WhisperAlone] Ready. Double-tap ⌘ Command to start recording.');
  log(`[WhisperAlone] Backend: ${settings.backend}, MLX Model: ${settings.mlxModel}, First boot: ${firstBoot}`);
  log(`[WhisperAlone] OPENAI_API_KEY set: ${!!process.env.OPENAI_API_KEY}`);

  // First boot: default to MLX and auto-setup with progress window
  if (firstBoot) {
    log('[WhisperAlone] First boot — setting up MLX local transcription...');
    setSettings({ backend: 'mlx' });
    rebuildTrayMenu();
  }

  if (settings.backend === 'mlx' || firstBoot) {
    await startMLXWithProgress();
  }
});

app.on('window-all-closed', () => {
  // tray app stays alive
});

app.on('before-quit', async () => {
  hotkey?.stop();
  await stopMLXServer();
  mainWindow?.removeAllListeners('close');
  mainWindow?.close();
  audioWindow?.close();
  overlayWindow?.close();
  setupWindow?.close();
});

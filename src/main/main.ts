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
import {
  startMLXServer, stopMLXServer, isMLXServerRunning, isFirstBoot, setServerCrashHandler,
  startStreamingSession, sendStreamChunk, finishStreamingSession, isStreamingActive,
} from './mlx-server';
import {
  routeTranscription, exportTodayHistory, exportAllHistory, generateDailyDigest,
  isMLXLLMAvailable, openNotesFolder,
} from './voice-router';

import os from 'os';

// Load API key from user-level ~/.env
dotenv.config({ path: path.join(os.homedir(), '.env') });

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let audioWindow: BrowserWindow | null = null;
let overlayWindows: Array<{ displayId: number; window: BrowserWindow }> = [];
let setupWindow: BrowserWindow | null = null;
let hotkey: HotkeyManager | null = null;
let overlayState: 'hidden' | 'recording' | 'processing' = 'hidden';
let overlayHideTimeout: NodeJS.Timeout | null = null;
let overlaySyncTimeout: NodeJS.Timeout | null = null;

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

let apiKeyWindow: BrowserWindow | null = null;

function showApiKeyPrompt(): void {
  const settings = getSettings();

  if (settings.openaiApiKey) {
    const btn = dialog.showMessageBoxSync({
      type: 'question',
      title: 'OpenAI API Key',
      message: 'A key is already saved.',
      buttons: ['Enter New Key', 'Remove Key', 'Cancel'],
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

  if (apiKeyWindow && !apiKeyWindow.isDestroyed()) {
    apiKeyWindow.focus();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = display.workAreaSize;
  const winW = 420;
  const winH = 160;

  apiKeyWindow = new BrowserWindow({
    width: winW,
    height: winH,
    x: Math.round((sw - winW) / 2),
    y: Math.round((sh - winH) / 2),
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    title: 'Enter OpenAI API Key',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: preloadPath() },
  });

  apiKeyWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: -apple-system, sans-serif; padding: 20px; background: #1e1e1e; color: #e0e0e0; }
  input { width: 100%; padding: 10px; font-size: 14px; border: 1px solid #555; border-radius: 6px;
    background: #2d2d2d; color: #e0e0e0; box-sizing: border-box; margin-bottom: 12px; }
  input:focus { outline: none; border-color: #007aff; }
  .buttons { display: flex; gap: 8px; justify-content: flex-end; }
  button { padding: 8px 20px; border-radius: 6px; border: none; font-size: 14px; cursor: pointer; }
  .save { background: #007aff; color: white; }
  .cancel { background: #3a3a3a; color: #e0e0e0; }
  .error { color: #ff6b6b; font-size: 12px; margin-bottom: 8px; display: none; }
</style>
</head>
<body>
  <input id="key" type="password" placeholder="sk-..." autofocus />
  <div class="error" id="err">Key must start with "sk-"</div>
  <div class="buttons">
    <button class="cancel" onclick="window.close()">Cancel</button>
    <button class="save" id="save">Save</button>
  </div>
  <script>
    const input = document.getElementById('key');
    const err = document.getElementById('err');
    document.getElementById('save').onclick = () => {
      const val = input.value.trim();
      if (!val.startsWith('sk-')) { err.style.display = 'block'; return; }
      // Post the key back via title change (no IPC needed for this simple case)
      document.title = 'APIKEY:' + val;
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('save').click();
      if (e.key === 'Escape') window.close();
    });
  </script>
</body>
</html>
  `)}`);

  apiKeyWindow.webContents.on('page-title-updated', (_event, title) => {
    if (title.startsWith('APIKEY:')) {
      const key = title.slice(7);
      setSettings({ openaiApiKey: key });
      process.env.OPENAI_API_KEY = key;
      rebuildTrayMenu();
      log('[Settings] OpenAI API key saved');
      new Notification({ title: 'WhisperAlone', body: 'API key saved! OpenAI Cloud is now available.' }).show();
      apiKeyWindow?.close();
      apiKeyWindow = null;
    }
  });

  apiKeyWindow.on('closed', () => { apiKeyWindow = null; });
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
      click: () => showApiKeyPrompt(),
    },
    { label: 'Show History', click: () => showMainWindow() },
    { type: 'separator' as const },
    {
      label: 'Voice Modes: say "journal:", "todo:", or "note:"',
      enabled: false as const,
    },
    {
      label: 'Export Today\'s History...',
      click: () => {
        const file = exportTodayHistory();
        if (file) {
          new Notification({ title: 'WhisperAlone', body: `Exported to ${file}` }).show();
        } else {
          new Notification({ title: 'WhisperAlone', body: 'No transcriptions today.' }).show();
        }
      },
    },
    {
      label: 'Export All Transcripts...',
      click: () => {
        const file = exportAllHistory();
        if (file) {
          new Notification({ title: 'WhisperAlone', body: `Exported ${file}` }).show();
        } else {
          new Notification({ title: 'WhisperAlone', body: 'No transcription history.' }).show();
        }
      },
    },
    {
      label: 'Summarize My Day',
      click: async () => {
        if (!isMLXLLMAvailable()) {
          dialog.showMessageBoxSync({
            type: 'info',
            title: 'MLX Server Not Running',
            message: 'The local server needs to be running for summaries.',
            detail: 'Switch to Local mode and try again.',
          });
          return;
        }
        new Notification({ title: 'WhisperAlone', body: 'Generating daily summary (first time downloads ~900MB model)...' }).show();
        const digest = await generateDailyDigest();
        if (digest) {
          new Notification({ title: 'WhisperAlone', body: 'Summary saved to journal.' }).show();
        } else {
          new Notification({ title: 'WhisperAlone', body: 'No transcriptions today or summary failed.' }).show();
        }
      },
    },
    {
      label: 'Open Notes Folder',
      click: () => openNotesFolder(),
    },
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
    // Hide dock icon when no windows are visible (back to tray-only)
    app.dock?.hide();
  });
}

function showMainWindow(): void {
  if (!mainWindow) {
    createMainWindow();
  }
  // Show dock icon so the app menu bar appears
  app.dock?.show();
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

const OVERLAY_STRIP_HEIGHT = 120;

function getOverlayBounds(display: Electron.Display): Electron.Rectangle {
  const { x, y, width, height } = display.workArea;
  return {
    x,
    y: Math.round(y + height - OVERLAY_STRIP_HEIGHT),
    width,
    height: Math.min(OVERLAY_STRIP_HEIGHT, height),
  };
}

function positionOverlayWindow(win: BrowserWindow, display: Electron.Display): void {
  win.setBounds(getOverlayBounds(display), false);
}

function clearOverlayHideTimeout(): void {
  if (overlayHideTimeout) {
    clearTimeout(overlayHideTimeout);
    overlayHideTimeout = null;
  }
}

function applyOverlayStateToWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;

  if (overlayState === 'hidden') {
    win.hide();
    return;
  }

  if (!win.webContents.isLoadingMainFrame()) {
    win.webContents.send(
      overlayState === 'recording' ? 'start-recording' : 'stop-recording',
    );
  }

  win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'floating');
  win.showInactive();
}

function applyOverlayStateToAllWindows(): void {
  for (const { window } of overlayWindows) {
    applyOverlayStateToWindow(window);
  }
}

function createOverlayForDisplay(display: Electron.Display): BrowserWindow {
  const win = new BrowserWindow({
    ...getOverlayBounds(display),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    fullscreenable: false,
    hasShadow: false,
    paintWhenInitiallyHidden: true,
    webPreferences: defaultWebPreferences(),
  });

  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'floating');
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });
  if (process.platform === 'darwin') {
    win.setHiddenInMissionControl(true);
  }
  win.loadFile(rendererPath('overlay.html'));
  win.webContents.on('did-finish-load', () => {
    applyOverlayStateToWindow(win);
  });
  return win;
}

function createOverlayWindows(): void {
  // Close any existing overlays
  for (const { window } of overlayWindows) {
    if (!window.isDestroyed()) window.close();
  }
  overlayWindows = [];

  // Create one overlay per display
  const displays = screen.getAllDisplays();
  for (const display of displays) {
    overlayWindows.push({
      displayId: display.id,
      window: createOverlayForDisplay(display),
    });
  }
  const displaySummary = displays
    .map(({ id, bounds, workArea }) => `${id}: bounds=${bounds.width}x${bounds.height}@${bounds.x},${bounds.y} workArea=${workArea.width}x${workArea.height}@${workArea.x},${workArea.y}`)
    .join(' | ');
  log(`[Main] Created ${overlayWindows.length} overlay(s) for ${displays.length} display(s)${displaySummary ? ` [${displaySummary}]` : ''}`);
}

function syncOverlayWindows(): void {
  const displays = screen.getAllDisplays();
  const displayMap = new Map(displays.map((display) => [display.id, display]));
  const nextOverlayWindows: Array<{ displayId: number; window: BrowserWindow }> = [];
  const currentWindows = new Map(overlayWindows.map((entry) => [entry.displayId, entry.window]));

  for (const [displayId, window] of currentWindows) {
    if (window.isDestroyed()) {
      currentWindows.delete(displayId);
    }
  }

  for (const [displayId, window] of currentWindows) {
    if (!displayMap.has(displayId) && !window.isDestroyed()) {
      window.close();
    }
  }

  for (const display of displays) {
    const existingWindow = currentWindows.get(display.id);
    const window = existingWindow && !existingWindow.isDestroyed()
      ? existingWindow
      : createOverlayForDisplay(display);

    positionOverlayWindow(window, display);
    window.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'floating');
    nextOverlayWindows.push({ displayId: display.id, window });
  }

  overlayWindows = nextOverlayWindows;
}

function scheduleOverlaySync(): void {
  if (overlaySyncTimeout) {
    clearTimeout(overlaySyncTimeout);
  }

  overlaySyncTimeout = setTimeout(() => {
    overlaySyncTimeout = null;
    syncOverlayWindows();
    applyOverlayStateToAllWindows();
  }, 100);
}

function logOverlayDisplays(): void {
  const displays = screen.getAllDisplays();
  const displaySummary = displays
    .map(({ id, bounds, workArea }) => `${id}: bounds=${bounds.width}x${bounds.height}@${bounds.x},${bounds.y} workArea=${workArea.width}x${workArea.height}@${workArea.x},${workArea.y}`)
    .join(' | ');
  log(`[Main] Synced ${overlayWindows.length} overlay(s) across ${displays.length} display(s)${displaySummary ? ` [${displaySummary}]` : ''}`);
}

function refreshOverlayWindows(): void {
  const beforeCount = overlayWindows.length;
  syncOverlayWindows();

  if (overlayWindows.length !== beforeCount) {
    logOverlayDisplays();
  } else {
    const recreated = overlayWindows.some(({ window }) => window.isDestroyed());
    if (recreated) {
      logOverlayDisplays();
    }
  }
}

function showOverlay(): void {
  clearOverlayHideTimeout();
  overlayState = 'recording';
  refreshOverlayWindows();
  applyOverlayStateToAllWindows();
}

function hideOverlay(): void {
  clearOverlayHideTimeout();
  overlayState = 'processing';
  refreshOverlayWindows();
  applyOverlayStateToAllWindows();
  overlayHideTimeout = setTimeout(() => {
    if (overlayState !== 'processing') return;
    overlayState = 'hidden';
    applyOverlayStateToAllWindows();
    overlayHideTimeout = null;
  }, 500);
}

function hideOverlayNow(): void {
  clearOverlayHideTimeout();
  overlayState = 'hidden';
  applyOverlayStateToAllWindows();
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

  hotkey.on('recording-start', async () => {
    log('[WhisperAlone] Recording started');
    setTrayRecording(true);
    showOverlay();

    // Start streaming session so audio chunks are forwarded to the server in real-time
    const settings = getSettings();
    if (settings.backend === 'mlx' && isMLXServerRunning()) {
      const ok = await startStreamingSession(settings.mlxModel);
      if (ok) {
        log('[WhisperAlone] Streaming session started — chunks will be forwarded');
      }
    }

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
  // Forward audio chunks to the MLX streaming server in real-time
  ipcMain.on('audio-chunk', (_event, data: number[]) => {
    if (isStreamingActive()) {
      const chunk = Buffer.from(new Uint8Array(data));
      sendStreamChunk(chunk);
    }
  });

  ipcMain.on('audio-data', async (_event, data: number[]) => {
    log(`[WhisperAlone] Received audio-data IPC, data length: ${data?.length ?? 'null'}`);
    try {
      const buffer = Buffer.from(new Uint8Array(data));
      const settings = getSettings();
      let text: string;

      // If streaming session is active and we got empty data, finish via streaming
      if (isStreamingActive() && buffer.length === 0) {
        log('[WhisperAlone] Finishing streaming transcription...');
        text = await finishStreamingSession();
      } else if (buffer.length < 2000) {
        log(`[WhisperAlone] Recording too short (${buffer.length} bytes), skipping`);
        hotkey?.setIdle();
        return;
      } else {
        // Fallback: batch transcription
        log(`[WhisperAlone] Transcribing ${buffer.length} bytes (batch)...`);
        text = await transcribeAudio(buffer);
      }

      if (text && text.length > 0) {
        log(`[WhisperAlone] Transcribed: "${text}"`);

        // Check for voice mode prefixes (journal:, todo:, note:)
        const route = routeTranscription(text);
        if (route.action === 'paste') {
          await injectText(text);
        } else {
          log(`[WhisperAlone] Routed to ${route.destination}`);
        }

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
  // Set up macOS application menu (shows in menu bar with Cmd+Q support)
  const appMenu = Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Show History', click: () => showMainWindow() },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
  ]);
  Menu.setApplicationMenu(appMenu);

  createTray();
  createMainWindow();
  createAudioWindow();
  createOverlayWindows();
  screen.on('display-added', () => scheduleOverlaySync());
  screen.on('display-removed', () => scheduleOverlaySync());
  screen.on('display-metrics-changed', () => scheduleOverlaySync());
  checkPermissions();
  setupIPC();
  setupHotkey();
  setServerCrashHandler(() => rebuildTrayMenu());

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
  for (const { window } of overlayWindows) {
    if (!window.isDestroyed()) window.close();
  }
  setupWindow?.close();
});

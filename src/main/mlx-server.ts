import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { app, dialog } from 'electron';
import { log, logError } from './logger';

const MLX_SERVER_PORT = 18456;
const VENV_DIR = path.join(app.getPath('userData'), 'mlx-venv');
const VENV_PYTHON = path.join(VENV_DIR, 'bin', 'python3');
const SETUP_DONE_FLAG = path.join(app.getPath('userData'), '.mlx-setup-done');

// Packaged apps don't inherit shell PATH — add common Python locations
const EXTRA_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  path.join(VENV_DIR, 'bin'),
];

// Computed once at module load
const ENHANCED_PATH = (() => {
  const existing = process.env.PATH || '';
  return [...new Set([...EXTRA_PATHS, ...existing.split(':')])].join(':');
})();

function getSpawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: ENHANCED_PATH };
}

function findPython3(): string {
  // Check common locations explicitly
  const candidates = [
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Fallback to PATH lookup
  return 'python3';
}

let serverProcess: ChildProcess | null = null;
let serverReady = false;
let setupInProgress = false;

export type ProgressCallback = (step: string, state: string, message: string) => void;

function getServerScriptPath(): string {
  // In dev mode, use the script directly
  const devPath = path.join(__dirname, '../../scripts/mlx-server.py');
  if (fs.existsSync(devPath) && !devPath.includes('.asar')) return devPath;

  // In packaged app, scripts are inside app.asar which Python can't read.
  // Extract to userData so Python can access them.
  const extractDir = path.join(app.getPath('userData'), 'scripts');
  const extractedPath = path.join(extractDir, 'mlx-server.py');

  try {
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }

    // Always overwrite to pick up updates
    const asarPath = path.join(__dirname, '../../scripts/mlx-server.py');
    const content = fs.readFileSync(asarPath, 'utf-8');
    fs.writeFileSync(extractedPath, content, { mode: 0o755 });
    log(`[MLX-Server] Extracted server script to ${extractedPath}`);
  } catch (err) {
    logError('[MLX-Server] Failed to extract server script:', err);
  }

  return extractedPath;
}

// --- First boot detection ---

export function isFirstBoot(): boolean {
  return !fs.existsSync(SETUP_DONE_FLAG);
}

function markSetupDone(): void {
  try {
    fs.writeFileSync(SETUP_DONE_FLAG, new Date().toISOString());
  } catch {}
}

// --- Venv Setup ---

function venvExists(): boolean {
  return fs.existsSync(VENV_PYTHON);
}

async function runCommand(cmd: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`[MLX-Setup] ${label}: ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: getSpawnEnv(),
    });

    let stderr = '';
    proc.stdout?.on('data', (d) => log(`[MLX-Setup] ${d.toString().trim()}`));
    proc.stderr?.on('data', (d) => {
      const line = d.toString().trim();
      stderr += line + '\n';
      if (!line.includes('━') && !line.includes('%')) {
        log(`[MLX-Setup] ${line}`);
      }
    });

    proc.on('close', (code) => {
      if (code === 0) {
        log(`[MLX-Setup] ${label} completed`);
        resolve();
      } else {
        reject(new Error(`${label} failed (exit ${code}): ${stderr.slice(-500)}`));
      }
    });

    proc.on('error', (err) => reject(err));
  });
}

export async function ensureMLXSetup(onProgress?: ProgressCallback): Promise<boolean> {
  if (setupInProgress) {
    log('[MLX-Setup] Setup already in progress');
    return false;
  }
  setupInProgress = true;

  try {
    // Step 1: Create venv
    if (!venvExists()) {
      onProgress?.('venv', 'active', 'Creating Python environment...');
      const python = findPython3();
      log(`[MLX-Setup] Using Python: ${python}`);
      await runCommand(python, ['-m', 'venv', VENV_DIR], 'Create venv');
    }
    onProgress?.('venv', 'done', 'Python environment ready');

    // Step 2: Install mlx-whisper
    onProgress?.('install', 'active', 'Installing MLX Whisper (this may take a minute)...');
    await runCommand(
      VENV_PYTHON,
      ['-m', 'pip', 'install', '--quiet', 'mlx-whisper'],
      'Install mlx-whisper'
    );
    onProgress?.('install', 'done', 'MLX Whisper installed');

    markSetupDone();
    log('[MLX-Setup] MLX Whisper setup complete');
    return true;
  } catch (err) {
    logError('[MLX-Setup] Setup failed:', err);
    onProgress?.('error', 'error', `Setup failed: ${(err as Error).message}`);
    return false;
  } finally {
    setupInProgress = false;
  }
}

// --- Server Lifecycle ---

export async function startMLXServer(onProgress?: ProgressCallback): Promise<boolean> {
  if (serverProcess && serverReady) {
    log('[MLX-Server] Already running');
    return true;
  }

  await stopMLXServer();

  const setupOk = await ensureMLXSetup(onProgress);

  if (!setupOk) {
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'MLX Setup Failed',
      message: 'Could not set up MLX Whisper.',
      detail: 'Make sure Python 3 is installed on your system.\nYou can install it with: brew install python3',
    });
    return false;
  }

  // Step 3: Start server
  onProgress?.('server', 'active', 'Starting local transcription server...');

  return new Promise((resolve) => {
    const scriptPath = getServerScriptPath();
    log(`[MLX-Server] Starting: ${VENV_PYTHON} ${scriptPath} ${MLX_SERVER_PORT}`);

    serverProcess = spawn(VENV_PYTHON, [scriptPath, String(MLX_SERVER_PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: getSpawnEnv(),
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        logError('[MLX-Server] Startup timed out after 30s');
        onProgress?.('server', 'error', 'Server startup timed out');
        resolve(false);
      }
    }, 30000);

    serverProcess.stdout?.on('data', (data) => {
      const line = data.toString().trim();
      log(`[MLX-Server] stdout: ${line}`);
      if (line.includes('MLX_SERVER_READY') && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        serverReady = true;
        log('[MLX-Server] Server is ready');
        onProgress?.('server', 'done', 'Server started');
        onProgress?.('done', 'done', 'WhisperAlone is ready! Double-tap ⌘ to transcribe.');
        resolve(true);
      }
    });

    serverProcess.stderr?.on('data', (data) => {
      log(`[MLX-Server] ${data.toString().trim()}`);
    });

    serverProcess.on('close', (code) => {
      log(`[MLX-Server] Process exited with code ${code}`);
      serverProcess = null;
      serverReady = false;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        onProgress?.('server', 'error', 'Server stopped unexpectedly');
        resolve(false);
      }
    });

    serverProcess.on('error', (err) => {
      logError('[MLX-Server] Process error:', err);
      serverProcess = null;
      serverReady = false;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        onProgress?.('server', 'error', `Server error: ${err.message}`);
        resolve(false);
      }
    });
  });
}

export async function stopMLXServer(): Promise<void> {
  if (!serverProcess) {
    serverReady = false;
    return;
  }

  log('[MLX-Server] Stopping server...');

  try {
    await httpPost('/shutdown', Buffer.alloc(0), {});
  } catch {
    // Server might already be down
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (serverProcess) {
        serverProcess.kill('SIGKILL');
        serverProcess = null;
      }
      resolve();
    }, 3000);

    if (serverProcess) {
      serverProcess.once('close', () => {
        clearTimeout(timeout);
        serverProcess = null;
        resolve();
      });
      serverProcess.kill('SIGTERM');
    } else {
      clearTimeout(timeout);
      resolve();
    }
  });

  serverReady = false;
  log('[MLX-Server] Stopped');
}

export function isMLXServerRunning(): boolean {
  return serverReady && serverProcess !== null;
}

// --- HTTP Client ---

function httpPost(urlPath: string, body: Buffer, headers: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: MLX_SERVER_PORT,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Length': body.length,
          ...headers,
        },
        timeout: 120000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(data);
          }
        });
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.write(body);
    req.end();
  });
}

export async function transcribeViaServer(audioBuffer: Buffer, modelName: string): Promise<string> {
  if (!serverReady) {
    throw new Error('MLX server is not running. Restart the app or switch to OpenAI.');
  }

  const boundary = `----WhisperAlone${Date.now()}`;
  const parts: Buffer[] = [];

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `${modelName}\r\n`
  ));

  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="recording.webm"\r\n` +
    `Content-Type: audio/webm\r\n\r\n`
  ));
  parts.push(audioBuffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const result = await httpPost('/transcribe', body, {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  });

  if (result.error) {
    throw new Error(`MLX transcription failed: ${result.error}`);
  }

  return result.text || '';
}

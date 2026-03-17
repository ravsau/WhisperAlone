import { ChildProcess, spawn, execFile } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import http from 'http';
import { app, dialog, Notification } from 'electron';
import { log, logError } from './logger';

const MLX_SERVER_PORT = 18456;
const VENV_DIR = path.join(app.getPath('userData'), 'mlx-venv');
const VENV_PYTHON = path.join(VENV_DIR, 'bin', 'python3');

let serverProcess: ChildProcess | null = null;
let serverReady = false;
let setupInProgress = false;

function getServerScriptPath(): string {
  const devPath = path.join(__dirname, '../../scripts/mlx-server.py');
  if (fs.existsSync(devPath)) return devPath;
  return path.join(process.resourcesPath || __dirname, 'scripts/mlx-server.py');
}

// --- Venv Setup (auto-install mlx-whisper) ---

function venvExists(): boolean {
  return fs.existsSync(VENV_PYTHON);
}

function mlxInstalled(): boolean {
  if (!venvExists()) return false;
  try {
    const sitePackages = path.join(VENV_DIR, 'lib');
    if (!fs.existsSync(sitePackages)) return false;
    // Check if mlx_whisper is importable
    return true; // We'll verify at server start
  } catch {
    return false;
  }
}

async function runCommand(cmd: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`[MLX-Setup] ${label}: ${cmd} ${args.join(' ')}`);
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${path.join(VENV_DIR, 'bin')}:${process.env.PATH}` },
    });

    let stderr = '';
    proc.stdout?.on('data', (d) => log(`[MLX-Setup] ${d.toString().trim()}`));
    proc.stderr?.on('data', (d) => {
      const line = d.toString().trim();
      stderr += line + '\n';
      // Only log non-progress lines
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

export async function ensureMLXSetup(onProgress?: (msg: string) => void): Promise<boolean> {
  if (setupInProgress) {
    log('[MLX-Setup] Setup already in progress');
    return false;
  }
  setupInProgress = true;

  try {
    // Step 1: Create venv if needed
    if (!venvExists()) {
      const msg = 'Creating Python environment for MLX Whisper...';
      log(`[MLX-Setup] ${msg}`);
      onProgress?.(msg);

      await runCommand('python3', ['-m', 'venv', VENV_DIR], 'Create venv');
    }

    // Step 2: Install mlx-whisper if needed
    const msg = 'Installing mlx-whisper (first time only, this may take a minute)...';
    log(`[MLX-Setup] ${msg}`);
    onProgress?.(msg);

    // Always ensure mlx-whisper is present (pip handles no-op if already installed)
    await runCommand(VENV_PYTHON, ['-m', 'pip', 'install', '--quiet', 'mlx-whisper'], 'Install mlx-whisper');

    log('[MLX-Setup] MLX Whisper setup complete');
    onProgress?.('MLX Whisper ready!');
    return true;
  } catch (err) {
    logError('[MLX-Setup] Setup failed:', err);
    onProgress?.(`Setup failed: ${(err as Error).message}`);
    return false;
  } finally {
    setupInProgress = false;
  }
}

// --- Server Lifecycle ---

export async function startMLXServer(): Promise<boolean> {
  if (serverProcess && serverReady) {
    log('[MLX-Server] Already running');
    return true;
  }

  // Kill any stale process
  await stopMLXServer();

  // Ensure venv + mlx-whisper installed
  const setupOk = await ensureMLXSetup((msg) => {
    new Notification({
      title: 'WhisperAlone',
      body: msg,
    }).show();
  });

  if (!setupOk) {
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'MLX Setup Failed',
      message: 'Could not set up MLX Whisper.',
      detail: 'Make sure Python 3 is installed on your system.\nYou can install it with: brew install python3',
    });
    return false;
  }

  // Start the server
  return new Promise((resolve) => {
    const scriptPath = getServerScriptPath();
    log(`[MLX-Server] Starting: ${VENV_PYTHON} ${scriptPath} ${MLX_SERVER_PORT}`);

    serverProcess = spawn(VENV_PYTHON, [scriptPath, String(MLX_SERVER_PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${path.join(VENV_DIR, 'bin')}:${process.env.PATH}`,
      },
    });

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        logError('[MLX-Server] Startup timed out after 30s');
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

  // Try graceful shutdown via HTTP
  try {
    await httpPost('/shutdown', Buffer.alloc(0), {});
  } catch {
    // Server might already be down
  }

  // Give it a moment, then force kill
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

  // Build multipart form data
  const boundary = `----WhisperAlone${Date.now()}`;
  const parts: Buffer[] = [];

  // Model field
  parts.push(Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="model"\r\n\r\n` +
    `${modelName}\r\n`
  ));

  // File field
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

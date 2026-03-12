import fs from 'fs';
import path from 'path';
import os from 'os';

const LOG_DIR = path.join(os.homedir(), 'Library/Application Support/whisper-alone');
const LOG_FILE = path.join(LOG_DIR, 'WhisperAlone.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

let dirEnsured = false;
let stream: fs.WriteStream | null = null;

function init(): void {
  if (stream) return;

  if (!dirEnsured) {
    try {
      if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
      }
      dirEnsured = true;
    } catch {
      return;
    }
  }

  // Rotate if too large
  try {
    const stats = fs.statSync(LOG_FILE);
    if (stats.size > MAX_LOG_SIZE) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    }
  } catch {
    // File doesn't exist yet
  }

  stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
}

export function log(message: string): void {
  init();
  const line = `[${new Date().toISOString()}] ${message}\n`;
  stream?.write(line);
  console.log(message);
}

export function logError(message: string, err?: unknown): void {
  const errStr = err instanceof Error ? `${err.message}\n${err.stack}` : String(err ?? '');
  log(`ERROR: ${message} ${errStr}`);
}

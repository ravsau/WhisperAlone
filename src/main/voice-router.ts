import fs from 'fs';
import path from 'path';
import { app, Notification, shell } from 'electron';
import { log, logError } from './logger';
import { getHistory, TranscriptionEntry } from './store';
import { mlxGenerate, isMLXServerRunning } from './mlx-server';

const NOTES_DIR = path.join(app.getPath('home'), 'WhisperAlone');
const JOURNAL_DIR = path.join(NOTES_DIR, 'journal');
const TODOS_FILE = path.join(NOTES_DIR, 'todos.md');
const NOTES_SUBDIR = path.join(NOTES_DIR, 'notes');

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function timestamp(): string {
  return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function todayDateStr(): string {
  return new Date().toISOString().split('T')[0];
}

// --- Prefix Detection ---

interface RouteResult {
  action: 'paste' | 'routed';
  text: string;
  destination?: string;
}

const PREFIXES: Record<string, (text: string) => RouteResult> = {
  'journal': routeJournal,
  'todo': routeTodo,
  'note': routeNote,
};

export function routeTranscription(rawText: string): RouteResult {
  const lower = rawText.toLowerCase().trimStart();

  for (const [prefix, handler] of Object.entries(PREFIXES)) {
    // Match "journal: ...", "journal, ...", "journal ..." at the start
    const patterns = [
      new RegExp(`^${prefix}[:\\.,;]?\\s+`, 'i'),
      new RegExp(`^${prefix}$`, 'i'),
    ];

    for (const pattern of patterns) {
      if (pattern.test(lower)) {
        const stripped = rawText.replace(new RegExp(`^\\s*${prefix}[:\\.,;]?\\s*`, 'i'), '').trim();
        if (stripped.length === 0) continue;
        return handler(stripped);
      }
    }
  }

  // No prefix matched — default paste behavior
  return { action: 'paste', text: rawText };
}

// --- Route Handlers ---

function routeJournal(text: string): RouteResult {
  ensureDir(JOURNAL_DIR);
  const file = path.join(JOURNAL_DIR, `${todayDateStr()}.md`);
  const entry = `## ${timestamp()}\n\n${text}\n\n---\n\n`;

  fs.appendFileSync(file, entry, 'utf-8');
  log(`[VoiceRouter] Journal entry saved to ${file}`);

  new Notification({
    title: 'WhisperAlone',
    body: `Journal: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`,
  }).show();

  return { action: 'routed', text, destination: file };
}

function routeTodo(text: string): RouteResult {
  ensureDir(NOTES_DIR);
  const entry = `- [ ] ${text}  *(${timestamp()}, ${todayDateStr()})*\n`;

  fs.appendFileSync(TODOS_FILE, entry, 'utf-8');
  log(`[VoiceRouter] Todo added to ${TODOS_FILE}`);

  new Notification({
    title: 'WhisperAlone',
    body: `Todo: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`,
  }).show();

  return { action: 'routed', text, destination: TODOS_FILE };
}

function routeNote(text: string): RouteResult {
  ensureDir(NOTES_SUBDIR);
  const slug = text.slice(0, 40).replace(/[^a-zA-Z0-9]+/g, '-').replace(/-+$/, '').toLowerCase();
  const file = path.join(NOTES_SUBDIR, `${todayDateStr()}-${slug}.md`);
  const content = `# Note — ${timestamp()}, ${todayDateStr()}\n\n${text}\n`;

  fs.writeFileSync(file, content, 'utf-8');
  log(`[VoiceRouter] Note saved to ${file}`);

  new Notification({
    title: 'WhisperAlone',
    body: `Note saved: "${text.slice(0, 60)}${text.length > 60 ? '...' : ''}"`,
  }).show();

  return { action: 'routed', text, destination: file };
}

// --- History Export ---

export function exportTodayHistory(): string | null {
  const history = getHistory();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const todayEntries = history.filter((e) => e.timestamp >= todayMs);

  if (todayEntries.length === 0) {
    return null;
  }

  ensureDir(JOURNAL_DIR);
  const file = path.join(JOURNAL_DIR, `${todayDateStr()}-history.md`);

  const lines = [`# WhisperAlone History — ${todayDateStr()}\n\n`];
  // Reverse so oldest is first
  for (const entry of [...todayEntries].reverse()) {
    const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    lines.push(`## ${time}\n\n${entry.text}\n\n---\n\n`);
  }

  fs.writeFileSync(file, lines.join(''), 'utf-8');
  log(`[VoiceRouter] Exported ${todayEntries.length} entries to ${file}`);
  return file;
}

export function exportAllHistory(): string | null {
  const history = getHistory();

  if (history.length === 0) {
    return null;
  }

  ensureDir(JOURNAL_DIR);
  const file = path.join(JOURNAL_DIR, `all-transcripts.md`);

  const lines = [`# WhisperAlone — All Transcripts\n\n`];
  lines.push(`*${history.length} entries*\n\n---\n\n`);

  let currentDate = '';
  for (const entry of [...history].reverse()) {
    const date = new Date(entry.timestamp);
    const dateStr = date.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    if (dateStr !== currentDate) {
      currentDate = dateStr;
      lines.push(`# ${dateStr}\n\n`);
    }

    lines.push(`**${time}**\n\n${entry.text}\n\n---\n\n`);
  }

  fs.writeFileSync(file, lines.join(''), 'utf-8');
  log(`[VoiceRouter] Exported all ${history.length} entries to ${file}`);
  return file;
}

// --- Daily Digest via MLX LLM ---

export async function generateDailyDigest(): Promise<string | null> {
  const history = getHistory();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const todayEntries = history.filter((e) => e.timestamp >= todayMs);

  if (todayEntries.length === 0) {
    return null;
  }

  const transcript = [...todayEntries].reverse().map((e) => {
    const time = new Date(e.timestamp).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    return `[${time}] ${e.text}`;
  }).join('\n\n');

  const prompt = `Here are voice transcriptions from today. Summarize the key themes, decisions, action items, and any important thoughts. Be concise and useful.\n\n${transcript}`;

  try {
    const result = await mlxGenerate(prompt);
    if (!result) return null;

    ensureDir(JOURNAL_DIR);
    const file = path.join(JOURNAL_DIR, `${todayDateStr()}.md`);
    const digestEntry = `## Daily Summary\n\n${result}\n\n---\n\n`;
    fs.appendFileSync(file, digestEntry, 'utf-8');
    log(`[VoiceRouter] Daily digest saved to ${file}`);

    return result;
  } catch (err) {
    logError('[VoiceRouter] Daily digest failed:', err);
    return null;
  }
}

export function isMLXLLMAvailable(): boolean {
  return isMLXServerRunning();
}

export function openNotesFolder(): void {
  ensureDir(NOTES_DIR);
  shell.openPath(NOTES_DIR);
}

export function getNotesDir(): string {
  return NOTES_DIR;
}

import { Conf } from 'electron-conf';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { log } from './logger';
import type { TranscriberBackend } from './transcriber';
import { cleanTranscript } from './transcript-cleaner';

export interface TranscriptionEntry {
  id: string;
  text: string;
  timestamp: number;
  duration: number;
  wordCount?: number;
  durationSource?: 'recorded' | 'estimated' | 'recovered';
}

export interface AppSettings {
  backend: TranscriberBackend;
  mlxModel: string;
  openaiApiKey: string;
}

export interface DailyUsageStats {
  sessions: number;
  words: number;
  dictationSeconds: number;
  trackedDictationSeconds?: number;
  trackedDictationSessions?: number;
}

export interface UsageStats {
  schemaVersion?: number;
  initializedFromHistory: boolean;
  totalSessions: number;
  totalWords: number;
  totalDictationSeconds: number;
  trackedDictationSeconds?: number;
  trackedDictationSessions?: number;
  firstRecordedAt: number | null;
  lastRecordedAt: number | null;
  daily: Record<string, DailyUsageStats>;
}

interface StoreSchema {
  history: TranscriptionEntry[];
  historyRecoveredFromLogs: boolean;
  historyRecoveryVersion: number;
  transcriptCleanupVersion: number;
  settings: AppSettings;
  usageStats: UsageStats;
}

const DEFAULT_SETTINGS: AppSettings = {
  backend: 'mlx',
  mlxModel: 'mlx-community/whisper-large-v3-turbo',
  openaiApiKey: '',
};

const MAX_DAILY_STATS_DAYS = 730;
const USAGE_STATS_SCHEMA_VERSION = 4;
const HISTORY_RECOVERY_VERSION = 2;
const TRANSCRIPT_CLEANUP_VERSION = 1;
const LOG_DIR = path.join(os.homedir(), 'Library/Application Support/whisper-alone');
const LOG_FILES = [
  path.join(LOG_DIR, 'WhisperAlone.log.old'),
  path.join(LOG_DIR, 'WhisperAlone.log'),
];
const MARKDOWN_HISTORY_DIR = path.join(os.homedir(), 'WhisperAlone', 'journal');
const ALL_TRANSCRIPTS_FILE = path.join(MARKDOWN_HISTORY_DIR, 'all-transcripts.md');
const LOG_HISTORY_DUPLICATE_WINDOW_MS = 5 * 60 * 1000;

function createDefaultUsageStats(): UsageStats {
  return {
    schemaVersion: USAGE_STATS_SCHEMA_VERSION,
    initializedFromHistory: false,
    totalSessions: 0,
    totalWords: 0,
    totalDictationSeconds: 0,
    trackedDictationSeconds: 0,
    trackedDictationSessions: 0,
    firstRecordedAt: null,
    lastRecordedAt: null,
    daily: {},
  };
}

const store = new Conf<StoreSchema>({
  defaults: {
    history: [],
    historyRecoveredFromLogs: false,
    historyRecoveryVersion: 0,
    transcriptCleanupVersion: 0,
    settings: DEFAULT_SETTINGS,
    usageStats: createDefaultUsageStats(),
  },
});

// --- History ---

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function dateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeUsageStats(stats: UsageStats | undefined): UsageStats {
  const defaults = createDefaultUsageStats();
  if (!stats) return defaults;

  return {
    schemaVersion: Number.isFinite(stats.schemaVersion) ? stats.schemaVersion : 1,
    initializedFromHistory: Boolean(stats.initializedFromHistory),
    totalSessions: Number.isFinite(stats.totalSessions) ? stats.totalSessions : 0,
    totalWords: Number.isFinite(stats.totalWords) ? stats.totalWords : 0,
    totalDictationSeconds: Number.isFinite(stats.totalDictationSeconds)
      ? stats.totalDictationSeconds
      : 0,
    trackedDictationSeconds: Number.isFinite(stats.trackedDictationSeconds)
      ? stats.trackedDictationSeconds
      : 0,
    trackedDictationSessions: Number.isFinite(stats.trackedDictationSessions)
      ? stats.trackedDictationSessions
      : 0,
    firstRecordedAt: typeof stats.firstRecordedAt === 'number' ? stats.firstRecordedAt : null,
    lastRecordedAt: typeof stats.lastRecordedAt === 'number' ? stats.lastRecordedAt : null,
    daily: stats.daily && typeof stats.daily === 'object' ? { ...stats.daily } : {},
  };
}

function pruneDailyStats(stats: UsageStats): void {
  const keys = Object.keys(stats.daily).sort();
  if (keys.length <= MAX_DAILY_STATS_DAYS) return;

  for (const key of keys.slice(0, keys.length - MAX_DAILY_STATS_DAYS)) {
    delete stats.daily[key];
  }
}

function addEntryToUsageStats(stats: UsageStats, entry: TranscriptionEntry): UsageStats {
  const words = entry.wordCount ?? countWords(entry.text);
  const duration = Number.isFinite(entry.duration) ? Math.max(0, entry.duration) : 0;
  const hasTrackedDuration = entry.durationSource === 'recorded';
  const day = dateKey(entry.timestamp);
  const dayStats = stats.daily[day] ?? {
    sessions: 0,
    words: 0,
    dictationSeconds: 0,
    trackedDictationSeconds: 0,
    trackedDictationSessions: 0,
  };

  stats.totalSessions += 1;
  stats.totalWords += words;
  stats.totalDictationSeconds += duration;
  if (hasTrackedDuration) {
    stats.trackedDictationSeconds = (stats.trackedDictationSeconds ?? 0) + duration;
    stats.trackedDictationSessions = (stats.trackedDictationSessions ?? 0) + 1;
  }
  stats.firstRecordedAt =
    stats.firstRecordedAt === null
      ? entry.timestamp
      : Math.min(stats.firstRecordedAt, entry.timestamp);
  stats.lastRecordedAt =
    stats.lastRecordedAt === null
      ? entry.timestamp
      : Math.max(stats.lastRecordedAt, entry.timestamp);
  stats.daily[day] = {
    sessions: dayStats.sessions + 1,
    words: dayStats.words + words,
    dictationSeconds: dayStats.dictationSeconds + duration,
    trackedDictationSeconds:
      (dayStats.trackedDictationSeconds ?? 0) + (hasTrackedDuration ? duration : 0),
    trackedDictationSessions:
      (dayStats.trackedDictationSessions ?? 0) + (hasTrackedDuration ? 1 : 0),
  };
  pruneDailyStats(stats);

  return stats;
}

function buildUsageStatsFromHistory(history: TranscriptionEntry[]): UsageStats {
  const stats = createDefaultUsageStats();
  stats.initializedFromHistory = true;

  for (const entry of history) {
    addEntryToUsageStats(stats, entry);
  }

  return stats;
}

function normalizedTranscriptKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function historyRecoveryDisabled(): boolean {
  return (
    process.env.WHISPERALONE_DISABLE_HISTORY_RECOVERY === '1' ||
    process.env.WHISPERALONE_DISABLE_LOG_RECOVERY === '1'
  );
}

function parseLocalTimestamp(dateInput: string, timeInput: string): number | null {
  const timeMatch = timeInput.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!timeMatch) return null;

  const parsedDate = new Date(`${dateInput.trim()} 12:00 PM`);
  if (Number.isNaN(parsedDate.getTime())) return null;

  let hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const meridiem = timeMatch[3].toUpperCase();

  if (meridiem === 'PM' && hour !== 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;

  return new Date(
    parsedDate.getFullYear(),
    parsedDate.getMonth(),
    parsedDate.getDate(),
    hour,
    minute,
    0,
    0
  ).getTime();
}

function createRecoveredEntry(
  text: string,
  timestamp: number,
  index: number,
  source: string
): TranscriptionEntry | null {
  const cleaned = cleanTranscript(text);
  if (!Number.isFinite(timestamp) || cleaned.rejected) return null;

  return {
    id: `${source}-${timestamp}-${index}`,
    text: cleaned.text,
    timestamp,
    duration: 0,
    wordCount: countWords(cleaned.text),
    durationSource: 'recovered',
  };
}

function readRecoveredLogEntries(): TranscriptionEntry[] {
  if (historyRecoveryDisabled()) {
    return [];
  }

  const entries: TranscriptionEntry[] = [];
  const seen = new Set<string>();

  for (const file of LOG_FILES) {
    let contents = '';
    try {
      contents = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\[([^\]]+)\] \[WhisperAlone\] Transcribed: "(.*)"$/);
      if (!match) continue;

      const timestamp = Date.parse(match[1]);
      const text = match[2].trim();
      if (!Number.isFinite(timestamp) || text.length === 0) continue;

      const exactKey = `${timestamp}\0${text}`;
      if (seen.has(exactKey)) continue;
      seen.add(exactKey);

      const entry = createRecoveredEntry(text, timestamp, entries.length, 'log');
      if (entry) entries.push(entry);
    }
  }

  return entries;
}

function readDailyMarkdownHistoryFile(file: string): TranscriptionEntry[] {
  let contents = '';
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const dateMatch = contents.match(/^# WhisperAlone History\s+[—-]\s+(\d{4}-\d{2}-\d{2})/m);
  if (!dateMatch) return [];

  const entries: TranscriptionEntry[] = [];
  for (const block of contents.split(/\n---\n/)) {
    const match = block.match(/^##\s+(.+?)\s*\n\n([\s\S]*)$/m);
    if (!match) continue;

    const timestamp = parseLocalTimestamp(dateMatch[1], match[1]);
    const entry = timestamp === null
      ? null
      : createRecoveredEntry(match[2], timestamp, entries.length, 'markdown-day');
    if (entry) entries.push(entry);
  }

  return entries;
}

function readAllTranscriptsMarkdownFile(file: string): TranscriptionEntry[] {
  let contents = '';
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const entries: TranscriptionEntry[] = [];
  let currentDate = '';

  for (const block of contents.split(/\n---\n/)) {
    const dateMatch = block.match(/^#\s+(.+?,\s+[A-Za-z]+\s+\d{1,2},\s+\d{4})\s*$/m);
    if (dateMatch) {
      currentDate = dateMatch[1].replace(/^.+?,\s+/, '');
    }

    if (!currentDate) continue;

    const entryMatch = block.match(/\*\*(.+?)\*\*\s*\n\n([\s\S]*)$/m);
    if (!entryMatch) continue;

    const timestamp = parseLocalTimestamp(currentDate, entryMatch[1]);
    const entry = timestamp === null
      ? null
      : createRecoveredEntry(entryMatch[2], timestamp, entries.length, 'markdown-all');
    if (entry) entries.push(entry);
  }

  return entries;
}

function readRecoveredMarkdownEntries(): TranscriptionEntry[] {
  if (historyRecoveryDisabled()) {
    return [];
  }

  const entries: TranscriptionEntry[] = [];

  try {
    for (const file of fs.readdirSync(MARKDOWN_HISTORY_DIR)) {
      if (/^\d{4}-\d{2}-\d{2}-history\.md$/.test(file)) {
        entries.push(...readDailyMarkdownHistoryFile(path.join(MARKDOWN_HISTORY_DIR, file)));
      }
    }
  } catch {
    // No exported markdown history exists yet.
  }

  entries.push(...readAllTranscriptsMarkdownFile(ALL_TRANSCRIPTS_FILE));
  return entries;
}

function dedupeRecoveredEntries(entries: TranscriptionEntry[]): TranscriptionEntry[] {
  const merged: TranscriptionEntry[] = [];
  for (const entry of entries.sort((a, b) => b.timestamp - a.timestamp)) {
    if (!merged.some((existing) => isDuplicateTranscript(existing, entry))) {
      merged.push(entry);
    }
  }

  return merged;
}

function readRecoveredHistoryEntries(): TranscriptionEntry[] {
  return dedupeRecoveredEntries([
    ...readRecoveredLogEntries(),
    ...readRecoveredMarkdownEntries(),
  ]);
}

function buildUsageStatsFromHistoryAndRecoveredSources(history: TranscriptionEntry[]): UsageStats {
  const recoveredEntries = readRecoveredHistoryEntries();
  if (recoveredEntries.length === 0) {
    return buildUsageStatsFromHistory(history);
  }

  const stats = createDefaultUsageStats();
  const recoveredTimesByText = new Map<string, number[]>();
  stats.initializedFromHistory = true;

  for (const entry of recoveredEntries) {
    addEntryToUsageStats(stats, entry);
    const key = normalizedTranscriptKey(entry.text);
    const times = recoveredTimesByText.get(key) ?? [];
    times.push(entry.timestamp);
    recoveredTimesByText.set(key, times);
  }

  for (const entry of history) {
    const matchingRecoveredTimes = recoveredTimesByText.get(normalizedTranscriptKey(entry.text)) ?? [];
    const foundInRecoveredSources = matchingRecoveredTimes.some(
      (timestamp) => Math.abs(timestamp - entry.timestamp) <= LOG_HISTORY_DUPLICATE_WINDOW_MS
    );

    if (!foundInRecoveredSources) {
      addEntryToUsageStats(stats, entry);
    }
  }

  return stats;
}

function isDuplicateTranscript(
  first: TranscriptionEntry,
  second: TranscriptionEntry
): boolean {
  return (
    normalizedTranscriptKey(first.text) === normalizedTranscriptKey(second.text) &&
    Math.abs(first.timestamp - second.timestamp) <= LOG_HISTORY_DUPLICATE_WINDOW_MS
  );
}

function recoverHistoryFromSourcesIfNeeded(): TranscriptionEntry[] {
  const history = store.get('history');
  if (store.get('historyRecoveryVersion') >= HISTORY_RECOVERY_VERSION) {
    return history;
  }

  const recoveredEntries = readRecoveredHistoryEntries();
  if (recoveredEntries.length === 0) {
    store.set('historyRecoveredFromLogs', true);
    store.set('historyRecoveryVersion', HISTORY_RECOVERY_VERSION);
    return history;
  }

  const merged = [...history];
  for (const recoveredEntry of recoveredEntries) {
    if (!merged.some((entry) => isDuplicateTranscript(entry, recoveredEntry))) {
      merged.push(recoveredEntry);
    }
  }

  merged.sort((a, b) => b.timestamp - a.timestamp);
  store.set('history', merged);
  store.set('historyRecoveredFromLogs', true);
  store.set('historyRecoveryVersion', HISTORY_RECOVERY_VERSION);
  log(`[Store] Recovered ${merged.length - history.length} history entries from logs/markdown exports`);

  return merged;
}

function cleanStoredHistoryIfNeeded(history: TranscriptionEntry[]): TranscriptionEntry[] {
  if (store.get('transcriptCleanupVersion') >= TRANSCRIPT_CLEANUP_VERSION) {
    return history;
  }

  let changedEntries = 0;
  let removedEntries = 0;
  const cleanedHistory: TranscriptionEntry[] = [];

  for (const entry of history) {
    const cleanup = cleanTranscript(entry.text);
    if (cleanup.rejected) {
      removedEntries += 1;
      continue;
    }

    if (cleanup.changed) changedEntries += 1;
    cleanedHistory.push({
      ...entry,
      text: cleanup.text,
      wordCount: countWords(cleanup.text),
    });
  }

  store.set('history', cleanedHistory);
  store.set('usageStats', buildUsageStatsFromHistory(cleanedHistory));
  store.set('transcriptCleanupVersion', TRANSCRIPT_CLEANUP_VERSION);
  log(
    `[Store] Transcript cleanup migrated ${changedEntries} entries and removed ` +
    `${removedEntries} loop-only entries`
  );
  return cleanedHistory;
}

function recordingDuration(
  audioSizeBytes: number,
  recordingDurationMs?: number
): { seconds: number; source: 'recorded' | 'estimated' } {
  if (typeof recordingDurationMs === 'number' && Number.isFinite(recordingDurationMs)) {
    return {
      seconds: Math.max(1, Math.round(recordingDurationMs / 1000)),
      source: 'recorded',
    };
  }

  return {
    // Rough estimate: webm/opus at ~32kbps ~= 4KB/sec
    seconds: Math.max(1, Math.round(audioSizeBytes / 4000)),
    source: 'estimated',
  };
}

export function addHistoryEntry(
  text: string,
  audioSizeBytes: number,
  recordingDurationMs?: number
): TranscriptionEntry {
  const wordCount = countWords(text);
  const duration = recordingDuration(audioSizeBytes, recordingDurationMs);
  const entry: TranscriptionEntry = {
    id: crypto.randomUUID(),
    text,
    timestamp: Date.now(),
    duration: duration.seconds,
    wordCount,
    durationSource: duration.source,
  };
  const usageStats = getUsageStats();

  const history = getHistory();
  history.unshift(entry);

  store.set('history', history);

  const updatedStats = addEntryToUsageStats(usageStats, entry);
  updatedStats.initializedFromHistory = true;
  store.set('usageStats', updatedStats);

  return entry;
}

export function getHistory(): TranscriptionEntry[] {
  return cleanStoredHistoryIfNeeded(recoverHistoryFromSourcesIfNeeded());
}

export function clearHistory(): void {
  store.set('history', []);
  store.set('historyRecoveredFromLogs', true);
  store.set('historyRecoveryVersion', HISTORY_RECOVERY_VERSION);
  store.set('transcriptCleanupVersion', TRANSCRIPT_CLEANUP_VERSION);
}

// --- Usage Stats ---

export function getUsageStats(): UsageStats {
  const stats = normalizeUsageStats(store.get('usageStats'));
  if (stats.initializedFromHistory && stats.schemaVersion === USAGE_STATS_SCHEMA_VERSION) {
    return stats;
  }

  const initialized = buildUsageStatsFromHistoryAndRecoveredSources(getHistory());
  log(`[Store] Rebuilt usage stats schema ${USAGE_STATS_SCHEMA_VERSION}: ${initialized.totalSessions} sessions, ${initialized.totalWords} words`);
  store.set('usageStats', initialized);
  return initialized;
}

// --- Settings ---

export function getSettings(): AppSettings {
  return store.get('settings') || DEFAULT_SETTINGS;
}

export function setSettings(settings: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const updated = { ...current, ...settings };
  store.set('settings', updated);
  return updated;
}

const historyList = document.getElementById('history-list')!;
const emptyState = document.getElementById('empty-state')!;
const historyCount = document.getElementById('history-count')!;
const lastUsed = document.getElementById('last-used')!;
const statTotalWords = document.getElementById('stat-total-words')!;
const statTotalCaption = document.getElementById('stat-total-caption')!;
const statMonthWords = document.getElementById('stat-month-words')!;
const statMonthCaption = document.getElementById('stat-month-caption')!;
const statTodayWords = document.getElementById('stat-today-words')!;
const statSessions = document.getElementById('stat-sessions')!;
const statMonthSessions = document.getElementById('stat-month-sessions')!;
const monthTrend = document.getElementById('month-trend')!;
const timelineMax = document.getElementById('timeline-max')!;
const timelineMid = document.getElementById('timeline-mid')!;
const timelineTotal = document.getElementById('timeline-total')!;
const timelineAverage = document.getElementById('timeline-average')!;
const timelineBars = document.getElementById('timeline-bars')!;

interface Entry {
  id: string;
  text: string;
  timestamp: number;
  duration: number;
  wordCount?: number;
  durationSource?: 'recorded' | 'estimated' | 'recovered';
}

let currentEntries: Entry[] = [];
let currentStats: UsageStats | null = null;

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function plural(count: number, singular: string, pluralWord = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : pluralWord}`;
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function monthKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const time = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (isToday) {
    return time;
  }
  return (
    date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' +
    time
  );
}

function formatLastUsed(timestamp: number | null): string {
  if (!timestamp) return 'No sessions yet';

  const date = new Date(timestamp);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (date.toDateString() === now.toDateString()) {
    return `Last ${time}`;
  }

  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${time}`;
  }

  return `Last ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function formatSince(timestamp: number | null): string {
  if (!timestamp) return 'No data yet';

  const date = new Date(timestamp);
  return `Since ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function formatEntryDuration(entry: Entry): string {
  if (entry.durationSource === 'recovered') return '';
  const seconds = entry.duration;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

function recentDayKeys(count: number): string[] {
  const keys: string[] = [];
  const date = new Date();

  for (let i = count - 1; i >= 0; i--) {
    const day = new Date(date);
    day.setDate(date.getDate() - i);
    keys.push(dateKey(day));
  }

  return keys;
}

function formatTimelineLabel(key: string): string {
  const [, month, day] = key.split('-').map(Number);
  return `${month}/${day}`;
}

function emptyStatsFromEntries(entries: Entry[]): UsageStats {
  const stats: UsageStats = {
    initializedFromHistory: true,
    totalSessions: 0,
    totalWords: 0,
    totalDictationSeconds: 0,
    trackedDictationSeconds: 0,
    trackedDictationSessions: 0,
    firstRecordedAt: null,
    lastRecordedAt: null,
    daily: {},
  };

  for (const entry of entries) {
    const words = entry.wordCount ?? countWords(entry.text);
    const duration = Number.isFinite(entry.duration) ? Math.max(0, entry.duration) : 0;
    const hasTrackedDuration = entry.durationSource === 'recorded';
    const key = dateKey(new Date(entry.timestamp));
    const dayStats = stats.daily[key] ?? {
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
    stats.daily[key] = {
      sessions: dayStats.sessions + 1,
      words: dayStats.words + words,
      dictationSeconds: dayStats.dictationSeconds + duration,
      trackedDictationSeconds:
        (dayStats.trackedDictationSeconds ?? 0) + (hasTrackedDuration ? duration : 0),
      trackedDictationSessions:
        (dayStats.trackedDictationSessions ?? 0) + (hasTrackedDuration ? 1 : 0),
    };
  }

  return stats;
}

function sumDaily(stats: UsageStats, keyPrefix: string): DailyUsageStats {
  return Object.entries(stats.daily).reduce<DailyUsageStats>(
    (sum, [key, value]) => {
      if (!key.startsWith(keyPrefix)) return sum;

      return {
        sessions: sum.sessions + value.sessions,
        words: sum.words + value.words,
        dictationSeconds: sum.dictationSeconds + value.dictationSeconds,
        trackedDictationSeconds:
          (sum.trackedDictationSeconds ?? 0) + (value.trackedDictationSeconds ?? 0),
        trackedDictationSessions:
          (sum.trackedDictationSessions ?? 0) + (value.trackedDictationSessions ?? 0),
      };
    },
    {
      sessions: 0,
      words: 0,
      dictationSeconds: 0,
      trackedDictationSeconds: 0,
      trackedDictationSessions: 0,
    }
  );
}

function renderTimeline(stats: UsageStats): void {
  const keys = recentDayKeys(14);
  const values = keys.map((key) => stats.daily[key]?.words ?? 0);
  const totalWords = values.reduce((sum, words) => sum + words, 0);
  const maxWords = Math.max(1, ...values);
  const midWords = Math.round(maxWords / 2);

  timelineMax.textContent = formatNumber(maxWords);
  timelineMid.textContent = formatNumber(midWords);
  timelineTotal.textContent = formatNumber(totalWords);
  timelineAverage.textContent = formatNumber(Math.round(totalWords / keys.length));

  timelineBars.innerHTML = keys
    .map((key, index) => {
      const words = stats.daily[key]?.words ?? 0;
      const height = Math.max(words > 0 ? 8 : 2, Math.round((words / maxWords) * 100));
      const isToday = key === dateKey(new Date());
      const showLabel = index % 2 === 0 || isToday;

      return `
        <div class="timeline-day${isToday ? ' is-today' : ''}" aria-label="${formatTimelineLabel(key)}: ${plural(words, 'word')}">
          <div class="timeline-bar-wrap">
            <div class="timeline-bar" style="height: ${height}%"></div>
          </div>
          <span>${showLabel ? formatTimelineLabel(key) : ''}</span>
        </div>
      `;
    })
    .join('');
}

function renderHistory(entries: Entry[]): void {
  historyCount.textContent = plural(entries.length, 'entry', 'entries');

  if (entries.length === 0) {
    historyList.innerHTML = '';
    historyList.style.display = 'none';
    emptyState.style.display = 'flex';
    return;
  }

  historyList.style.display = 'block';
  emptyState.style.display = 'none';
  historyList.innerHTML = entries
    .map(
      (entry) => `
    <div class="entry" data-id="${entry.id}">
      <div class="entry-meta">
        <span class="entry-time">${formatTime(entry.timestamp)}</span>
        ${
          entry.durationSource === 'recovered'
            ? ''
            : `<span class="entry-duration">${formatEntryDuration(entry)}</span>`
        }
      </div>
      <div class="entry-text">${escapeHtml(entry.text)}</div>
    </div>
  `
    )
    .join('');
}

function renderStats(stats: UsageStats | null, entries: Entry[]): void {
  const source = stats ?? emptyStatsFromEntries(entries);
  const now = new Date();
  const today = source.daily[dateKey(now)] ?? {
    sessions: 0,
    words: 0,
    dictationSeconds: 0,
  };
  const currentMonth = sumDaily(source, monthKey(now));

  statTotalWords.textContent = formatNumber(source.totalWords);
  statMonthWords.textContent = formatNumber(currentMonth.words);
  statTodayWords.textContent = formatNumber(today.words);
  statSessions.textContent = formatNumber(source.totalSessions);
  statMonthSessions.textContent = `${plural(currentMonth.sessions, 'session')} this month`;
  lastUsed.textContent = formatLastUsed(source.lastRecordedAt);
  renderTimeline(source);
  monthTrend.textContent = formatSince(source.firstRecordedAt);
  statTotalCaption.textContent =
    source.totalWords === 0 ? 'tracked dictation total' : 'all saved stats';
  statMonthCaption.textContent =
    currentMonth.words === source.totalWords && source.totalWords > 0
      ? 'same as saved total'
      : 'words this month';
}

function render(): void {
  renderHistory(currentEntries);
  renderStats(currentStats, currentEntries);
}

Promise.all([window.api.getHistory(), window.api.getUsageStats()]).then(([entries, stats]) => {
  currentEntries = entries;
  currentStats = stats;
  render();
});

window.api.onHistoryUpdate((entries) => {
  currentEntries = entries;
  render();
});

window.api.onUsageStatsUpdate((stats) => {
  currentStats = stats;
  renderStats(currentStats, currentEntries);
});

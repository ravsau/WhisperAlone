const historyList = document.getElementById('history-list')!;
const emptyState = document.getElementById('empty-state')!;

interface Entry {
  id: string;
  text: string;
  timestamp: number;
  duration: number;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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

function renderHistory(entries: Entry[]): void {
  if (entries.length === 0) {
    historyList.innerHTML = '';
    emptyState.style.display = 'flex';
    return;
  }

  emptyState.style.display = 'none';
  historyList.innerHTML = entries
    .map(
      (entry) => `
    <div class="entry" data-id="${entry.id}">
      <div class="entry-meta">
        <span class="entry-time">${formatTime(entry.timestamp)}</span>
        <span class="entry-duration">${entry.duration}s</span>
      </div>
      <div class="entry-text">${escapeHtml(entry.text)}</div>
    </div>
  `
    )
    .join('');
}

// Initial load
window.api.getHistory().then(renderHistory);

// Live updates from main process
window.api.onHistoryUpdate(renderHistory);

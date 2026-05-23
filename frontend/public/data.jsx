// Shared UI helpers. Folder/session data now lives in Postgres and is fetched
// at runtime via /api/folders and /api/sessions.
const FOLDER_COLORS = {
  teal:   'var(--c-teal)',
  blue:   'var(--c-blue)',
  violet: 'var(--c-violet)',
  rose:   'var(--c-rose)',
  amber:  'var(--c-amber)',
  green:  'var(--c-green)',
  slate:  'var(--c-slate)',
  coral:  'var(--c-coral)',
};

window.FOLDER_COLORS = FOLDER_COLORS;

// Helpers
window.formatDate = (iso) => {
  const d = new Date(iso);
  const now = new Date('2026-05-06T17:00:00Z');
  const diffH = (now - d) / 36e5;
  if (diffH < 1) return `${Math.max(1, Math.round(diffH * 60))}m ago`;
  if (diffH < 24) return `${Math.round(diffH)}h ago`;
  const diffD = diffH / 24;
  if (diffD < 7) return `${Math.round(diffD)}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

window.groupByTime = (sessions) => {
  const now = new Date('2026-05-06T17:00:00Z');
  const today = new Date(now); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today); week.setDate(week.getDate() - 7);

  const groups = { Today: [], Yesterday: [], 'This Week': [], Older: [] };
  sessions.forEach(s => {
    const d = new Date(s.updatedAt);
    if (d >= today) groups.Today.push(s);
    else if (d >= yesterday) groups.Yesterday.push(s);
    else if (d >= week) groups['This Week'].push(s);
    else groups.Older.push(s);
  });
  return groups;
};

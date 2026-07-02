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

// BYOK provider + model catalog. `provider` ids match the backend (providers.py
// / UserApiKey.provider); `model` ids are the exact strings sent to /api/chat.
const PROVIDER_CATALOG = [
  { id: 'anthropic', name: 'Anthropic', models: [
    { id: 'claude-sonnet-4-6',            name: 'Claude Sonnet 4.6' },
    { id: 'claude-haiku-4-5-20251001',    name: 'Claude Haiku 4.5' },
  ]},
  { id: 'openai', name: 'OpenAI', models: [
    { id: 'gpt-4o',      name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
  ]},
  { id: 'google', name: 'Google', models: [
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
    { id: 'gemini-1.5-pro',   name: 'Gemini 1.5 Pro' },
  ]},
  { id: 'mistral', name: 'Mistral', models: [
    { id: 'mistral-large-latest', name: 'Mistral Large' },
    { id: 'mistral-small-latest', name: 'Mistral Small' },
  ]},
];
const DEFAULT_PROVIDER = 'anthropic';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Resolve a (providerId, modelId) pair to catalog entries, falling back to the
// defaults so a stale/unknown value (e.g. an old session's display-name model)
// never leaves the picker or the chat payload in a broken state.
const resolveModel = (providerId, modelId) => {
  const provider = PROVIDER_CATALOG.find(p => p.id === providerId) || PROVIDER_CATALOG[0];
  const model = provider.models.find(m => m.id === modelId) || provider.models[0];
  return { provider, model };
};

window.PROVIDER_CATALOG = PROVIDER_CATALOG;
window.DEFAULT_PROVIDER = DEFAULT_PROVIDER;
window.DEFAULT_MODEL = DEFAULT_MODEL;
window.resolveModel = resolveModel;

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

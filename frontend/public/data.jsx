// Seed data for StudyAI prototype
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

const seedFolders = [
  { id: 'f-school',   name: 'School',           color: 'blue',   parentId: null,       order: 0 },
  { id: 'f-chem',     name: 'Organic Chem',     color: 'green',  parentId: 'f-school', order: 0 },
  { id: 'f-calc',     name: 'Calculus II',      color: 'amber',  parentId: 'f-school', order: 1 },
  { id: 'f-personal', name: 'Personal',         color: 'rose',   parentId: null,       order: 1 },
  { id: 'f-research', name: 'Research',         color: 'violet', parentId: null,       order: 2 },
  { id: 'f-notes',    name: 'Notes',            color: 'slate',  parentId: null,       order: 3 },
];

const seedSessions = [
  { id: 's1',  title: 'SN1 vs SN2 reaction mechanisms',           folderId: 'f-chem',     model: 'Gemini 2.0 Flash', updatedAt: '2026-05-06T14:32:00Z', messageCount: 14 },
  { id: 's2',  title: 'Stereochemistry: R/S configuration',       folderId: 'f-chem',     model: 'Gemini 2.0 Flash', updatedAt: '2026-05-06T11:08:00Z', messageCount: 8 },
  { id: 's3',  title: 'Markovnikov\u2019s rule worked examples',  folderId: 'f-chem',     model: 'Claude Haiku',     updatedAt: '2026-05-05T19:14:00Z', messageCount: 22 },
  { id: 's4',  title: 'Integration by parts \u2014 practice set', folderId: 'f-calc',     model: 'GPT-4o Mini',      updatedAt: '2026-05-06T09:21:00Z', messageCount: 31 },
  { id: 's5',  title: 'Taylor series intuition',                  folderId: 'f-calc',     model: 'Claude Sonnet',    updatedAt: '2026-05-04T22:40:00Z', messageCount: 12 },
  { id: 's6',  title: 'Convergence tests cheatsheet',             folderId: 'f-calc',     model: 'Gemini 2.0 Flash', updatedAt: '2026-05-03T16:55:00Z', messageCount: 6 },
  { id: 's7',  title: 'Essay outline: industrial revolution',     folderId: 'f-school',   model: 'Claude Sonnet',    updatedAt: '2026-05-05T10:02:00Z', messageCount: 19 },
  { id: 's8',  title: 'Spanish subjunctive practice',             folderId: 'f-school',   model: 'GPT-4o Mini',      updatedAt: '2026-05-02T18:30:00Z', messageCount: 27 },
  { id: 's9',  title: 'Trip planning \u2014 Lisbon, June',        folderId: 'f-personal', model: 'Gemini 2.0 Flash', updatedAt: '2026-05-06T08:00:00Z', messageCount: 9 },
  { id: 's10', title: 'Sourdough hydration troubleshooting',      folderId: 'f-personal', model: 'GPT-4o',           updatedAt: '2026-05-04T13:22:00Z', messageCount: 16 },
  { id: 's11', title: 'Workout split for hypertrophy',            folderId: 'f-personal', model: 'Claude Haiku',     updatedAt: '2026-05-01T07:45:00Z', messageCount: 11 },
  { id: 's12', title: 'Literature review: attention mechanisms',  folderId: 'f-research', model: 'Claude Sonnet',    updatedAt: '2026-05-06T15:50:00Z', messageCount: 41 },
  { id: 's13', title: 'Reading notes: \u201CThinking in Systems\u201D', folderId: 'f-research', model: 'GPT-4o', updatedAt: '2026-05-05T20:11:00Z', messageCount: 18 },
  { id: 's14', title: 'Latex formatting tips',                    folderId: 'f-notes',    model: 'Gemini 2.0 Flash', updatedAt: '2026-05-04T09:08:00Z', messageCount: 7 },
  { id: 's15', title: 'Daily journal \u2014 reflections',         folderId: 'f-notes',    model: 'Claude Haiku',     updatedAt: '2026-05-06T07:14:00Z', messageCount: 24 },
  { id: 's16', title: 'Untitled chat',                            folderId: null,         model: 'Gemini 2.0 Flash', updatedAt: '2026-05-06T16:02:00Z', messageCount: 2 },
  { id: 's17', title: 'Career path \u2014 grad school vs. industry', folderId: null,      model: 'Claude Sonnet',    updatedAt: '2026-05-05T22:00:00Z', messageCount: 13 },
];

window.FOLDER_COLORS = FOLDER_COLORS;
window.seedFolders = seedFolders;
window.seedSessions = seedSessions;

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

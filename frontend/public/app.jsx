const MODELS = [
  { id: 'gemini-flash',  name: 'Gemini Flash',  desc: 'Fast' },
  { id: 'gemini-pro',    name: 'Gemini Pro',    desc: 'Balanced' },
  { id: 'claude-sonnet', name: 'Claude Sonnet', desc: 'Balanced' },
  { id: 'claude-haiku',  name: 'Claude Haiku',  desc: 'Fast' },
];

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light"
}/*EDITMODE-END*/;

const PREFS_KEY = 'studyai:prefs';
const loadPrefs = () => {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
};
const savePrefs = (p) => {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}
};

function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [view, setView] = React.useState('files'); // 'files' | 'chat'
  const [activeChatId, setActiveChatId] = React.useState(null);
  const [sidebarTab, setSidebarTab] = React.useState('folders');
  const [sidebarWidth, setSidebarWidth] = React.useState(264);

  const [folders, setFolders] = React.useState([]);
  const [sessions, setSessions] = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  const [currentFolderId, setCurrentFolderId] = React.useState(null);
  const [viewMode, setViewMode] = React.useState('grid');
  const [sortBy, setSortBy] = React.useState('modified');
  const [sortDir, setSortDir] = React.useState('desc');
  const [search, setSearch] = React.useState('');
  const [selected, setSelected] = React.useState(new Set());

  const [expandedFolders, setExpandedFolders] = React.useState(new Set());

  // Hydrate persisted prefs once. localStorage is the source of truth across
  // reloads; everything below reads from prefs state and writes back via savePrefs.
  const [prefs, setPrefs] = React.useState(() => {
    const stored = loadPrefs();
    // Validate against the current MODELS list — a previously persisted id
    // would otherwise crash the topbar when MODELS.find returns undefined.
    const validId = (id) => MODELS.some(m => m.id === id);
    return {
      defaultModelId: validId(stored.defaultModelId) ? stored.defaultModelId : 'gemini-flash',
      sendOnEnter: stored.sendOnEnter !== false, // default true
    };
  });

  const [modelId, setModelId] = React.useState(prefs.defaultModelId);
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false);
  const [titleEditing, setTitleEditing] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  // Inline rename / delete-confirm / new-folder modal state
  const [renamingChatId, setRenamingChatId] = React.useState(null);
  const [confirmDelete, setConfirmDelete] = React.useState(null); // { kind: 'chat'|'folder', id, name }
  const [newFolderModal, setNewFolderModal] = React.useState(null); // { parentId } | null
  const [renamingFolderId, setRenamingFolderId] = React.useState(null);
  const [toast, setToast] = React.useState(null); // string

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(t => t === msg ? null : t), 2200);
  };

  // Initial hydration: load folders + sessions from the API. The seed arrays
  // are gone, so until this resolves we render a "Loading…" placeholder to
  // avoid flashing an empty Files view first.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [fRes, sRes] = await Promise.all([
          fetch('/api/folders'),
          fetch('/api/sessions'),
        ]);
        if (!fRes.ok || !sRes.ok) throw new Error('Bad response');
        const [fData, sData] = await Promise.all([fRes.json(), sRes.json()]);
        if (cancelled) return;
        setFolders(fData);
        // messageCount isn't persisted on the backend yet; default to 0 and let
        // onSessionActivity bump it locally as the user chats.
        setSessions(sData.map(s => ({ ...s, messageCount: s.messageCount ?? 0 })));
      } catch (e) {
        if (!cancelled) {
          console.error('Failed to load initial data', e);
          showToast('Could not load data — is the backend running?');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Hydrate theme from localStorage once, ignoring TWEAK_DEFAULTS' fixed value
  // so a user's last choice survives reloads.
  React.useEffect(() => {
    const stored = loadPrefs();
    if (stored.theme && stored.theme !== tweaks.theme) {
      setTweak('theme', stored.theme);
    }
  }, []);

  React.useEffect(() => {
    document.documentElement.dataset.theme = tweaks.theme;
    const stored = loadPrefs();
    savePrefs({ ...stored, theme: tweaks.theme });
  }, [tweaks.theme]);

  // Persist prefs whenever they change.
  React.useEffect(() => {
    const stored = loadPrefs();
    savePrefs({ ...stored, defaultModelId: prefs.defaultModelId, sendOnEnter: prefs.sendOnEnter });
  }, [prefs]);

  // Bump session metadata when a chat sees new messages — keeps the sidebar's
  // "last updated" ordering accurate within the session.
  const onSessionActivity = (sessionId, { count }) => {
    setSessions(arr => arr.map(s => s.id === sessionId
      ? { ...s, messageCount: count, updatedAt: new Date().toISOString() }
      : s));
  };

  // ChatView writes its per-session message arrays into this ref so we can
  // export them without lifting all of that state up here.
  const chatMessagesRef = React.useRef({});

  const exportActiveChat = () => {
    if (!activeChatId) {
      showToast('Open a chat to export it');
      return;
    }
    const s = sessions.find(x => x.id === activeChatId);
    if (!s) return;
    const messages = chatMessagesRef.current[s.id] || [];
    if (messages.length === 0) {
      showToast('No messages in this chat yet');
      return;
    }
    const md = [
      `# ${s.title}`,
      `*Model: ${s.model || ''}*`,
      `*Exported: ${new Date().toISOString()}*`,
      '',
      ...messages.map(m => {
        const role = m.role === 'user' ? '**You**' : '**Assistant**';
        const body = m.text || htmlToText(m.html || '');
        return `${role}\n\n${body}\n`;
      }),
    ].join('\n');
    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${s.title.replace(/[^a-z0-9\-_.]+/gi, '_').slice(0, 60) || 'chat'}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Chat exported');
  };

  const htmlToText = (html) => {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return (tmp.textContent || '').trim();
  };

  const activeSession = activeChatId ? sessions.find(s => s.id === activeChatId) : null;
  const activeFolder = activeSession?.folderId ? folders.find(f => f.id === activeSession.folderId) : null;
  const currentModel = MODELS.find(m => m.id === modelId) || MODELS[0];

  const onSelectChat = (id) => {
    setActiveChatId(id);
    setView('chat');
    setSelected(new Set());
  };
  const createSessionAndOpen = async (folderId) => {
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'New chat',
          model: currentModel.name,
          folderId: folderId || null,
        }),
      });
      if (!res.ok) throw new Error('create session failed');
      const created = await res.json();
      setSessions(s => [{ ...created, messageCount: 0 }, ...s]);
      setActiveChatId(created.id);
      setView('chat');
    } catch (e) {
      console.error(e);
      showToast('Could not create chat');
    }
  };

  const onOpenChat = (id, folderId) => {
    if (id) {
      setActiveChatId(id);
      setView('chat');
    } else {
      createSessionAndOpen(folderId);
    }
  };
  const onNewChat = () => createSessionAndOpen(null);

  const onMoveChatToFolder = async (chatId, folderId) => {
    try {
      const res = await fetch(`/api/sessions/${chatId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: folderId || null }),
      });
      if (!res.ok) throw new Error('move failed');
      const updated = await res.json();
      setSessions(arr => arr.map(s => s.id === chatId ? { ...s, ...updated } : s));
      if (folderId) {
        const f = folders.find(x => x.id === folderId);
        showToast(`Moved to ${f?.name || 'folder'}`);
        // auto-expand target folder so the user can see where it landed
        setExpandedFolders(prev => {
          const next = new Set(prev); next.add(folderId);
          let cur = f?.parentId; while (cur) { next.add(cur); const p = folders.find(x => x.id === cur); cur = p?.parentId; }
          return next;
        });
      } else {
        showToast('Removed from folder');
      }
    } catch (e) {
      console.error(e);
      showToast('Could not move chat');
    }
  };

  const onSetTitle = async (newTitle) => {
    if (!activeChatId || !newTitle?.trim()) return;
    try {
      const res = await fetch(`/api/sessions/${activeChatId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      if (!res.ok) throw new Error('rename failed');
      const updated = await res.json();
      setSessions(arr => arr.map(s => s.id === activeChatId ? { ...s, ...updated } : s));
    } catch (e) {
      console.error(e);
      showToast('Could not rename chat');
    }
  };

  const onRenameChat = async (chatId, newTitle) => {
    if (!newTitle?.trim()) return;
    try {
      const res = await fetch(`/api/sessions/${chatId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      if (!res.ok) throw new Error('rename failed');
      const updated = await res.json();
      setSessions(arr => arr.map(s => s.id === chatId ? { ...s, ...updated } : s));
    } catch (e) {
      console.error(e);
      showToast('Could not rename chat');
    }
  };

  const onDeleteChat = async (chatId) => {
    try {
      const res = await fetch(`/api/sessions/${chatId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('delete failed');
      setSessions(arr => arr.filter(s => s.id !== chatId));
      setSelected(prev => { const n = new Set(prev); n.delete(chatId); return n; });
      if (activeChatId === chatId) { setActiveChatId(null); setView('files'); }
      showToast('Chat deleted');
    } catch (e) {
      console.error(e);
      showToast('Could not delete chat');
    }
  };

  const onCreateFolder = async (name, color, parentId) => {
    const siblings = folders.filter(f => f.parentId === (parentId || null));
    try {
      const res = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          color,
          parentId: parentId || null,
          order: siblings.length,
        }),
      });
      if (!res.ok) throw new Error('create folder failed');
      const created = await res.json();
      setFolders(arr => [...arr, created]);
      if (parentId) {
        setExpandedFolders(prev => { const n = new Set(prev); n.add(parentId); return n; });
      }
      showToast(`Folder "${name}" created`);
      return created.id;
    } catch (e) {
      console.error(e);
      showToast('Could not create folder');
    }
  };

  const onRenameFolder = async (folderId, newName) => {
    if (!newName?.trim()) return;
    try {
      const res = await fetch(`/api/folders/${folderId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!res.ok) throw new Error('rename folder failed');
      const updated = await res.json();
      setFolders(arr => arr.map(f => f.id === folderId ? { ...f, ...updated } : f));
    } catch (e) {
      console.error(e);
      showToast('Could not rename folder');
    }
  };

  const onDeleteFolder = async (folderId) => {
    // Collect target + all descendant folder ids.
    const subIds = new Set([folderId]);
    let added = true;
    while (added) {
      added = false;
      folders.forEach(f => { if (f.parentId && subIds.has(f.parentId) && !subIds.has(f.id)) { subIds.add(f.id); added = true; } });
    }
    try {
      // 1. Detach every session that lives in any of these folders. The
      //    backend schema has no ON DELETE behavior on Session.folder, so a
      //    DELETE would otherwise fail with a foreign-key error.
      const sessionsToDetach = sessions.filter(s => s.folderId && subIds.has(s.folderId));
      await Promise.all(sessionsToDetach.map(s =>
        fetch(`/api/sessions/${s.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderId: null }),
        }).then(r => { if (!r.ok) throw new Error('detach session failed'); })
      ));

      // 2. Delete subfolders bottom-up (children before their parents) so the
      //    parentId FK is never left dangling.
      const childrenOf = (id) => folders.filter(f => f.parentId === id && subIds.has(f.id));
      const deletePostOrder = async (id) => {
        for (const c of childrenOf(id)) await deletePostOrder(c.id);
        const r = await fetch(`/api/folders/${id}`, { method: 'DELETE' });
        if (!r.ok) throw new Error('delete folder failed');
      };
      await deletePostOrder(folderId);

      // 3. Mirror everything into local state.
      setSessions(arr => arr.map(s => subIds.has(s.folderId) ? { ...s, folderId: null } : s));
      setFolders(arr => arr.filter(f => !subIds.has(f.id)));
      if (currentFolderId && subIds.has(currentFolderId)) setCurrentFolderId(null);
      showToast('Folder deleted');
    } catch (e) {
      console.error(e);
      showToast('Could not delete folder');
    }
  };

  return (
    <div className="app">
      <Sidebar
        width={sidebarWidth} setWidth={setSidebarWidth}
        tab={sidebarTab} setTab={setSidebarTab}
        folders={folders} sessions={sessions}
        activeId={activeChatId}
        onSelectChat={onSelectChat}
        onNewChat={onNewChat}
        onOpenSettings={() => setSettingsOpen(true)}
        expandedFolders={expandedFolders} setExpandedFolders={setExpandedFolders}
        view={view} onSwitchView={setView}
        renamingChatId={renamingChatId} setRenamingChatId={setRenamingChatId}
        onRenameChat={onRenameChat}
        onConfirmDeleteChat={(s) => setConfirmDelete({ kind: 'chat', id: s.id, name: s.title })}
        onConfirmDeleteFolder={(f) => setConfirmDelete({ kind: 'folder', id: f.id, name: f.name })}
        renamingFolderId={renamingFolderId} setRenamingFolderId={setRenamingFolderId}
        onRenameFolder={onRenameFolder}
        onNewFolder={(parentId) => setNewFolderModal({ parentId: parentId || null })}
        onMoveChatToFolder={onMoveChatToFolder}
      />

      <main className="main">
        <Topbar
          view={view} setView={setView}
          activeSession={activeSession} activeFolder={activeFolder}
          folders={folders}
          onMoveToFolder={(fid) => onMoveChatToFolder(activeSession?.id, fid)}
          onSetTitle={onSetTitle}
          titleEditing={titleEditing} setTitleEditing={setTitleEditing}
          modelId={modelId} setModelId={setModelId}
          modelMenuOpen={modelMenuOpen} setModelMenuOpen={setModelMenuOpen}
          currentModel={currentModel}
          theme={tweaks.theme} toggleTheme={() => setTweak('theme', tweaks.theme === 'light' ? 'dark' : 'light')}
          onExport={exportActiveChat}
          canExport={!!activeChatId}
        />

        {loading ? (
          <div style={{ flex: 1, display: 'grid', placeItems: 'center',
                        color: 'var(--text-faint)', fontSize: 13 }}>
            Loading…
          </div>
        ) : view === 'files' ? (
          <FilesView
            folders={folders} sessions={sessions}
            currentFolderId={currentFolderId} setCurrentFolderId={setCurrentFolderId}
            onOpenChat={onOpenChat}
            viewMode={viewMode} setViewMode={setViewMode}
            sortBy={sortBy} setSortBy={setSortBy}
            sortDir={sortDir} setSortDir={setSortDir}
            search={search} setSearch={setSearch}
            selected={selected} setSelected={setSelected}
            onMoveChatToFolder={onMoveChatToFolder}
            onNewFolder={(parentId) => setNewFolderModal({ parentId: parentId || null })}
          />
        ) : (
          <ChatView
            session={activeSession}
            folders={folders}
            model={currentModel.name}
            modelId={modelId}
            onSetTitle={onSetTitle}
            onMoveToFolder={(fid) => onMoveChatToFolder(activeSession?.id, fid)}
            onSessionActivity={onSessionActivity}
            sendOnEnter={prefs.sendOnEnter}
            chatMessagesRef={chatMessagesRef}
          />
        )}
      </main>

      {newFolderModal && (
        <NewFolderModal
          parentId={newFolderModal.parentId}
          parentName={newFolderModal.parentId ? folders.find(f => f.id === newFolderModal.parentId)?.name : null}
          onClose={() => setNewFolderModal(null)}
          onCreate={(name, color) => { onCreateFolder(name, color, newFolderModal.parentId); setNewFolderModal(null); }}
        />
      )}
      {confirmDelete && (
        <ConfirmModal
          title={confirmDelete.kind === 'chat' ? 'Delete chat?' : 'Delete folder?'}
          body={confirmDelete.kind === 'chat'
            ? <>Permanently delete <strong>"{confirmDelete.name}"</strong>? This can't be undone.</>
            : <>Delete folder <strong>"{confirmDelete.name}"</strong>? Chats inside will be moved out of the folder, not deleted.</>}
          confirmText="Delete"
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            if (confirmDelete.kind === 'chat') onDeleteChat(confirmDelete.id);
            else onDeleteFolder(confirmDelete.id);
            setConfirmDelete(null);
          }}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          prefs={prefs}
          setPrefs={setPrefs}
          theme={tweaks.theme}
          setTheme={(t) => setTweak('theme', t)}
          models={MODELS}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {toast && (
        <div className="toast-stack"><div className="toast">{toast}</div></div>
      )}
    </div>
  );
}

function SettingsModal({ prefs, setPrefs, theme, setTheme, models, onClose }) {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 480 }}>
        <div style={{ padding: '16px 20px 8px' }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>Settings</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Preferences are saved to this browser.
          </div>
        </div>
        <div style={{ padding: '8px 20px 4px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)',
                          textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
              Theme
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {['light', 'dark'].map(t => (
                <button key={t}
                        className="topbar-btn"
                        onClick={() => setTheme(t)}
                        style={t === theme
                          ? { background: 'var(--accent)', color: 'white', borderColor: 'var(--accent)', textTransform: 'capitalize' }
                          : { textTransform: 'capitalize' }}>
                  {t === 'dark' ? <I.moon size={13} /> : <I.sun size={13} />} {t}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)',
                          textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
              Default model for new chats
            </div>
            <select value={prefs.defaultModelId}
                    onChange={e => setPrefs(p => ({ ...p, defaultModelId: e.target.value }))}
                    style={{ width: '100%', padding: '8px 10px', fontSize: 13,
                             border: '1px solid var(--border)', borderRadius: 8,
                             background: 'var(--surface-2)', color: 'var(--text)' }}>
              {models.map(m => (
                <option key={m.id} value={m.id}>{m.name} — {m.desc}</option>
              ))}
            </select>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)',
                          textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
              Send key
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="radio" name="sendkey" checked={prefs.sendOnEnter}
                       onChange={() => setPrefs(p => ({ ...p, sendOnEnter: true }))}/>
                <span><strong>Enter</strong> to send · Shift+Enter for new line</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                <input type="radio" name="sendkey" checked={!prefs.sendOnEnter}
                       onChange={() => setPrefs(p => ({ ...p, sendOnEnter: false }))}/>
                <span><strong>⌘/Ctrl + Enter</strong> to send · Enter for new line</span>
              </label>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end',
                      padding: '14px 18px', borderTop: '1px solid var(--border)', marginTop: 12 }}>
          <button className="topbar-btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function Topbar({ view, setView, activeSession, activeFolder, folders, onMoveToFolder, onSetTitle, titleEditing, setTitleEditing, modelId, setModelId, modelMenuOpen, setModelMenuOpen, currentModel, theme, toggleTheme, onExport, canExport }) {
  const titleInputRef = React.useRef(null);
  const [draftTitle, setDraftTitle] = React.useState('');
  const [folderPickerOpen, setFolderPickerOpen] = React.useState(false);

  React.useEffect(() => {
    if (titleEditing) {
      setDraftTitle(activeSession?.title || '');
      setTimeout(() => titleInputRef.current?.select(), 0);
    }
  }, [titleEditing, activeSession]);

  const commitTitle = () => {
    if (draftTitle.trim()) onSetTitle(draftTitle.trim());
    setTitleEditing(false);
  };

  return (
    <div className="topbar">
      {view === 'chat' && activeSession ? (
        <>
          {titleEditing ? (
            <input
              ref={titleInputRef}
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => { if (e.key === 'Enter') commitTitle(); if (e.key === 'Escape') setTitleEditing(false); }}
              style={{ font: 'inherit', fontWeight: 600, border: 0, outline: 0,
                       padding: '4px 6px', background: 'var(--surface-2)',
                       boxShadow: '0 0 0 2px var(--accent-soft)', borderRadius: 4, width: 320 }}
            />
          ) : (
            <div className="topbar-title truncate" onClick={() => setTitleEditing(true)}>
              {activeSession.title}
            </div>
          )}
          <div style={{ position: 'relative' }}>
            {activeFolder ? (
              <span className="folder-pill" onClick={() => setFolderPickerOpen(o => !o)}>
                <span className="dot" style={{ background: FOLDER_COLORS[activeFolder.color] }}/>
                {activeFolder.name}
                <I.chevDown size={11} />
              </span>
            ) : (
              <span className="folder-pill" style={{ color: 'var(--text-faint)' }} onClick={() => setFolderPickerOpen(o => !o)}>
                <I.plus size={11} />
                Add to folder
              </span>
            )}
            {folderPickerOpen && (
              <FolderPicker folders={folders} currentId={activeFolder?.id || null}
                onPick={(fid) => { onMoveToFolder(fid); setFolderPickerOpen(false); }}
                onClose={() => setFolderPickerOpen(false)}
              />
            )}
          </div>
        </>
      ) : view === 'files' ? (
        <div className="topbar-title" style={{ cursor: 'default' }}>Files</div>
      ) : (
        <div className="topbar-title" style={{ cursor: 'default' }}>New chat</div>
      )}

      <div className="topbar-spacer"/>

      <button className="topbar-btn icon-only" onClick={toggleTheme} title="Toggle theme">
        {theme === 'dark' ? <I.sun size={14} /> : <I.moon size={14} />}
      </button>

      <button className="topbar-btn icon-only" title="Export chat as Markdown"
              onClick={onExport} disabled={!canExport}
              style={!canExport ? { opacity: 0.4, cursor: 'not-allowed' } : null}>
        <I.share size={14} />
      </button>

      <button className="topbar-btn" onClick={() => setView(view === 'files' ? 'chat' : 'files')}>
        {view === 'files' ? <><I.msgSquare size={14} />Chat</> : <><I.folder size={14} />Files</>}
      </button>

      <div className="model-select">
        <button className="topbar-btn" onClick={() => setModelMenuOpen(o => !o)}>
          <I.sparkle size={13} />{currentModel.name}<I.chevDown size={12} />
        </button>
        {modelMenuOpen && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => setModelMenuOpen(false)}/>
            <div className="model-menu">
              {MODELS.map(m => (
                <div key={m.id} className="model-item" onClick={() => { setModelId(m.id); setModelMenuOpen(false); }}>
                  <div className="check">{m.id === modelId && <I.check size={13} strokeWidth={2.5} />}</div>
                  <span style={{ fontWeight: 500 }}>{m.name}</span>
                  <span className="desc">{m.desc}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FolderPicker({ folders, currentId, onPick, onClose }) {
  const [q, setQ] = React.useState('');
  const flat = React.useMemo(() => {
    const byId = Object.fromEntries(folders.map(f => [f.id, f]));
    const path = (f) => {
      const out = [f.name]; let cur = f.parentId;
      while (cur) { const p = byId[cur]; if (!p) break; out.unshift(p.name); cur = p.parentId; }
      return out.join(' / ');
    };
    return folders.map(f => ({ ...f, path: path(f) })).sort((a,b) => a.path.localeCompare(b.path));
  }, [folders]);
  const filtered = q ? flat.filter(f => f.path.toLowerCase().includes(q.toLowerCase())) : flat;
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={onClose}/>
      <div className="model-menu" style={{ left: 0, right: 'auto', top: 'calc(100% + 6px)', minWidth: 240, maxHeight: 300, overflowY: 'auto', zIndex: 50 }}>
        <div style={{ padding: '4px 4px 6px', borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search folders…"
            style={{ width: '100%', border: 0, outline: 0, padding: '6px 8px', fontSize: 13, background: 'transparent', color: 'var(--text)' }}/>
        </div>
        {currentId && (
          <>
            <div className="model-item" onClick={() => onPick(null)}>
              <div className="check"/>
              <span style={{ color: 'var(--text-muted)' }}><I.x size={12}/> Remove from folder</span>
            </div>
            <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }}/>
          </>
        )}
        {filtered.length === 0 && <div style={{ padding: 10, fontSize: 12, color: 'var(--text-faint)' }}>No folders match.</div>}
        {filtered.map(f => (
          <div key={f.id} className="model-item" onClick={() => onPick(f.id)}>
            <div className="check">{f.id === currentId && <I.check size={13} strokeWidth={2.5}/>}</div>
            <I.folderFill color={FOLDER_COLORS[f.color]} size={14}/>
            <span style={{ fontWeight: 500 }}>{f.name}</span>
            {f.path !== f.name && <span className="desc" style={{ marginLeft: 'auto' }}>{f.path}</span>}
          </div>
        ))}
      </div>
    </>
  );
}

const FOLDER_COLOR_KEYS = ['blue','green','amber','rose','violet','teal','slate','coral'];

function NewFolderModal({ parentId, parentName, onClose, onCreate }) {
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState('blue');
  const inputRef = React.useRef(null);
  React.useEffect(() => { inputRef.current?.focus(); }, []);
  const submit = () => { if (name.trim()) onCreate(name, color); };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div style={{ padding: '16px 18px 8px' }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>New folder</div>
          {parentName && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Inside <strong>{parentName}</strong></div>}
        </div>
        <div style={{ padding: '8px 18px' }}>
          <input ref={inputRef} value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }}
            placeholder="Folder name"
            style={{ width: '100%', padding: '10px 12px', fontSize: 14, border: '1px solid var(--border)', borderRadius: 8, outline: 0, background: 'var(--surface-2)', color: 'var(--text)' }}/>
          <div style={{ marginTop: 14, fontSize: 12, fontWeight: 500, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Color</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {FOLDER_COLOR_KEYS.map(c => (
              <button key={c} onClick={() => setColor(c)} title={c}
                style={{ width: 28, height: 28, borderRadius: 8, background: FOLDER_COLORS[c],
                         boxShadow: color === c ? '0 0 0 2px var(--surface), 0 0 0 4px var(--accent)' : 'none',
                         border: 0, cursor: 'pointer' }}/>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '14px 18px', borderTop: '1px solid var(--border)', marginTop: 12 }}>
          <button className="topbar-btn" onClick={onClose}>Cancel</button>
          <button className="topbar-btn primary" disabled={!name.trim()} onClick={submit} style={{ opacity: name.trim() ? 1 : 0.5 }}>Create folder</button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({ title, body, confirmText = 'Confirm', danger, onCancel, onConfirm }) {
  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); if (e.key === 'Enter') onConfirm(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onConfirm]);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div style={{ padding: '18px 20px 4px', fontWeight: 600, fontSize: 15 }}>{title}</div>
        <div style={{ padding: '6px 20px 18px', fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>{body}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '12px 18px', borderTop: '1px solid var(--border)' }}>
          <button className="topbar-btn" onClick={onCancel}>Cancel</button>
          <button className="topbar-btn" onClick={onConfirm}
            style={danger ? { background: 'var(--danger)', color: 'white', borderColor: 'var(--danger)' } : { background: 'var(--accent)', color: 'white', borderColor: 'var(--accent)' }}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

window.App = App;
window.NewFolderModal = NewFolderModal;
window.ConfirmModal = ConfirmModal;
window.FolderPicker = FolderPicker;
ReactDOM.createRoot(document.getElementById('root')).render(<App />);

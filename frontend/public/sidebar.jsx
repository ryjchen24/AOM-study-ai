function Sidebar({ width, setWidth, tab, setTab, folders, sessions, user, activeId, onSelectChat, onNewChat, onOpenSettings, expandedFolders, setExpandedFolders, onSwitchView, view,
  renamingChatId, setRenamingChatId, onRenameChat,
  onConfirmDeleteChat, onConfirmDeleteFolder,
  renamingFolderId, setRenamingFolderId, onRenameFolder,
  onNewFolder, onMoveChatToFolder
}) {
  const startResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev) => {
      const next = Math.max(220, Math.min(380, startW + (ev.clientX - startX)));
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sb-top">
        <div className="sb-logo">
          <div className="sb-logo-mark"><div className="a"/><div className="b"/></div>
          <div className="sb-logo-text">StudyAI</div>
        </div>
        <button className="new-chat" onClick={onNewChat}>
          <I.plus size={14} />
          <span>New chat</span>
          <span className="kbd mono">⌘N</span>
        </button>
      </div>

      <div className="sb-tabs">
        <button className={`sb-tab ${tab === 'chats' ? 'active' : ''}`} onClick={() => setTab('chats')}>Chats</button>
        <button className={`sb-tab ${tab === 'folders' ? 'active' : ''}`} onClick={() => setTab('folders')}>Folders</button>
      </div>

      <div className="sb-body">
        {tab === 'chats' ? (
          <ChatsList sessions={sessions} folders={folders} activeId={activeId} onSelect={onSelectChat}
            renamingChatId={renamingChatId} setRenamingChatId={setRenamingChatId} onRenameChat={onRenameChat}
            onConfirmDeleteChat={onConfirmDeleteChat}
          />
        ) : (
          <FoldersList folders={folders} sessions={sessions} activeId={activeId} onSelect={onSelectChat}
            expanded={expandedFolders} setExpanded={setExpandedFolders}
            renamingFolderId={renamingFolderId} setRenamingFolderId={setRenamingFolderId}
            onRenameFolder={onRenameFolder}
            onConfirmDeleteFolder={onConfirmDeleteFolder}
            onNewFolder={onNewFolder}
            renamingChatId={renamingChatId} setRenamingChatId={setRenamingChatId}
            onRenameChat={onRenameChat} onConfirmDeleteChat={onConfirmDeleteChat}
            onMoveChatToFolder={onMoveChatToFolder}
          />
        )}
      </div>

      <div className="sb-bottom">
        <span className="status-dot" title="API key connected"/>
        <span className="model-name truncate">Gemini 2.0 Flash</span>
        <button className="icon-btn" onClick={onOpenSettings} title="Settings"><I.settings size={15} /></button>
        <button onClick={onOpenSettings} title="Account"
                style={{ padding: 0, border: 0, background: 'transparent', cursor: 'pointer',
                         display: 'grid', placeItems: 'center' }}>
          <UserAvatar user={user} className="avatar" />
        </button>
      </div>

      <div className="sb-resize" onMouseDown={startResize}/>
    </aside>
  );
}

function ChatRow({ session, folder, active, onSelect, isRenaming, setRenamingChatId, onRenameChat, onConfirmDeleteChat, indent }) {
  const [draft, setDraft] = React.useState(session.title);
  const inputRef = React.useRef(null);
  React.useEffect(() => {
    if (isRenaming) {
      setDraft(session.title);
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
    }
  }, [isRenaming, session.title]);
  const commit = () => { if (draft.trim() && draft !== session.title) onRenameChat(session.id, draft); setRenamingChatId(null); };

  if (isRenaming) {
    return (
      <div className={`chat-row active`} style={indent ? { paddingLeft: indent } : null} onClick={(e) => e.stopPropagation()}>
        {folder && <span className="dot" style={{ background: FOLDER_COLORS[folder.color] }}/>}
        {!folder && <span className="dot" style={{ background: 'var(--text-faint)', opacity: 0.4 }}/>}
        <input ref={inputRef} value={draft} onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setRenamingChatId(null); }}
          style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'var(--surface)', borderRadius: 4, padding: '2px 6px', font: 'inherit', color: 'var(--text)', boxShadow: '0 0 0 2px var(--accent-soft)' }}
        />
      </div>
    );
  }

  return (
    <div className={`chat-row ${active ? 'active' : ''}`}
         style={indent ? { paddingLeft: indent } : null}
         onClick={() => onSelect(session.id)}
         draggable
         onDragStart={(e) => { e.dataTransfer.setData('text/chat-id', session.id); e.dataTransfer.effectAllowed = 'move'; }}>
      {folder && <span className="dot" style={{ background: FOLDER_COLORS[folder.color] }}/>}
      {!folder && <span className="dot" style={{ background: 'var(--text-faint)', opacity: 0.4 }}/>}
      <span className="title truncate">{session.title}</span>
      <span className="actions">
        <button className="icon-btn" title="Rename" onClick={(e) => { e.stopPropagation(); setRenamingChatId(session.id); }}><I.pencil size={12} /></button>
        <button className="icon-btn" title="Delete" onClick={(e) => { e.stopPropagation(); onConfirmDeleteChat(session); }}><I.trash size={12} /></button>
      </span>
    </div>
  );
}

function ChatsList({ sessions, folders, activeId, onSelect, renamingChatId, setRenamingChatId, onRenameChat, onConfirmDeleteChat }) {
  const folderById = React.useMemo(() => Object.fromEntries(folders.map(f => [f.id, f])), [folders]);
  const sorted = [...sessions].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  const groups = groupByTime(sorted);

  return (
    <>
      {Object.entries(groups).map(([label, items]) => (
        items.length > 0 && (
          <div key={label}>
            <div className="sb-section-label">{label}</div>
            {items.map(s => (
              <ChatRow key={s.id} session={s} folder={s.folderId ? folderById[s.folderId] : null}
                active={activeId === s.id} onSelect={onSelect}
                isRenaming={renamingChatId === s.id}
                setRenamingChatId={setRenamingChatId} onRenameChat={onRenameChat}
                onConfirmDeleteChat={onConfirmDeleteChat}
              />
            ))}
          </div>
        )
      ))}
    </>
  );
}

function FolderRow({ folder, depth, isOpen, hasChildren, count, onToggle, isRenaming, setRenamingFolderId, onRenameFolder, onConfirmDeleteFolder, onNewSubfolder, onDropChat, dragOver, setDragOverFolder }) {
  const [draft, setDraft] = React.useState(folder.name);
  const inputRef = React.useRef(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  React.useEffect(() => {
    if (isRenaming) {
      setDraft(folder.name);
      setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select(); }, 0);
    }
  }, [isRenaming, folder.name]);
  const commit = () => { if (draft.trim() && draft !== folder.name) onRenameFolder(folder.id, draft); setRenamingFolderId(null); };

  return (
    <div className={`folder-row ${isOpen ? 'open' : ''}`}
         onClick={() => !isRenaming && onToggle(folder.id)}
         onDragOver={(e) => { if (e.dataTransfer.types.includes('text/chat-id')) { e.preventDefault(); setDragOverFolder(folder.id); } }}
         onDragLeave={() => setDragOverFolder(null)}
         onDrop={(e) => {
           e.preventDefault();
           const id = e.dataTransfer.getData('text/chat-id');
           if (id) onDropChat(id, folder.id);
           setDragOverFolder(null);
         }}
         style={{ paddingLeft: 8 + depth * 14, position: 'relative',
                  background: dragOver ? 'var(--accent-soft)' : undefined,
                  boxShadow: dragOver ? 'inset 0 0 0 1px var(--accent)' : undefined }}>
      <I.chevRight className="chev" size={14} style={{ visibility: hasChildren ? 'visible' : 'hidden' }} />
      <I.folderFill color={FOLDER_COLORS[folder.color]} size={16} />
      {isRenaming ? (
        <input ref={inputRef} value={draft} onChange={e => setDraft(e.target.value)}
          onClick={e => e.stopPropagation()}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setRenamingFolderId(null); }}
          style={{ flex: 1, minWidth: 0, border: 0, outline: 0, background: 'var(--surface)', borderRadius: 4, padding: '2px 6px', font: 'inherit', fontWeight: 500, color: 'var(--text)', boxShadow: '0 0 0 2px var(--accent-soft)' }}
        />
      ) : (
        <>
          <span className="name truncate">{folder.name}</span>
          <span className="actions">
            <button className="icon-btn" title="Rename" onClick={(e) => { e.stopPropagation(); setRenamingFolderId(folder.id); }}><I.pencil size={12}/></button>
            <button className="icon-btn" title="More" onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}><I.more size={12}/></button>
          </span>
          <span className="count">{count}</span>
        </>
      )}
      {menuOpen && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 60 }} onClick={(e) => { e.stopPropagation(); setMenuOpen(false); }}/>
          <div className="ctx-menu" style={{ left: 24, top: 28, position: 'absolute', zIndex: 70 }} onClick={e => e.stopPropagation()}>
            <div className="ctx-item" onClick={() => { setMenuOpen(false); setRenamingFolderId(folder.id); }}><I.pencil size={13}/>Rename</div>
            <div className="ctx-item" onClick={() => { setMenuOpen(false); onNewSubfolder(folder.id); }}><I.plus size={13}/>New subfolder</div>
            <div className="ctx-divider"/>
            <div className="ctx-item danger" onClick={() => { setMenuOpen(false); onConfirmDeleteFolder(folder); }}><I.trash size={13}/>Delete folder</div>
          </div>
        </>
      )}
    </div>
  );
}

function FoldersList({ folders, sessions, activeId, onSelect, expanded, setExpanded,
  renamingFolderId, setRenamingFolderId, onRenameFolder, onConfirmDeleteFolder, onNewFolder,
  renamingChatId, setRenamingChatId, onRenameChat, onConfirmDeleteChat, onMoveChatToFolder
}) {
  const roots = folders.filter(f => f.parentId === null).sort((a, b) => a.order - b.order);
  const [dragOverFolder, setDragOverFolder] = React.useState(null);

  const toggle = (id) => {
    const next = new Set(expanded);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpanded(next);
  };

  const renderFolder = (folder, depth = 0) => {
    const subs = folders.filter(f => f.parentId === folder.id);
    const ownChats = sessions.filter(s => s.folderId === folder.id);
    const allCount = ownChats.length + subs.reduce((acc, sf) => acc + sessions.filter(s => s.folderId === sf.id).length, 0);
    const isOpen = expanded.has(folder.id);
    const hasChildren = subs.length > 0 || ownChats.length > 0;

    return (
      <div key={folder.id}>
        <FolderRow folder={folder} depth={depth} isOpen={isOpen} hasChildren={hasChildren} count={allCount}
          onToggle={toggle}
          isRenaming={renamingFolderId === folder.id}
          setRenamingFolderId={setRenamingFolderId} onRenameFolder={onRenameFolder}
          onConfirmDeleteFolder={onConfirmDeleteFolder}
          onNewSubfolder={(parentId) => onNewFolder(parentId)}
          onDropChat={onMoveChatToFolder}
          dragOver={dragOverFolder === folder.id}
          setDragOverFolder={setDragOverFolder}
        />
        {isOpen && (
          <div className="folder-children" style={{ paddingLeft: 22 + depth * 14 }}>
            {subs.map(sf => renderFolder(sf, depth + 1))}
            {ownChats.map(s => (
              <ChatRow key={s.id} session={s} folder={folder}
                active={activeId === s.id} onSelect={onSelect}
                isRenaming={renamingChatId === s.id}
                setRenamingChatId={setRenamingChatId} onRenameChat={onRenameChat}
                onConfirmDeleteChat={onConfirmDeleteChat}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      <div className="sb-section-label">All folders</div>
      {roots.map(f => renderFolder(f))}
      <button className="new-folder-btn" onClick={() => onNewFolder(null)}><I.plus size={14} /><span>New folder</span></button>
    </>
  );
}

window.Sidebar = Sidebar;

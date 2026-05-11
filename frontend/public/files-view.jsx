function FilesView({ folders, sessions, currentFolderId, setCurrentFolderId, onOpenChat, viewMode, setViewMode, sortBy, setSortBy, sortDir, setSortDir, search, setSearch, selected, setSelected, onMoveChatToFolder, onNewFolder }) {

  const folderById = React.useMemo(() => Object.fromEntries(folders.map(f => [f.id, f])), [folders]);

  const breadcrumbs = React.useMemo(() => {
    const crumbs = [{ id: null, name: 'All files' }];
    if (currentFolderId) {
      let f = folderById[currentFolderId];
      const chain = [];
      while (f) {
        chain.unshift({ id: f.id, name: f.name });
        f = f.parentId ? folderById[f.parentId] : null;
      }
      crumbs.push(...chain);
    }
    return crumbs;
  }, [currentFolderId, folderById]);

  const visibleFolders = folders.filter(f => f.parentId === currentFolderId);
  const visibleSessions = sessions.filter(s => s.folderId === currentFolderId);

  // Filter by search
  const sLower = search.toLowerCase();
  const filteredFolders = sLower
    ? folders.filter(f => f.name.toLowerCase().includes(sLower))
    : visibleFolders;
  const filteredSessions = sLower
    ? sessions.filter(s => s.title.toLowerCase().includes(sLower))
    : visibleSessions;

  // Sort sessions
  const sortedSessions = React.useMemo(() => {
    const list = [...filteredSessions];
    list.sort((a, b) => {
      let r = 0;
      if (sortBy === 'name') r = a.title.localeCompare(b.title);
      else if (sortBy === 'modified') r = new Date(b.updatedAt) - new Date(a.updatedAt);
      else if (sortBy === 'size') r = b.messageCount - a.messageCount;
      else if (sortBy === 'folder') {
        const fa = a.folderId ? folderById[a.folderId]?.name || '' : 'zzz';
        const fb = b.folderId ? folderById[b.folderId]?.name || '' : 'zzz';
        r = fa.localeCompare(fb);
      }
      return sortDir === 'asc' ? r : -r;
    });
    return list;
  }, [filteredSessions, sortBy, sortDir, folderById]);

  const allSelected = sortedSessions.length > 0 && sortedSessions.every(s => selected.has(s.id));

  const navigateTo = (id) => { setCurrentFolderId(id); setSearch(''); };

  const toggleSel = (id, ev) => {
    ev?.stopPropagation();
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const setSort = (key) => {
    if (sortBy === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortBy(key); setSortDir(key === 'name' || key === 'folder' ? 'asc' : 'desc'); }
  };

  const sortArrow = (key) => sortBy === key ? (sortDir === 'asc' ? '↑' : '↓') : '';

  // Drag/drop
  const [dragChat, setDragChat] = React.useState(null);
  const [dropTarget, setDropTarget] = React.useState(null);

  return (
    <div className="files-view">
      <div className="files-toolbar">
        <div className="breadcrumb">
          {breadcrumbs.map((c, i) => (
            <React.Fragment key={c.id ?? 'root'}>
              {i > 0 && <span className="sep">›</span>}
              <span className={`seg ${i === breadcrumbs.length - 1 ? 'current' : ''}`}
                    onClick={() => i < breadcrumbs.length - 1 && navigateTo(c.id)}>
                {c.name}
              </span>
            </React.Fragment>
          ))}
        </div>

        <div style={{ flex: 1 }}/>

        <div className="search">
          <I.search size={14} style={{ color: 'var(--text-faint)' }} />
          <input placeholder="Search files & messages…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>

        <select className="topbar-btn" style={{ paddingRight: 8, appearance: 'none' }}
                value={sortBy} onChange={e => setSort(e.target.value)}>
          <option value="modified">Date modified</option>
          <option value="name">Name</option>
          <option value="size">Messages</option>
          <option value="folder">Folder</option>
        </select>

        <div className="seg-toggle">
          <button className={viewMode === 'grid' ? 'active' : ''} onClick={() => setViewMode('grid')} title="Grid view"><I.grid size={14} /></button>
          <button className={viewMode === 'list' ? 'active' : ''} onClick={() => setViewMode('list')} title="List view"><I.list size={14} /></button>
        </div>

        <button className="topbar-btn primary" onClick={() => onNewFolder?.(currentFolderId)}><I.plus size={14} />New folder</button>
      </div>

      <div className="files-body" style={{ position: 'relative' }}>
        {sLower && (
          <div className="files-section-label">Search results for "{search}"</div>
        )}

        {filteredFolders.length === 0 && sortedSessions.length === 0 ? (
          <EmptyState onCreate={() => onOpenChat(null, currentFolderId)} />
        ) : viewMode === 'grid' ? (
          <>
            {filteredFolders.length > 0 && (
              <>
                <div className="files-section-label">Folders</div>
                <div className="grid">
                  {filteredFolders.map(f => {
                    const count = sessions.filter(s => s.folderId === f.id).length
                      + folders.filter(sf => sf.parentId === f.id).reduce((a, sf) => a + sessions.filter(s => s.folderId === sf.id).length, 0);
                    return (
                      <div key={f.id}
                           className={`card ${dropTarget === f.id ? 'drop-target' : ''}`}
                           onDoubleClick={() => navigateTo(f.id)}
                           onDragOver={(e) => { e.preventDefault(); setDropTarget(f.id); }}
                           onDragLeave={() => setDropTarget(null)}
                           onDrop={(e) => {
                             e.preventDefault();
                             if (dragChat) onMoveChatToFolder(dragChat, f.id);
                             setDropTarget(null); setDragChat(null);
                           }}>
                        <div className="card-icon card-folder-icon">
                          <I.folderFill color={FOLDER_COLORS[f.color]} size={36} />
                        </div>
                        <div className="card-meta">{count} chats</div>
                        <div className="card-title">{f.name}</div>
                        <div className="card-actions">
                          <button title="Rename" onClick={(e) => e.stopPropagation()}><I.pencil size={12} /></button>
                          <button title="More" onClick={(e) => e.stopPropagation()}><I.more size={12} /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {sortedSessions.length > 0 && (
              <>
                <div className="files-section-label">Chats</div>
                <div className="grid">
                  {sortedSessions.map(s => {
                    const f = s.folderId ? folderById[s.folderId] : null;
                    return (
                      <div key={s.id}
                           className={`card ${selected.has(s.id) ? 'selected' : ''}`}
                           onDoubleClick={() => onOpenChat(s.id)}
                           draggable
                           onDragStart={() => setDragChat(s.id)}>
                        <div className="checkbox" onClick={(e) => toggleSel(s.id, e)}>
                          {selected.has(s.id) && <I.check size={11} strokeWidth={3} />}
                        </div>
                        <div className="card-icon" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
                          <I.msgSquare size={18} />
                        </div>
                        <div className="card-meta">
                          <span>{formatDate(s.updatedAt)}</span>
                          <span style={{ color: 'var(--text-faint)' }}>·</span>
                          <span>{s.messageCount} msgs</span>
                        </div>
                        <div className="card-title">{s.title}</div>
                        {f && (
                          <div style={{ marginTop: 4 }}>
                            <span className="card-folder-badge">
                              <span className="dot" style={{ background: FOLDER_COLORS[f.color] }}/>
                              {f.name}
                            </span>
                          </div>
                        )}
                        <div className="card-actions">
                          <button title="Open" onClick={(e) => { e.stopPropagation(); onOpenChat(s.id); }}><I.msgSquare size={12} /></button>
                          <button title="More" onClick={(e) => e.stopPropagation()}><I.more size={12} /></button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        ) : (
          <ListView folders={filteredFolders} sessions={sortedSessions} folderById={folderById}
                    selected={selected} toggleSel={toggleSel}
                    setSort={setSort} sortArrow={sortArrow} sortBy={sortBy}
                    onOpenChat={onOpenChat} onOpenFolder={navigateTo}
                    sessionsAll={sessions} foldersAll={folders}
                    setAllSelected={(b) => setSelected(b ? new Set(sortedSessions.map(s => s.id)) : new Set())}
                    allSelected={allSelected}
          />
        )}

        {selected.size > 0 && (
          <div className="multiselect-bar">
            <span className="count">{selected.size} {selected.size === 1 ? 'item' : 'items'} selected</span>
            <span className="sep"/>
            <button><I.move size={13} />Move to…</button>
            <button><I.download size={13} />Download</button>
            <button className="danger"><I.trash size={13} />Delete</button>
            <span className="sep"/>
            <button onClick={() => setSelected(new Set())} title="Clear"><I.x size={13} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

function ListView({ folders, sessions, folderById, selected, toggleSel, setSort, sortArrow, sortBy, onOpenChat, onOpenFolder, foldersAll, sessionsAll, allSelected, setAllSelected }) {
  return (
    <div className="list">
      <div className="list-row header">
        <div className="checkbox-cell" onClick={() => setAllSelected(!allSelected)} style={{ cursor: 'pointer' }}>
          {allSelected && <I.check size={11} strokeWidth={3} style={{ color: 'var(--accent)' }} />}
        </div>
        <div></div>
        <div className="col-sort" onClick={() => setSort('name')}>Name {sortArrow('name')}</div>
        <div className="col-sort" onClick={() => setSort('folder')}>Folder {sortArrow('folder')}</div>
        <div className="col-sort" onClick={() => setSort('modified')}>Modified {sortArrow('modified')}</div>
        <div className="col-sort" onClick={() => setSort('size')}>Messages {sortArrow('size')}</div>
        <div></div>
      </div>
      {folders.map(f => {
        const count = sessionsAll.filter(s => s.folderId === f.id).length;
        return (
          <div key={f.id} className="list-row" onDoubleClick={() => onOpenFolder(f.id)}>
            <div></div>
            <div><I.folderFill color={FOLDER_COLORS[f.color]} size={18} /></div>
            <div style={{ fontWeight: 500 }} className="truncate">{f.name}</div>
            <div style={{ color: 'var(--text-faint)' }}>—</div>
            <div style={{ color: 'var(--text-muted)' }} className="truncate mono" >folder</div>
            <div style={{ color: 'var(--text-muted)' }} className="mono">{count}</div>
            <div className="col-actions">
              <button onClick={(e) => e.stopPropagation()}><I.pencil size={12} /></button>
              <button onClick={(e) => e.stopPropagation()}><I.more size={12} /></button>
            </div>
          </div>
        );
      })}
      {sessions.map(s => {
        const f = s.folderId ? folderById[s.folderId] : null;
        return (
          <div key={s.id}
               className={`list-row ${selected.has(s.id) ? 'selected' : ''}`}
               onDoubleClick={() => onOpenChat(s.id)}>
            <div className="checkbox-cell" onClick={(e) => toggleSel(s.id, e)} style={{ cursor: 'pointer' }}>
              {selected.has(s.id) && <I.check size={11} strokeWidth={3} style={{ color: 'white' }} />}
            </div>
            <div style={{ color: 'var(--text-muted)' }}><I.msgSquare size={16} /></div>
            <div className="truncate">{s.title}</div>
            <div style={{ color: 'var(--text-muted)' }}>
              {f ? (
                <span className="card-folder-badge">
                  <span className="dot" style={{ background: FOLDER_COLORS[f.color] }}/>
                  {f.name}
                </span>
              ) : <span style={{ color: 'var(--text-faint)' }}>—</span>}
            </div>
            <div style={{ color: 'var(--text-muted)' }} className="mono">{formatDate(s.updatedAt)}</div>
            <div style={{ color: 'var(--text-muted)' }} className="mono">{s.messageCount}</div>
            <div className="col-actions">
              <button onClick={(e) => { e.stopPropagation(); onOpenChat(s.id); }} title="Open"><I.msgSquare size={12} /></button>
              <button onClick={(e) => e.stopPropagation()} title="Rename"><I.pencil size={12} /></button>
              <button onClick={(e) => e.stopPropagation()} title="More"><I.more size={12} /></button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EmptyState({ onCreate }) {
  return (
    <div style={{ textAlign: 'center', padding: '80px 20px' }}>
      <div style={{ width: 56, height: 56, borderRadius: 12, background: 'var(--surface-2)', display: 'inline-grid', placeItems: 'center', color: 'var(--text-faint)', marginBottom: 14 }}>
        <I.folder size={26} />
      </div>
      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>This folder is empty</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 18 }}>Drag chats here or create a new chat inside this folder.</div>
      <button className="topbar-btn primary" onClick={onCreate} style={{ height: 34, padding: '0 14px' }}>
        <I.plus size={14} /> New chat in this folder
      </button>
    </div>
  );
}

window.FilesView = FilesView;

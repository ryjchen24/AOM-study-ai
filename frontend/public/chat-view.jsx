function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Minimal markdown → HTML for streaming assistant messages. Matches the look of
// the seed messages (which already use raw <p>/<ul>/<code>) by emitting the
// same tags. Fenced code blocks are extracted first so their bodies escape the
// rest of the inline rules.
function renderMarkdown(text) {
  if (!text) return '';
  const codeBlocks = [];
  let t = text.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(escapeHtml(code.replace(/\n$/, '')));
    return `@@CODEBLOCK${codeBlocks.length - 1}@@`;
  });
  t = escapeHtml(t);
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/(?:^|\n)((?:[*\-] .+(?:\n|$))+)/g, (_m, block) => {
    const items = block.trim().split('\n')
      .map(l => `<li>${l.replace(/^[*\-] /, '')}</li>`).join('');
    return `\n<ul>${items}</ul>\n`;
  });
  t = t.split(/\n{2,}/).map(p => {
    p = p.trim();
    if (!p) return '';
    if (p.startsWith('<ul>') || p.startsWith('@@CODEBLOCK')) return p;
    return `<p>${p.replace(/\n/g, '<br/>')}</p>`;
  }).join('');
  t = t.replace(/@@CODEBLOCK(\d+)@@/g, (_, i) => (
    `<pre style="background:var(--surface-3);padding:10px 12px;border-radius:8px;overflow-x:auto;margin:8px 0;font-size:12.5px;"><code style="background:transparent;padding:0;">${codeBlocks[Number(i)]}</code></pre>`
  ));
  return t;
}

// Rough character→token heuristic. Real tokenizers vary by model; this is just
// for the "~N tokens" hint above the send button.
function estimateTokens(text, attachments = []) {
  const charBudget = (text?.length || 0)
    + attachments.reduce((n, a) => n + (a.kind === 'text' ? (a.data?.length || 0) : 0), 0);
  const imageEst = attachments.filter(a => a.kind === 'image').length * 300;
  return Math.max(0, Math.ceil(charBudget / 4) + imageEst);
}

const TEXT_FILE_EXTS = new Set([
  'txt','md','markdown','csv','tsv','json','log','yaml','yml','xml','html','htm',
  'css','scss','sass','js','jsx','ts','tsx','py','rb','go','rs','java','c','h',
  'cpp','hpp','cs','php','sh','bash','zsh','sql','toml','ini','env','conf',
]);

function classifyFile(file) {
  if (file.type.startsWith('image/')) return 'image';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (file.type.startsWith('text/') || TEXT_FILE_EXTS.has(ext)) return 'text';
  return null;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result;
      const idx = String(result).indexOf(',');
      resolve(idx >= 0 ? String(result).slice(idx + 1) : String(result));
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = reject;
    r.readAsText(file);
  });
}

function ChatView({ session, folders, model, modelId, onSetTitle, onMoveToFolder, onSessionActivity, sendOnEnter = true, chatMessagesRef }) {
  const folder = session?.folderId ? folders.find(f => f.id === session.folderId) : null;

  // Per-session message state. Keyed in a ref so different chats keep their own edits.
  const editsRef = React.useRef({});
  const [messages, setMessages] = React.useState([]);
  const [confirmTurn, setConfirmTurn] = React.useState(null); // turn index pending delete
  const [confirmTrim, setConfirmTrim] = React.useState(false);

  // Composer state
  const [input, setInput] = React.useState('');
  const [attachments, setAttachments] = React.useState([]);
  const [streaming, setStreaming] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState(null);
  const [listening, setListening] = React.useState(false);
  const fileInputRef = React.useRef(null);
  const textareaRef = React.useRef(null);
  const abortRef = React.useRef(null);
  const recognitionRef = React.useRef(null);
  const threadRef = React.useRef(null);

  React.useEffect(() => {
    if (!session) return;
    if (editsRef.current[session.id]) {
      setMessages(editsRef.current[session.id]);
    } else {
      const seed = sampleMessages(session).map((m, i) => ({ ...m, id: `${session.id}-${i}` }));
      editsRef.current[session.id] = seed;
      setMessages(seed);
    }
    // Abort any in-flight stream from a previous session.
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setErrorMsg(null);
    setInput('');
    setAttachments([]);
  }, [session?.id]);

  // Auto-scroll thread to bottom on new content.
  React.useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  // Mirror current messages out to the parent ref so the Export button can
  // grab them without lifting all of ChatView's state up.
  React.useEffect(() => {
    if (session && chatMessagesRef) {
      chatMessagesRef.current[session.id] = messages;
    }
  }, [messages, session?.id]);

  // Cleanup speech recognition on unmount.
  React.useEffect(() => () => {
    try { recognitionRef.current?.stop(); } catch {}
    abortRef.current?.abort();
  }, []);

  if (!session) {
    return <EmptyChat model={model} />;
  }

  const persistMessages = (next) => {
    editsRef.current[session.id] = next;
    setMessages(next);
    onSessionActivity?.(session.id, { count: next.filter(m => m.role !== 'system').length });
  };

  // Group consecutive [user, assistant] pairs into "turns" so we can delete them together.
  const turns = React.useMemo(() => {
    const out = [];
    let i = 0;
    while (i < messages.length) {
      const m = messages[i];
      if (m.role === 'user' && messages[i + 1]?.role === 'assistant') {
        out.push({ user: m, assistant: messages[i + 1], indices: [i, i + 1] });
        i += 2;
      } else {
        out.push({ [m.role]: m, indices: [i] });
        i += 1;
      }
    }
    return out;
  }, [messages]);

  const removeTurn = (turnIdx) => {
    const { indices } = turns[turnIdx];
    const drop = new Set(indices);
    persistMessages(messages.filter((_, i) => !drop.has(i)));
    setConfirmTurn(null);
  };

  const removeMessage = (msgIdx) => {
    persistMessages(messages.filter((_, i) => i !== msgIdx));
  };

  const onAttachClick = () => fileInputRef.current?.click();

  const onFilesPicked = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // allow picking the same file again
    const next = [];
    for (const f of files) {
      const kind = classifyFile(f);
      if (!kind) {
        setErrorMsg(`Skipped "${f.name}" — only images and text files are supported right now.`);
        continue;
      }
      if (f.size > 8 * 1024 * 1024) {
        setErrorMsg(`Skipped "${f.name}" — files must be under 8 MB.`);
        continue;
      }
      try {
        const data = kind === 'image' ? await readFileAsBase64(f) : await readFileAsText(f);
        next.push({
          id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: f.name,
          mime: f.type || (kind === 'image' ? 'image/png' : 'text/plain'),
          kind,
          data,
          previewUrl: kind === 'image' ? `data:${f.type || 'image/png'};base64,${data}` : null,
        });
      } catch (err) {
        setErrorMsg(`Could not read "${f.name}".`);
      }
    }
    if (next.length) setAttachments(prev => [...prev, ...next]);
  };

  const removeAttachment = (id) => setAttachments(prev => prev.filter(a => a.id !== id));

  const buildAttachmentHtmlPreview = (atts) => {
    if (!atts.length) return '';
    const chips = atts.map(a => {
      if (a.kind === 'image' && a.previewUrl) {
        return `<img src="${a.previewUrl}" alt="${escapeHtml(a.name)}" style="max-width:220px;max-height:160px;border-radius:6px;display:block;margin:6px 0;border:1px solid rgba(255,255,255,0.18);" />`;
      }
      return `<div style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 8px;background:rgba(255,255,255,0.12);border-radius:999px;margin:4px 6px 4px 0;">📎 ${escapeHtml(a.name)}</div>`;
    }).join('');
    return `<div>${chips}</div>`;
  };

  const sendMessage = async () => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    if (streaming) return;

    const userMsg = {
      id: `${session.id}-u-${Date.now()}`,
      role: 'user',
      text,
      attachments: attachments.map(({ id, previewUrl, ...rest }) => rest),
      html: (buildAttachmentHtmlPreview(attachments) + (text ? `<p>${escapeHtml(text).replace(/\n/g, '<br/>')}</p>` : '')) || '<p></p>',
    };
    const assistantMsg = {
      id: `${session.id}-a-${Date.now()}`,
      role: 'assistant',
      text: '',
      html: '<p style="color: var(--text-faint);">…</p>',
      streaming: true,
    };

    const next = [...messages, userMsg, assistantMsg];
    persistMessages(next);

    // Auto-title new chats from the first user message.
    const isFirstUserMessage = messages.filter(m => m.role === 'user').length === 0;
    if (isFirstUserMessage && session.title === 'New chat' && text) {
      const auto = text.length > 60 ? text.slice(0, 60).trim() + '…' : text;
      onSetTitle?.(auto);
    }

    setInput('');
    setAttachments([]);
    setErrorMsg(null);

    // Build the API payload — strip presentational fields, keep role/text/attachments.
    const payload = {
      modelId,
      messages: next.slice(0, -1).map(m => ({
        role: m.role,
        text: m.text || '',
        attachments: m.attachments || [],
      })),
    };

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);

    let acc = '';
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`Server returned ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          try {
            const evt = JSON.parse(data);
            if (evt.type === 'token') {
              acc += evt.text;
              // Update only the streaming assistant message — avoid full
              // setMessages spread on every token by mutating its html.
              const arr = editsRef.current[session.id];
              const last = arr[arr.length - 1];
              if (last && last.id === assistantMsg.id) {
                last.text = acc;
                last.html = renderMarkdown(acc);
                setMessages([...arr]);
              }
            } else if (evt.type === 'error') {
              throw new Error(evt.message || 'Stream error');
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }
      // Finalize streaming flag
      const arr = editsRef.current[session.id];
      const last = arr[arr.length - 1];
      if (last && last.id === assistantMsg.id) {
        last.streaming = false;
        if (!acc) {
          last.html = '<p style="color:var(--text-faint);"><em>(empty response)</em></p>';
        }
        editsRef.current[session.id] = [...arr];
        setMessages([...arr]);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // Mark assistant message as cancelled
        const arr = editsRef.current[session.id];
        const last = arr[arr.length - 1];
        if (last && last.id === assistantMsg.id) {
          last.streaming = false;
          last.html = (last.html || '') + '<p style="color:var(--text-faint);font-size:12px;"><em>(stopped)</em></p>';
          setMessages([...arr]);
        }
      } else {
        setErrorMsg(err.message || 'Something went wrong while contacting the model.');
        // Remove the empty assistant placeholder
        const arr = editsRef.current[session.id].filter(m => m.id !== assistantMsg.id);
        editsRef.current[session.id] = arr;
        setMessages(arr);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const stopStreaming = () => {
    abortRef.current?.abort();
  };

  const trimContext = () => {
    persistMessages([]);
    setConfirmTrim(false);
  };

  const onKeyDown = (e) => {
    const isSend = sendOnEnter
      ? (e.key === 'Enter' && !e.shiftKey)
      : (e.key === 'Enter' && (e.metaKey || e.ctrlKey));
    if (isSend) {
      e.preventDefault();
      sendMessage();
    }
  };

  // Voice input via Web Speech API. Appends recognized text to the current input.
  const toggleVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setErrorMsg('Voice input is not supported in this browser. Try Chrome or Edge.');
      return;
    }
    if (listening) {
      try { recognitionRef.current?.stop(); } catch {}
      return;
    }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = navigator.language || 'en-US';
    rec.onresult = (e) => {
      const transcript = Array.from(e.results)
        .map(r => r[0]?.transcript || '').join(' ').trim();
      if (transcript) {
        setInput(prev => (prev ? prev + ' ' : '') + transcript);
        setTimeout(() => textareaRef.current?.focus(), 0);
      }
    };
    rec.onerror = (e) => setErrorMsg(`Voice error: ${e.error || 'unknown'}`);
    rec.onend = () => { setListening(false); recognitionRef.current = null; };
    recognitionRef.current = rec;
    setListening(true);
    try { rec.start(); } catch (e) { setListening(false); }
  };

  const canSend = (input.trim().length > 0 || attachments.length > 0) && !streaming;

  return (
    <div className="chat-view">
      <div className="chat-thread" ref={threadRef}>
        <div className="chat-inner">
          {turns.length === 0 && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)' }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--surface-2)', display: 'inline-grid', placeItems: 'center', marginBottom: 12, color: 'var(--text-faint)' }}>
                <I.msgSquare size={20}/>
              </div>
              <div style={{ fontWeight: 500, fontSize: 14, color: 'var(--text)' }}>No messages in this chat</div>
              <div style={{ fontSize: 12.5, marginTop: 4 }}>Send a message below to get started.</div>
            </div>
          )}
          {turns.map((t, ti) => (
            <Turn key={t.indices.join('-')} turn={t} turnIdx={ti}
              onAskDelete={() => setConfirmTurn(ti)}
              onDeleteMessage={removeMessage}
            />
          ))}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="context-strip">
          {folder && (
            <span className="card-folder-badge" style={{ padding: '1px 8px' }}>
              <span className="dot" style={{ background: FOLDER_COLORS[folder.color] }}/>
              {folder.name}
            </span>
          )}
          <span>{model}</span>
          <span className="sep"/>
          <span>{messages.length} messages in context</span>
          <span className="right">
            <span className="link" onClick={() => messages.length > 0 && setConfirmTrim(true)}
              style={messages.length === 0 ? { opacity: 0.4, cursor: 'default' } : null}>
              Trim context
            </span>
          </span>
        </div>

        {errorMsg && (
          <div style={{ maxWidth: 760, margin: '0 auto 8px', padding: '8px 12px',
                        background: 'oklch(96% 0.04 27)', color: 'var(--danger)',
                        border: '1px solid oklch(82% 0.09 27)', borderRadius: 8,
                        fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1 }}>{errorMsg}</span>
            <button onClick={() => setErrorMsg(null)} style={{ color: 'inherit', padding: 2 }}><I.x size={12}/></button>
          </div>
        )}

        <div className="composer">
          {attachments.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '10px 12px 0' }}>
              {attachments.map(a => (
                <span key={a.id}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                               fontSize: 12, padding: '4px 6px 4px 10px',
                               background: 'var(--surface-2)', border: '1px solid var(--border)',
                               borderRadius: 999, color: 'var(--text-muted)' }}>
                  {a.kind === 'image' ? <span>🖼️</span> : <I.paperclip size={11}/>}
                  <span className="truncate" style={{ maxWidth: 180 }}>{a.name}</span>
                  <button onClick={() => removeAttachment(a.id)}
                          style={{ width: 18, height: 18, display: 'grid', placeItems: 'center',
                                   borderRadius: 4, color: 'var(--text-faint)' }} title="Remove">
                    <I.x size={11}/>
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            placeholder="Message StudyAI…"
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={streaming}
          />
          <div className="composer-toolbar">
            <input ref={fileInputRef} type="file" multiple accept="image/*,text/*,.md,.csv,.json,.txt,.js,.jsx,.ts,.tsx,.py,.html,.css,.yaml,.yml,.xml,.sh,.sql"
                   style={{ display: 'none' }} onChange={onFilesPicked}/>
            <button className="icon-btn" title="Attach files" onClick={onAttachClick} disabled={streaming}>
              <I.paperclip size={15} />
            </button>
            <button className="icon-btn" title={listening ? 'Stop listening' : 'Voice input'}
                    onClick={toggleVoice}
                    style={listening ? { color: 'var(--danger)' } : null}>
              <I.mic size={15} />
            </button>
            <div className="right">
              <span className="token-est mono">~{estimateTokens(input, attachments)} tokens</span>
              {streaming ? (
                <button className="send-btn" onClick={stopStreaming} title="Stop"
                        style={{ background: 'var(--danger)' }}>
                  <span style={{ width: 10, height: 10, background: 'white', borderRadius: 2, display: 'inline-block' }}/>
                </button>
              ) : (
                <button className="send-btn" disabled={!canSend} onClick={sendMessage} title="Send">
                  <I.arrowUp size={14} stroke="white" strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {confirmTurn !== null && (
        <ConfirmModal
          title="Delete this exchange?"
          body={<>This will remove both your message and the AI response from this chat. This can't be undone.</>}
          confirmText="Delete exchange"
          danger
          onCancel={() => setConfirmTurn(null)}
          onConfirm={() => removeTurn(confirmTurn)}
        />
      )}
      {confirmTrim && (
        <ConfirmModal
          title="Trim context?"
          body={<>This will clear every message in this chat. This can't be undone.</>}
          confirmText="Clear messages"
          danger
          onCancel={() => setConfirmTrim(false)}
          onConfirm={trimContext}
        />
      )}
    </div>
  );
}

function Turn({ turn, turnIdx, onAskDelete, onDeleteMessage }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div className="turn"
         onMouseEnter={() => setHover(true)}
         onMouseLeave={() => setHover(false)}
         style={{ position: 'relative', padding: '6px 0', borderRadius: 12,
                  transition: 'background 120ms',
                  background: hover ? 'var(--surface-2)' : 'transparent' }}>
      {turn.user && (
        <Bubble m={turn.user} idx={turn.indices[0]}
          onDelete={turn.assistant ? null : () => onDeleteMessage(turn.indices[0])}
          showDelete={hover && !turn.assistant} />
      )}
      {turn.assistant && (
        <Bubble m={turn.assistant} idx={turn.indices[turn.user ? 1 : 0]}
          onDelete={turn.user ? null : () => onDeleteMessage(turn.indices[0])}
          showDelete={hover && !turn.user} />
      )}
      {turn.user && turn.assistant && hover && !turn.assistant.streaming && (
        <div className="turn-actions">
          <button className="turn-btn danger" onClick={onAskDelete} title="Delete this exchange">
            <I.trash size={12}/>
            <span>Delete exchange</span>
          </button>
        </div>
      )}
    </div>
  );
}

function Bubble({ m, idx, onDelete, showDelete }) {
  return (
    <div className={`msg-row ${m.role}`}>
      <div className={`msg-avatar ${m.role === 'assistant' ? 'ai' : ''}`}
           style={m.role === 'user' ? { background: 'var(--c-coral)' } : {}}>
        {m.role === 'user' ? 'JM' : <I.sparkle size={13} stroke="white" />}
      </div>
      <div style={{ position: 'relative', maxWidth: '86%' }}>
        <div className="msg-bubble" style={{ maxWidth: '100%' }} dangerouslySetInnerHTML={{ __html: m.html }} />
        {showDelete && onDelete && (
          <button className="msg-del" onClick={onDelete} title="Delete this message"><I.trash size={11}/></button>
        )}
      </div>
    </div>
  );
}

function EmptyChat({ model }) {
  const chips = ['Explain a concept', 'Help with an essay', 'Solve a problem', 'Summarize notes'];
  return (
    <div className="chat-view">
      <div className="chat-thread" style={{ display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center', padding: '0 24px' }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: 'var(--accent-soft)', color: 'var(--accent)', display: 'inline-grid', placeItems: 'center', marginBottom: 18 }}>
            <I.sparkle size={28} />
          </div>
          <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', marginBottom: 6 }}>What do you want to work on?</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 22 }}>Using {model}</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
            {chips.map(c => (
              <button key={c} className="topbar-btn" style={{ height: 32, borderRadius: 999 }}>{c}</button>
            ))}
          </div>
          <div style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 24 }}>
            Pick or create a chat from the sidebar to start.
          </div>
        </div>
      </div>
      <div className="composer-wrap">
        <div className="composer">
          <textarea placeholder="Message StudyAI…" rows={1} disabled />
          <div className="composer-toolbar">
            <button className="icon-btn" disabled><I.paperclip size={15} /></button>
            <button className="icon-btn" disabled><I.mic size={15} /></button>
            <div className="right">
              <span className="token-est mono">~0 tokens</span>
              <button className="send-btn" disabled><I.arrowUp size={14} stroke="white" strokeWidth={2.5} /></button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function sampleMessages(session) {
  const map = {
    s1: [
      { role: 'user', html: '<p>Can you explain the difference between SN1 and SN2 reactions?</p>' },
      { role: 'assistant', html: `
        <p>Sure — they’re both nucleophilic substitution reactions, but they differ in how the bond breaking and forming occurs.</p>
        <p><strong>SN2 (bimolecular)</strong>: a single concerted step. The nucleophile attacks the carbon from the opposite side of the leaving group, causing inversion of configuration (like an umbrella flipping).</p>
        <p><strong>SN1 (unimolecular)</strong>: a two-step mechanism. The leaving group departs first to form a carbocation, then the nucleophile attacks the planar intermediate from either face, giving racemic products.</p>
        <p>Quick reference:</p>
        <ul>
          <li>SN2 favors <em>primary</em> substrates and strong nucleophiles</li>
          <li>SN1 favors <em>tertiary</em> substrates and polar protic solvents</li>
          <li>SN2 rate depends on <code>[substrate][Nu]</code>; SN1 only on <code>[substrate]</code></li>
        </ul>
      ` },
      { role: 'user', html: '<p>What about secondary substrates? Which one wins?</p>' },
      { role: 'assistant', html: `
        <p>Secondary substrates are the gray zone — both pathways are possible, and the outcome depends on conditions:</p>
        <ul>
          <li><strong>Strong nucleophile + aprotic solvent</strong> (e.g. DMSO, acetone) → SN2 dominates</li>
          <li><strong>Weak nucleophile + protic solvent</strong> (e.g. water, methanol) → SN1 dominates</li>
        </ul>
        <p>You can also see mixed kinetics in many real reactions. If you see partial racemization, that’s a tell that some SN1 character is sneaking in.</p>
      ` },
    ],
    s4: [
      { role: 'user', html: '<p>Walk me through ∫ x·e^x dx using integration by parts.</p>' },
      { role: 'assistant', html: `
        <p>Let’s use the formula <code>∫ u dv = uv − ∫ v du</code>.</p>
        <p>Pick:</p>
        <ul>
          <li><code>u = x</code> → <code>du = dx</code></li>
          <li><code>dv = e^x dx</code> → <code>v = e^x</code></li>
        </ul>
        <p>Substituting:</p>
        <p><code>∫ x·e^x dx = x·e^x − ∫ e^x dx = x·e^x − e^x + C = e^x(x − 1) + C</code></p>
        <p>The trick is choosing <code>u</code> via <strong>LIATE</strong> (Logarithmic, Inverse trig, Algebraic, Trig, Exponential) — algebraic beats exponential, so <code>x</code> goes as <code>u</code>.</p>
      ` },
      { role: 'user', html: '<p>Got it. Try ∫ x²·sin(x) dx — feels like I’ll need it twice.</p>' },
      { role: 'assistant', html: `
        <p>Yep, two passes. First round: <code>u = x²</code>, <code>dv = sin(x) dx</code> → <code>du = 2x dx</code>, <code>v = −cos(x)</code>.</p>
        <p>So <code>∫ x²·sin(x) dx = −x²·cos(x) + 2∫ x·cos(x) dx</code>.</p>
        <p>Second round on <code>∫ x·cos(x) dx</code>: <code>u = x</code>, <code>dv = cos(x) dx</code> → gives <code>x·sin(x) + cos(x)</code>.</p>
        <p>Combine: <code>−x²·cos(x) + 2x·sin(x) + 2·cos(x) + C</code>.</p>
      ` },
    ],
    s12: [
      { role: 'user', html: '<p>Summarize the key innovations in attention mechanisms since 2017.</p>' },
      { role: 'assistant', html: `
        <p>A rough timeline of attention milestones:</p>
        <ul>
          <li><strong>2017 — Vaswani et al.</strong>: scaled dot-product attention + multi-head attention. Replaced recurrence with parallelizable self-attention.</li>
          <li><strong>2019 — Sparse Transformers</strong>: factorized attention patterns to extend context.</li>
          <li><strong>2020 — Linformer / Performer</strong>: linear-complexity approximations via low-rank or kernel feature maps.</li>
          <li><strong>2022 — FlashAttention</strong>: IO-aware exact attention. Massive practical speedup, no quality tradeoff.</li>
          <li><strong>2023+ — Sliding-window + ring attention</strong>: long-context inference at million-token scale.</li>
        </ul>
        <p>Want me to expand on any of these or pull citations?</p>
      ` },
    ],
  };
  // Seed-data demo sessions keep their HTML; new sessions start empty.
  const seeded = map[session.id];
  if (seeded) return seeded.map(m => ({ ...m, text: stripHtml(m.html) }));
  return [];
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

window.ChatView = ChatView;
window.renderMarkdown = renderMarkdown;
window.escapeHtml = escapeHtml;

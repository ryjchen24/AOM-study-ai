function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// KaTeX math as a marked extension so $$...$$ (display) and $...$ (inline) are
// rendered the way Claude renders them. Bad TeX is shown inline in red rather
// than throwing (throwOnError:false), so one typo can't blank the whole message.
function renderMath(tex, display) {
  if (!window.katex) return escapeHtml((display ? '$$' : '$') + tex + (display ? '$$' : '$'));
  return window.katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' });
}

const mathExtension = {
  extensions: [
    {
      name: 'blockMath',
      level: 'block',
      start(src) { const i = src.indexOf('$$'); return i < 0 ? undefined : i; },
      tokenizer(src) {
        const m = /^\$\$([\s\S]+?)\$\$/.exec(src);
        if (m) return { type: 'blockMath', raw: m[0], text: m[1].trim() };
      },
      renderer(token) { return renderMath(token.text, true); },
    },
    {
      name: 'inlineMath',
      level: 'inline',
      start(src) { const i = src.indexOf('$'); return i < 0 ? undefined : i; },
      tokenizer(src) {
        let m = /^\$\$([^\n]+?)\$\$/.exec(src);
        if (m) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: true };
        // Single-$ inline: require non-space just inside the delimiters so prose
        // like "$5 and $10" isn't swallowed as math.
        m = /^\$(?!\s)([^$\n]+?)(?<!\s)\$/.exec(src);
        if (m) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: false };
      },
      renderer(token) { return renderMath(token.text, token.display); },
    },
  ],
};

// Configure marked once (GFM tables/lists/etc. + soft line breaks + math).
let markedReady = false;
function ensureMarked() {
  if (markedReady || !window.marked) return markedReady;
  window.marked.use({ gfm: true, breaks: true }, mathExtension);
  markedReady = true;
  return true;
}

// Plain-text fallback used when the CDN libraries haven't loaded.
function renderPlain(text) {
  return text
    ? text.split(/\n{2,}/).map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`).join('')
    : '';
}

// Markdown + math → sanitized HTML. Renders GitHub-flavored markdown (headings,
// tables, lists, blockquotes, code, rules, links) and LaTeX math, then runs the
// result through DOMPurify before it reaches dangerouslySetInnerHTML.
function renderMarkdown(text) {
  if (!text) return '';
  if (!ensureMarked()) return renderPlain(text);
  let html;
  try {
    html = window.marked.parse(text);
  } catch (e) {
    return renderPlain(text);
  }
  return window.DOMPurify ? window.DOMPurify.sanitize(html) : html;
}

// Builds the bubble HTML for a message loaded from the API (which only has
// role/text/attachments — not the optimistic html we generate on send).
function renderMessageHtml(role, text, atts) {
  if (role === 'assistant') return renderMarkdown(text || '') || '<p></p>';
  const chips = (atts || []).map(a => {
    if (a.kind === 'image' && a.data) {
      const url = `data:${a.mime || 'image/png'};base64,${a.data}`;
      return `<img src="${url}" alt="${escapeHtml(a.name || '')}" style="max-width:220px;max-height:160px;border-radius:6px;display:block;margin:6px 0;border:1px solid rgba(255,255,255,0.18);" />`;
    }
    return `<div style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 8px;background:rgba(255,255,255,0.12);border-radius:999px;margin:4px 6px 4px 0;">📎 ${escapeHtml(a.name || '')}</div>`;
  }).join('');
  const chipBlock = chips ? `<div>${chips}</div>` : '';
  const textBlock = text ? renderMarkdown(text) : '';
  return (chipBlock + textBlock) || '<p></p>';
}

function dbMessageToUi(m) {
  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  return {
    id: m.id,
    role: m.role,
    text: m.text || '',
    attachments: atts,
    html: renderMessageHtml(m.role, m.text || '', atts),
  };
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

function ChatView({ session, folders, user, model, modelId, onSetTitle, onMoveToFolder, onSessionActivity, sendOnEnter = true, chatMessagesRef }) {
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
    // Abort any in-flight stream from a previous session.
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    setErrorMsg(null);
    setInput('');
    setAttachments([]);

    // Cached state for this session wins — avoids refetching mid-conversation
    // and preserves any local UI state (e.g., a freshly-streamed response that
    // we haven't navigated away from yet).
    if (editsRef.current[session.id]) {
      setMessages(editsRef.current[session.id]);
      return;
    }

    // Otherwise, fetch from the API. `cancelled` guards against the user
    // switching sessions before the fetch resolves — without it, a slow fetch
    // for session A could clobber state for session B.
    let cancelled = false;
    const sid = session.id;
    setMessages([]);
    (async () => {
      try {
        const res = await fetch(`/api/sessions/${sid}/messages`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        const ui = data.map(dbMessageToUi);
        editsRef.current[sid] = ui;
        setMessages(ui);
      } catch (e) {
        if (!cancelled) {
          console.error('Failed to load messages', e);
          setErrorMsg('Could not load messages for this chat.');
        }
      }
    })();
    return () => { cancelled = true; };
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

  const removeTurn = async (turnIdx) => {
    const { indices } = turns[turnIdx];
    const drop = new Set(indices);
    const ids = messages.filter((_, i) => drop.has(i)).map(m => m.id).filter(Boolean);
    try {
      if (ids.length) {
        const res = await fetch('/api/messages', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      persistMessages(messages.filter((_, i) => !drop.has(i)));
      setConfirmTurn(null);
    } catch (e) {
      console.error('Failed to delete turn', e);
      setErrorMsg('Could not delete that exchange.');
    }
  };

  const removeMessage = async (msgIdx) => {
    const msg = messages[msgIdx];
    try {
      if (msg?.id) {
        const res = await fetch('/api/messages', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [msg.id] }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      persistMessages(messages.filter((_, i) => i !== msgIdx));
    } catch (e) {
      console.error('Failed to delete message', e);
      setErrorMsg('Could not delete that message.');
    }
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
      html: (buildAttachmentHtmlPreview(attachments) + (text ? renderMarkdown(text) : '')) || '<p></p>',
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

      // Persist the completed exchange. We do this AFTER streaming so the
      // assistant row stores its full final text rather than partial chunks.
      // Skip if the model returned nothing — that's not a "successful exchange."
      if (acc) {
        try {
          const userResp = await fetch(`/api/sessions/${session.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              role: 'user',
              text: userMsg.text || '',
              attachments: userMsg.attachments,
            }),
          });
          if (!userResp.ok) throw new Error(`HTTP ${userResp.status}`);
          const savedUser = await userResp.json();

          const asstResp = await fetch(`/api/sessions/${session.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              role: 'assistant',
              text: acc,
            }),
          });
          if (!asstResp.ok) throw new Error(`HTTP ${asstResp.status}`);
          const savedAsst = await asstResp.json();

          // Swap the temporary local ids for the DB-assigned ones so future
          // deletes (turn / single-message / trim) can target the right rows.
          const after = editsRef.current[session.id].map(m => {
            if (m.id === userMsg.id) return { ...m, id: savedUser.id };
            if (m.id === assistantMsg.id) return { ...m, id: savedAsst.id };
            return m;
          });
          editsRef.current[session.id] = after;
          setMessages(after);
        } catch (e) {
          console.error('Failed to persist messages', e);
          setErrorMsg('Chat completed but the messages were not saved.');
        }
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

  const trimContext = async () => {
    const ids = messages.map(m => m.id).filter(Boolean);
    try {
      if (ids.length) {
        const res = await fetch('/api/messages', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }
      persistMessages([]);
      setConfirmTrim(false);
    } catch (e) {
      console.error('Failed to trim context', e);
      setErrorMsg('Could not trim context.');
    }
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
            <Turn key={t.indices.join('-')} turn={t} turnIdx={ti} user={user}
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

function Turn({ turn, turnIdx, user, onAskDelete, onDeleteMessage }) {
  const [hover, setHover] = React.useState(false);
  return (
    <div className="turn"
         onMouseEnter={() => setHover(true)}
         onMouseLeave={() => setHover(false)}
         style={{ position: 'relative', padding: '6px 0', borderRadius: 12,
                  transition: 'background 120ms',
                  background: hover ? 'var(--surface-2)' : 'transparent' }}>
      {turn.user && (
        <Bubble m={turn.user} idx={turn.indices[0]} user={user}
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

function Bubble({ m, idx, user, onDelete, showDelete }) {
  return (
    <div className={`msg-row ${m.role}`}>
      {m.role === 'user' ? (
        <UserAvatar user={user} className="msg-avatar" style={{ background: 'var(--c-coral)' }} />
      ) : (
        <div className="msg-avatar ai"><I.sparkle size={13} stroke="white" /></div>
      )}
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

window.ChatView = ChatView;
window.renderMarkdown = renderMarkdown;
window.escapeHtml = escapeHtml;

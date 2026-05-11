import 'dotenv/config';
import express from 'express';

const app = express();
app.use(express.json({ limit: '25mb' }));

const PORT = process.env.PORT || 3001;

// Map UI model IDs (defined in frontend/public/app.jsx MODELS) to a provider + an
// API-side model name. Keeping the picker labels stable and translating here means
// the frontend doesn't need to know about provider-specific identifiers.
const MODEL_MAP = {
  'gemini-flash':  { provider: 'gemini',    model: 'gemini-2.0-flash' },
  'gemini-pro':    { provider: 'gemini',    model: 'gemini-1.5-pro' },
  'gpt-4o-mini':   { provider: 'openai',    model: 'gpt-4o-mini' },
  'gpt-4o':        { provider: 'openai',    model: 'gpt-4o' },
  'claude-haiku':  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  'claude-sonnet': { provider: 'anthropic', model: 'claude-sonnet-4-6' },
};

const SYSTEM_PROMPT =
  'You are StudyAI, a focused study assistant. Be concise and clear. Use simple markdown when helpful: short paragraphs, **bold** for key terms, `code` for code, and lists when enumerating. Avoid filler.';

function sendSSE(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function setupSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

// ───────────────────────── attachment helpers ────────────────────────────────
// The frontend sends attachments as { name, mime, kind: 'image'|'text', data }
// where `data` is a base64 string for images and plain text for text files.
// Each provider serializes them differently; the helpers below translate
// our normalized shape into the per-provider content block format.

function attachmentsToText(atts = []) {
  const textAtts = atts.filter(a => a.kind === 'text');
  if (!textAtts.length) return '';
  return (
    '\n\n' +
    textAtts
      .map(a => `--- attached file: ${a.name} ---\n${a.data}\n--- end file ---`)
      .join('\n\n')
  );
}

function anthropicContent(text, atts = []) {
  const blocks = [];
  for (const a of atts) {
    if (a.kind === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: a.mime || 'image/png', data: a.data },
      });
    }
  }
  blocks.push({ type: 'text', text: (text || '') + attachmentsToText(atts) });
  return blocks;
}

function openaiContent(text, atts = []) {
  const parts = [{ type: 'text', text: (text || '') + attachmentsToText(atts) }];
  for (const a of atts) {
    if (a.kind === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${a.mime || 'image/png'};base64,${a.data}` },
      });
    }
  }
  return parts;
}

function geminiParts(text, atts = []) {
  const parts = [];
  for (const a of atts) {
    if (a.kind === 'image') {
      parts.push({ inline_data: { mime_type: a.mime || 'image/png', data: a.data } });
    }
  }
  parts.push({ text: (text || '') + attachmentsToText(atts) });
  return parts;
}

// ─────────────────────────── streaming routes ────────────────────────────────

async function streamAnthropic({ model, messages }, res) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set on the backend.');

  const body = {
    model,
    max_tokens: 2048,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: messages.map(m => ({
      role: m.role,
      content: anthropicContent(m.text, m.attachments),
    })),
    stream: true,
  };

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => '');
    throw new Error(`Anthropic ${upstream.status}: ${errText.slice(0, 400)}`);
  }

  const reader = upstream.body.getReader();
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
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          sendSSE(res, { type: 'token', text: evt.delta.text });
        } else if (evt.type === 'message_stop') {
          sendSSE(res, { type: 'done' });
        }
      } catch { /* keep streaming through unparseable events */ }
    }
  }
}

async function streamOpenAI({ model, messages }, res) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set on the backend.');

  const body = {
    model,
    stream: true,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages.map(m => ({
        role: m.role,
        content: openaiContent(m.text, m.attachments),
      })),
    ],
  };

  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => '');
    throw new Error(`OpenAI ${upstream.status}: ${errText.slice(0, 400)}`);
  }

  const reader = upstream.body.getReader();
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
      if (!data || data === '[DONE]') {
        if (data === '[DONE]') sendSSE(res, { type: 'done' });
        continue;
      }
      try {
        const evt = JSON.parse(data);
        const tok = evt.choices?.[0]?.delta?.content;
        if (tok) sendSSE(res, { type: 'token', text: tok });
      } catch { /* keep going */ }
    }
  }
}

async function streamGemini({ model, messages }, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set on the backend.');

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: geminiParts(m.text, m.attachments),
    })),
  };

  // The streamGenerateContent endpoint with alt=sse returns a clean
  // text/event-stream — much easier to parse than the default chunked JSON
  // array form.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => '');
    throw new Error(`Gemini ${upstream.status}: ${errText.slice(0, 400)}`);
  }

  const reader = upstream.body.getReader();
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
        const tok = evt.candidates?.[0]?.content?.parts
          ?.map(p => p.text || '')
          .join('');
        if (tok) sendSSE(res, { type: 'token', text: tok });
      } catch { /* ignore */ }
    }
  }
  sendSSE(res, { type: 'done' });
}

app.post('/api/chat', async (req, res) => {
  const { modelId, messages } = req.body || {};
  const route = MODEL_MAP[modelId];

  if (!route) {
    res.status(400).json({ error: `Unknown model "${modelId}"` });
    return;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages must be a non-empty array' });
    return;
  }

  setupSSE(res);

  try {
    if (route.provider === 'anthropic') {
      await streamAnthropic({ model: route.model, messages }, res);
    } else if (route.provider === 'openai') {
      await streamOpenAI({ model: route.model, messages }, res);
    } else if (route.provider === 'gemini') {
      await streamGemini({ model: route.model, messages }, res);
    }
  } catch (err) {
    sendSSE(res, { type: 'error', message: String(err.message || err) });
  } finally {
    res.end();
  }
});

app.get('/', (_req, res) => {
  res.type('text/plain').send(
    'StudyAI backend is running.\n\n' +
    'Endpoints:\n' +
    '  GET  /api/health  — provider key status\n' +
    '  POST /api/chat    — streaming chat (used by the frontend)\n',
  );
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    providers: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
    },
  });
});

app.listen(PORT, () => {
  console.log(`StudyAI backend listening on http://localhost:${PORT}`);
});

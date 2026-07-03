"""HTTP streaming dispatch to LLM providers (BYOK).

One async streaming function per provider. Each takes the caller's *plaintext*
`api_key` (decrypted for this one request only), the model id, and the
normalized message list, and yields assistant text chunks as they arrive.
Transport is raw httpx (no vendor SDKs) so every request shape is explicit and
auditable.

Security invariants — BYOK keys are the crown jewels:
  - The api_key is sent ONLY in the provider request's auth header (never a URL
    query string, so it can't leak through access logs / proxies) and is NEVER
    put in an exception message, log line, or yielded chunk. Upstream error
    bodies are redacted of the key defensively before being surfaced.
  - `model` is validated against a strict charset before being interpolated into
    any URL path, so a crafted model id can't rewrite the target host/path
    (SSRF / path traversal).
  - TLS verification stays ON (httpx default). Timeouts are bounded so a hung
    upstream can't pin a connection open forever.

Message shape (plain dicts, so this module has no dependency on main.py):
    {"role": "user"|"assistant", "text": str, "attachments": [
        {"kind": "image"|"text", "mime": str, "data": str, "name": str}, ...]}
"""

from __future__ import annotations

import json
import re
from typing import AsyncIterator, Awaitable, Callable, Iterable

import httpx

SYSTEM_PROMPT = (
    "You are AMO, a focused study assistant. Be concise and clear. "
    "Use simple markdown when helpful: short paragraphs, **bold** for key terms, "
    "`code` for code, and lists when enumerating. Avoid filler."
)

# Requests that stall are bounded: fail the connect quickly, allow a generous
# gap between streamed chunks, but never wait forever (the legacy env-key
# streamers used timeout=None, which lets a dead upstream pin a connection).
_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=10.0)

# Every real provider model id is alphanumerics plus . _ - and (for dated
# snapshots) colons. Anything else — slashes, ?, #, whitespace, unicode — could
# be an attempt to rewrite the URL when the id lands in a path segment.
_MODEL_RE = re.compile(r"^[A-Za-z0-9._:\-]{1,128}$")


class ProviderError(Exception):
    """Upstream/config failure safe to surface to the client.

    Carries an HTTP-ish status and a message that is guaranteed free of key
    material (callers redact before constructing). The route layer turns this
    into an SSE error event.
    """

    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def _safe_model(model: str) -> str:
    if not isinstance(model, str) or not _MODEL_RE.match(model):
        raise ProviderError("Invalid model identifier.", status_code=400)
    return model


def _require_key(api_key: str) -> None:
    if not api_key or not isinstance(api_key, str):
        raise ProviderError("Missing API key for this provider.", status_code=400)


def _redact(text: str, api_key: str) -> str:
    # Defense in depth: provider error bodies don't echo the auth header, but if
    # one ever did, strip it before the text can reach a log or the client.
    if api_key and api_key in text:
        text = text.replace(api_key, "***")
    return text


def _make_client() -> httpx.AsyncClient:
    # Single indirection point for the transport so tests can inject a
    # MockTransport. Production path keeps httpx defaults (TLS verify ON).
    return httpx.AsyncClient(timeout=_TIMEOUT)


async def _raise_for_upstream_error(resp: httpx.Response, label: str, api_key: str) -> None:
    if resp.status_code < 400:
        return
    raw = (await resp.aread()).decode("utf-8", "replace")
    detail = _redact(raw, api_key)[:500].strip()
    msg = f"{label} error {resp.status_code}" + (f": {detail}" if detail else ".")
    raise ProviderError(msg, status_code=502)


# ───────────────────────── attachment → provider content ─────────────────────

def _attachments_to_text(atts: Iterable[dict]) -> str:
    text_atts = [a for a in atts if a.get("kind") == "text"]
    if not text_atts:
        return ""
    blocks = "\n\n".join(
        f"--- attached file: {a.get('name')} ---\n{a.get('data', '')}\n--- end file ---"
        for a in text_atts
    )
    return "\n\n" + blocks


def _anthropic_content(text: str, atts: list[dict]) -> list[dict]:
    blocks: list[dict] = []
    for a in atts:
        if a.get("kind") == "image":
            blocks.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": a.get("mime") or "image/png",
                    "data": a.get("data", ""),
                },
            })
    blocks.append({"type": "text", "text": (text or "") + _attachments_to_text(atts)})
    return blocks


def _openai_content(text: str, atts: list[dict]) -> list[dict]:
    parts: list[dict] = [{"type": "text", "text": (text or "") + _attachments_to_text(atts)}]
    for a in atts:
        if a.get("kind") == "image":
            data = a.get("data", "")
            mime = a.get("mime") or "image/png"
            parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{data}"},
            })
    return parts


def _gemini_parts(text: str, atts: list[dict]) -> list[dict]:
    parts: list[dict] = []
    for a in atts:
        if a.get("kind") == "image":
            parts.append({
                "inline_data": {"mime_type": a.get("mime") or "image/png", "data": a.get("data", "")},
            })
    parts.append({"text": (text or "") + _attachments_to_text(atts)})
    return parts


def _plain_text(text: str, atts: list[dict]) -> str:
    # Mistral's chat API takes a plain string; text-file attachments are folded
    # in, images are skipped (non-vision text models reject image parts).
    return (text or "") + _attachments_to_text(atts)


def _atts(m: dict) -> list[dict]:
    return m.get("attachments") or []


# ───────────────────────── per-provider streamers ────────────────────────────

async def call_anthropic(
    api_key: str, model: str, messages: list[dict], *, system: str = SYSTEM_PROMPT,
) -> AsyncIterator[str]:
    _require_key(api_key)
    model = _safe_model(model)
    body = {
        "model": model,
        "max_tokens": 2048,
        "system": system,
        "messages": [
            {"role": m["role"], "content": _anthropic_content(m.get("text", ""), _atts(m))}
            for m in messages
        ],
        "stream": True,
    }
    headers = {
        "content-type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    async with _make_client() as client:
        async with client.stream(
            "POST", "https://api.anthropic.com/v1/messages", json=body, headers=headers,
        ) as resp:
            await _raise_for_upstream_error(resp, "Anthropic", api_key)
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data:
                    continue
                try:
                    evt = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if (
                    evt.get("type") == "content_block_delta"
                    and evt.get("delta", {}).get("type") == "text_delta"
                ):
                    tok = evt["delta"].get("text", "")
                    if tok:
                        yield tok


async def _stream_openai_compatible(
    api_key: str, model: str, messages: list[dict], *, url: str, label: str,
    content_of: Callable[[str, list[dict]], object], system: str,
) -> AsyncIterator[str]:
    """OpenAI and Mistral share the /chat/completions SSE wire format."""
    _require_key(api_key)
    model = _safe_model(model)
    body = {
        "model": model,
        "stream": True,
        "messages": [
            {"role": "system", "content": system},
            *[{"role": m["role"], "content": content_of(m.get("text", ""), _atts(m))} for m in messages],
        ],
    }
    headers = {"content-type": "application/json", "authorization": f"Bearer {api_key}"}
    async with _make_client() as client:
        async with client.stream("POST", url, json=body, headers=headers) as resp:
            await _raise_for_upstream_error(resp, label, api_key)
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    evt = json.loads(data)
                except json.JSONDecodeError:
                    continue
                choices = evt.get("choices") or [{}]
                tok = (choices[0].get("delta") or {}).get("content")
                if tok:
                    yield tok


async def call_openai(
    api_key: str, model: str, messages: list[dict], *, system: str = SYSTEM_PROMPT,
) -> AsyncIterator[str]:
    async for tok in _stream_openai_compatible(
        api_key, model, messages,
        url="https://api.openai.com/v1/chat/completions",
        label="OpenAI", content_of=_openai_content, system=system,
    ):
        yield tok


async def call_mistral(
    api_key: str, model: str, messages: list[dict], *, system: str = SYSTEM_PROMPT,
) -> AsyncIterator[str]:
    async for tok in _stream_openai_compatible(
        api_key, model, messages,
        url="https://api.mistral.ai/v1/chat/completions",
        label="Mistral", content_of=_plain_text, system=system,
    ):
        yield tok


async def call_google(
    api_key: str, model: str, messages: list[dict], *, system: str = SYSTEM_PROMPT,
) -> AsyncIterator[str]:
    _require_key(api_key)
    model = _safe_model(model)
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [
            {
                "role": "model" if m["role"] == "assistant" else "user",
                "parts": _gemini_parts(m.get("text", ""), _atts(m)),
            }
            for m in messages
        ],
    }
    # Key travels in the x-goog-api-key HEADER, not the URL query string, so it
    # never lands in server/proxy access logs. `model` is already charset-safe.
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}"
        ":streamGenerateContent?alt=sse"
    )
    headers = {"content-type": "application/json", "x-goog-api-key": api_key}
    async with _make_client() as client:
        async with client.stream("POST", url, json=body, headers=headers) as resp:
            await _raise_for_upstream_error(resp, "Gemini", api_key)
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data:
                    continue
                try:
                    evt = json.loads(data)
                except json.JSONDecodeError:
                    continue
                parts = (
                    (evt.get("candidates") or [{}])[0]
                    .get("content", {})
                    .get("parts", [])
                )
                tok = "".join(p.get("text", "") for p in parts)
                if tok:
                    yield tok


# Provider name → streamer. Names match the BYOK `provider` column values.
PROVIDERS: dict[str, Callable[..., AsyncIterator[str]]] = {
    "openai": call_openai,
    "anthropic": call_anthropic,
    "google": call_google,
    "mistral": call_mistral,
}


# ───────────────────────── key verification ──────────────────────────────────
# A "list models" GET is the cheapest way to check a key is valid: it costs no
# tokens and returns 200 (good) or 401/403 (bad). Same header/TLS/redaction
# rules as the streamers.

def _auth_headers(provider: str, api_key: str) -> dict:
    if provider == "anthropic":
        return {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    if provider == "google":
        return {"x-goog-api-key": api_key}
    return {"authorization": f"Bearer {api_key}"}  # openai, mistral


_VERIFY_URLS = {
    "openai": "https://api.openai.com/v1/models",
    "anthropic": "https://api.anthropic.com/v1/models",
    "google": "https://generativelanguage.googleapis.com/v1beta/models",
    "mistral": "https://api.mistral.ai/v1/models",
}


async def verify_key(provider: str, api_key: str) -> tuple[bool, str | None]:
    """Return (ok, error). `error` is redacted of the key and safe to surface."""
    _require_key(api_key)
    url = _VERIFY_URLS.get(provider)
    if url is None:
        raise ProviderError("Unknown provider.", status_code=400)
    async with _make_client() as client:
        resp = await client.get(url, headers=_auth_headers(provider, api_key))
    if resp.status_code < 400:
        return True, None
    detail = _redact(resp.text, api_key)[:300].strip()
    return False, f"{provider} error {resp.status_code}" + (f": {detail}" if detail else "")

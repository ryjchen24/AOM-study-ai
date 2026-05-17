import json
import os
from typing import AsyncIterator, Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel

load_dotenv()

app = FastAPI()

# Map UI model IDs (defined in frontend/public/app.jsx MODELS) to a provider + an
# API-side model name. Keeping the picker labels stable and translating here means
# the frontend doesn't need to know about provider-specific identifiers.
MODEL_MAP: dict[str, dict[str, str]] = {
    "gemini-flash":  {"provider": "gemini",    "model": "gemini-2.0-flash"},
    "gemini-pro":    {"provider": "gemini",    "model": "gemini-1.5-pro"},
    "gpt-4o-mini":   {"provider": "openai",    "model": "gpt-4o-mini"},
    "gpt-4o":        {"provider": "openai",    "model": "gpt-4o"},
    "claude-haiku":  {"provider": "anthropic", "model": "claude-haiku-4-5-20251001"},
    "claude-sonnet": {"provider": "anthropic", "model": "claude-sonnet-4-6"},
}

SYSTEM_PROMPT = (
    "You are StudyAI, a focused study assistant. Be concise and clear. "
    "Use simple markdown when helpful: short paragraphs, **bold** for key terms, "
    "`code` for code, and lists when enumerating. Avoid filler."
)


# ───────────────────────── request models ────────────────────────────────────

class Attachment(BaseModel):
    name: str | None = None
    mime: str | None = None
    kind: Literal["image", "text"]
    data: str


class Message(BaseModel):
    role: Literal["user", "assistant"]
    text: str | None = ""
    attachments: list[Attachment] = []


class ChatRequest(BaseModel):
    modelId: str
    messages: list[Message]


# ───────────────────────── SSE helpers ───────────────────────────────────────

def sse(payload: dict) -> bytes:
    return f"data: {json.dumps(payload)}\n\n".encode("utf-8")


# ───────────────────────── attachment helpers ────────────────────────────────
# The frontend sends attachments as { name, mime, kind: 'image'|'text', data }
# where `data` is a base64 string for images and plain text for text files.
# Each provider serializes them differently; the helpers below translate
# our normalized shape into the per-provider content block format.

def attachments_to_text(atts: list[Attachment]) -> str:
    text_atts = [a for a in atts if a.kind == "text"]
    if not text_atts:
        return ""
    blocks = "\n\n".join(
        f"--- attached file: {a.name} ---\n{a.data}\n--- end file ---"
        for a in text_atts
    )
    return "\n\n" + blocks


def anthropic_content(text: str, atts: list[Attachment]) -> list[dict]:
    blocks: list[dict] = []
    for a in atts:
        if a.kind == "image":
            blocks.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": a.mime or "image/png",
                    "data": a.data,
                },
            })
    blocks.append({"type": "text", "text": (text or "") + attachments_to_text(atts)})
    return blocks


def openai_content(text: str, atts: list[Attachment]) -> list[dict]:
    parts: list[dict] = [{"type": "text", "text": (text or "") + attachments_to_text(atts)}]
    for a in atts:
        if a.kind == "image":
            parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{a.mime or 'image/png'};base64,{a.data}"},
            })
    return parts


def gemini_parts(text: str, atts: list[Attachment]) -> list[dict]:
    parts: list[dict] = []
    for a in atts:
        if a.kind == "image":
            parts.append({
                "inline_data": {"mime_type": a.mime or "image/png", "data": a.data},
            })
    parts.append({"text": (text or "") + attachments_to_text(atts)})
    return parts


# ───────────────────────── upstream streamers ────────────────────────────────

async def stream_anthropic(model: str, messages: list[Message]) -> AsyncIterator[bytes]:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        yield sse({"type": "error", "message": "ANTHROPIC_API_KEY is not set on the backend."})
        return

    body = {
        "model": model,
        "max_tokens": 2048,
        "system": [
            {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}},
        ],
        "messages": [
            {"role": m.role, "content": anthropic_content(m.text or "", m.attachments)}
            for m in messages
        ],
        "stream": True,
    }

    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }

    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST", "https://api.anthropic.com/v1/messages", json=body, headers=headers,
        ) as upstream:
            if upstream.status_code >= 400:
                err = (await upstream.aread()).decode("utf-8", "replace")[:400]
                yield sse({"type": "error", "message": f"Anthropic {upstream.status_code}: {err}"})
                return

            async for line in upstream.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data:
                    continue
                try:
                    evt = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if evt.get("type") == "content_block_delta" and evt.get("delta", {}).get("type") == "text_delta":
                    yield sse({"type": "token", "text": evt["delta"]["text"]})
                elif evt.get("type") == "message_stop":
                    yield sse({"type": "done"})


async def stream_openai(model: str, messages: list[Message]) -> AsyncIterator[bytes]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        yield sse({"type": "error", "message": "OPENAI_API_KEY is not set on the backend."})
        return

    body = {
        "model": model,
        "stream": True,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            *[
                {"role": m.role, "content": openai_content(m.text or "", m.attachments)}
                for m in messages
            ],
        ],
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }

    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST", "https://api.openai.com/v1/chat/completions", json=body, headers=headers,
        ) as upstream:
            if upstream.status_code >= 400:
                err = (await upstream.aread()).decode("utf-8", "replace")[:400]
                yield sse({"type": "error", "message": f"OpenAI {upstream.status_code}: {err}"})
                return

            async for line in upstream.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data:
                    continue
                if data == "[DONE]":
                    yield sse({"type": "done"})
                    continue
                try:
                    evt = json.loads(data)
                except json.JSONDecodeError:
                    continue
                tok = (
                    evt.get("choices", [{}])[0]
                    .get("delta", {})
                    .get("content")
                )
                if tok:
                    yield sse({"type": "token", "text": tok})


async def stream_gemini(model: str, messages: list[Message]) -> AsyncIterator[bytes]:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        yield sse({"type": "error", "message": "GEMINI_API_KEY is not set on the backend."})
        return

    body = {
        "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
        "contents": [
            {
                "role": "model" if m.role == "assistant" else "user",
                "parts": gemini_parts(m.text or "", m.attachments),
            }
            for m in messages
        ],
    }

    # The streamGenerateContent endpoint with alt=sse returns a clean
    # text/event-stream — much easier to parse than the default chunked JSON
    # array form.
    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}"
        f":streamGenerateContent?alt=sse&key={api_key}"
    )

    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST", url, json=body, headers={"Content-Type": "application/json"},
        ) as upstream:
            if upstream.status_code >= 400:
                err = (await upstream.aread()).decode("utf-8", "replace")[:400]
                yield sse({"type": "error", "message": f"Gemini {upstream.status_code}: {err}"})
                return

            async for line in upstream.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data:
                    continue
                try:
                    evt = json.loads(data)
                except json.JSONDecodeError:
                    continue
                parts = evt.get("candidates", [{}])[0].get("content", {}).get("parts", [])
                tok = "".join(p.get("text", "") for p in parts)
                if tok:
                    yield sse({"type": "token", "text": tok})

    yield sse({"type": "done"})


# ───────────────────────── routes ────────────────────────────────────────────

@app.get("/", response_class=PlainTextResponse)
def root() -> str:
    return (
        "StudyAI backend is running.\n\n"
        "Endpoints:\n"
        "  GET  /api/health  — provider key status\n"
        "  POST /api/chat    — streaming chat (used by the frontend)\n"
    )


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "providers": {
            "anthropic": bool(os.environ.get("ANTHROPIC_API_KEY")),
            "openai":    bool(os.environ.get("OPENAI_API_KEY")),
            "gemini":    bool(os.environ.get("GEMINI_API_KEY")),
        },
    }


@app.post("/api/chat")
async def chat(req: ChatRequest):
    route = MODEL_MAP.get(req.modelId)
    if not route:
        return {"error": f'Unknown model "{req.modelId}"'}
    if not req.messages:
        return {"error": "messages must be a non-empty array"}

    provider = route["provider"]
    model = route["model"]

    if provider == "anthropic":
        gen = stream_anthropic(model, req.messages)
    elif provider == "openai":
        gen = stream_openai(model, req.messages)
    else:
        gen = stream_gemini(model, req.messages)

    headers = {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(gen, media_type="text/event-stream", headers=headers)

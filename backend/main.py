import asyncio
import json
import os
import re
from datetime import datetime, timezone
from typing import AsyncIterator, Literal

import bcrypt
import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel
from starlette.middleware.sessions import SessionMiddleware

from contextlib import asynccontextmanager

from prisma import Prisma, Json
from prisma.errors import UniqueViolationError

load_dotenv()

prisma = Prisma()

@asynccontextmanager
async def lifespan(app: FastAPI):
    await prisma.connect()
    try:
        yield
    finally:
        await prisma.disconnect()

app = FastAPI(lifespan=lifespan)

# ───────────────────────── session cookie ────────────────────────────────────
# Signed (not encrypted) cookie holding only `user_id`. itsdangerous signs it
# with SESSION_SECRET so a client can't forge it. We fail fast if the secret is
# missing rather than fall back to a hardcoded default — a predictable secret
# means anyone can mint a valid session for any user.
SESSION_SECRET = os.environ.get("SESSION_SECRET")
if not SESSION_SECRET:
    raise RuntimeError(
        "SESSION_SECRET is not set. Generate one with "
        "`python -c \"import secrets; print(secrets.token_urlsafe(48))\"` "
        "and add it to backend/.env"
    )

# In production (HTTPS) set COOKIE_SECURE=true so the cookie is never sent over
# plain HTTP. Left false in local dev because the Vite proxy serves over http.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"

app.add_middleware(
    SessionMiddleware,
    secret_key=SESSION_SECRET,
    session_cookie="studyai_session",
    same_site="lax",        # don't send the cookie on cross-site POSTs → CSRF defense
    https_only=COOKIE_SECURE,
    max_age=60 * 60 * 24 * 14,  # 14 days
)
# SessionMiddleware always sets HttpOnly, so client JS (and thus XSS) can't read
# the cookie — nothing more to configure for that.

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


class FolderCreate(BaseModel):
    name: str
    color: str
    parentId: str | None = None
    order: int = 0


class FolderUpdate(BaseModel):
    name: str | None = None
    color: str | None = None
    parentId: str | None = None
    order: int | None = None


class SessionCreate(BaseModel):
    title: str
    model: str
    folderId: str | None = None


class SessionUpdate(BaseModel):
    title: str | None = None
    folderId: str | None = None


class MessageCreate(BaseModel):
    role: Literal["user", "assistant"]
    text: str
    attachments: list[Attachment] | None = None


class MessageDeleteBulk(BaseModel):
    ids: list[str]


class SignupRequest(BaseModel):
    email: str
    password: str
    displayName: str


class LoginRequest(BaseModel):
    email: str
    password: str


# ───────────────────────── auth helpers ──────────────────────────────────────
# Password rules: bcrypt only hashes the first 72 BYTES of input and silently
# ignores the rest, so we reject anything longer instead of letting two
# different passwords that share a 72-byte prefix both authenticate.
PASSWORD_MIN_LEN = 8
PASSWORD_MAX_BYTES = 72
DISPLAY_NAME_MAX_LEN = 80
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# A throwaway hash we verify against when an email doesn't exist, so login takes
# the same ~time whether or not the account is real. Without this, response
# timing leaks which emails are registered (user enumeration).
_DUMMY_HASH = bcrypt.hashpw(b"timing-equalizer", bcrypt.gensalt()).decode("utf-8")


def _normalize_email(email: str) -> str:
    return email.strip().lower()


def _validate_password(password: str) -> None:
    if len(password) < PASSWORD_MIN_LEN:
        raise HTTPException(
            status_code=400,
            detail=f"Password must be at least {PASSWORD_MIN_LEN} characters.",
        )
    if len(password.encode("utf-8")) > PASSWORD_MAX_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Password must be at most {PASSWORD_MAX_BYTES} bytes.",
        )


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        # Malformed stored hash — treat as a failed login, never a 500.
        return False


def public_user(user) -> dict:
    # The ONLY shape a user is ever serialized to the client. passwordHash is
    # deliberately absent so it can never leak through an endpoint response.
    return {
        "id": user.id,
        "email": user.email,
        "displayName": user.displayName,
        "createdAt": user.createdAt,
    }


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
        "  GET  /api/health   — provider key status\n"
        "  POST /api/auth/*   — signup / login / logout / me\n"
        "  POST /api/chat     — streaming chat (used by the frontend)\n"
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



# ───────────────────────── Auth Endpoints ──────────────────────────────
# Identity is established here and carried in the signed session cookie. No
# endpoint trusts a user id from the request body — it always comes from the
# session (see request.session["user_id"]). require_user (Step 3.4) and
# per-user query scoping (Step 3.5) build on top of these.

@app.post("/api/auth/signup")
async def signup(req: SignupRequest, request: Request):
    email = _normalize_email(req.email)
    if not EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Enter a valid email address.")

    display_name = req.displayName.strip()
    if not display_name:
        raise HTTPException(status_code=400, detail="Display name is required.")
    if len(display_name) > DISPLAY_NAME_MAX_LEN:
        raise HTTPException(status_code=400, detail="Display name is too long.")

    _validate_password(req.password)

    try:
        user = await prisma.user.create(
            data={
                "email": email,
                "passwordHash": hash_password(req.password),
                "displayName": display_name,
            }
        )
    except UniqueViolationError:
        # Unique constraint is the source of truth even under a race between two
        # concurrent signups; we don't pre-check existence and then create.
        raise HTTPException(status_code=409, detail="Email already registered.")

    # Fresh session on a brand-new account.
    request.session.clear()
    request.session["user_id"] = user.id
    return public_user(user)


@app.post("/api/auth/login")
async def login(req: LoginRequest, request: Request):
    email = _normalize_email(req.email)
    user = await prisma.user.find_unique(where={"email": email})

    # Identical error + comparable timing whether the email is unknown or the
    # password is wrong, so an attacker can't enumerate registered emails.
    if user is None:
        verify_password(req.password, _DUMMY_HASH)
        raise HTTPException(status_code=401, detail="Invalid email or password.")
    if not verify_password(req.password, user.passwordHash):
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    # Clear any pre-existing session data before assigning identity → guards
    # against session fixation.
    request.session.clear()
    request.session["user_id"] = user.id
    return public_user(user)


@app.post("/api/auth/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/auth/me")
async def me(request: Request):
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated.")
    user = await prisma.user.find_unique(where={"id": user_id})
    if user is None:
        # Session points at a deleted user — drop the stale cookie.
        request.session.clear()
        raise HTTPException(status_code=401, detail="Not authenticated.")
    return public_user(user)
# ───────────────────────────────────────────────────────────────────────


# ────────────────────── Folder CRUD Enpoints ───────────────────────────
@app.get("/api/folders")
async def list_folders():
    folders = await prisma.folder.find_many(order={"order": "asc"})
    return folders

@app.post("/api/folders")
async def create_folder(req: FolderCreate):
    folder = await prisma.folder.create(data=req.model_dump())
    return folder

@app.patch("/api/folders/{folder_id}")
async def update_folder(folder_id: str, req: FolderUpdate):
    data = req.model_dump(exclude_unset=True)
    if not data:
        return JSONResponse({"error": "no fields to update"}, status_code=400)
    folder = await prisma.folder.update(where={"id": folder_id}, data=data)
    if folder is None:
        return JSONResponse({"error": "folder not found"}, status_code=404)
    return folder

@app.delete("/api/folders/{folder_id}")
async def delete_folder(folder_id: str):
    folder = await prisma.folder.delete(where={"id": folder_id})
    if folder is None:
        return JSONResponse({"error": "folder not found"}, status_code=404)
    return folder
# ───────────────────────────────────────────────────────────────────────

# ─────────────────────- Session CRUD Enpoints ──────────────────────────
@app.get("/api/sessions")
async def list_sessions():
    sessions = await prisma.session.find_many(order={"updatedAt": "desc"})
    # Prisma Client Python doesn't expose `_count` aggregates in `include`, so
    # we fan out per-session COUNT queries in parallel. N+1 but fine for the
    # session counts we'll realistically have; can swap for a raw GROUP BY
    # later if it ever matters.
    counts = await asyncio.gather(*[
        prisma.message.count(where={"sessionId": s.id}) for s in sessions
    ])
    result = []
    for s, cnt in zip(sessions, counts):
        d = s.model_dump()
        d["messageCount"] = cnt
        result.append(d)
    return result

@app.post("/api/sessions")
async def create_session(req: SessionCreate):
    session = await prisma.session.create(data=req.model_dump())
    return session

@app.patch("/api/sessions/{session_id}")
async def update_session(session_id: str, req: SessionUpdate):
    data = req.model_dump(exclude_unset=True)
    if not data:
        return JSONResponse({"error": "no fields to update"}, status_code=400)
    session = await prisma.session.update(where={"id": session_id}, data=data)
    if session is None:
        return JSONResponse({"error": "session not found"}, status_code=404)
    return session

@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    session = await prisma.session.delete(where={"id": session_id})
    if session is None:
        return JSONResponse({"error": "session not found"}, status_code=404)
    return session
# ───────────────────────────────────────────────────────────────────────

# ─────────────────────- Messages CRUD Enpoints ─────────────────────────
@app.get("/api/sessions/{session_id}/messages")
async def list_messages(session_id: str):
    messages = await prisma.message.find_many(
        where={"sessionId": session_id},
        order={"createdAt": "asc"},
    )
    return messages

@app.post("/api/sessions/{session_id}/messages")
async def create_message(session_id: str, req: MessageCreate):
    data: dict = {
        "sessionId": session_id,
        "role": req.role,
        "text": req.text,
    }
    if req.attachments:
        data["attachments"] = Json([a.model_dump() for a in req.attachments])
    message = await prisma.message.create(data=data)
    # Bump session.updatedAt so sidebar/files ordering by "last modified"
    # reflects chat activity. Prisma's @updatedAt only fires on writes to the
    # session row itself, not on related-row inserts.
    await prisma.session.update(
        where={"id": session_id},
        data={"updatedAt": datetime.now(timezone.utc)},
    )
    return message

@app.delete("/api/messages")
async def delete_messages(req: MessageDeleteBulk):
    if not req.ids:
        return JSONResponse({"error": "ids must be a non-empty array"}, status_code=400)
    count = await prisma.message.delete_many(where={"id": {"in": req.ids}})
    return {"deleted": count}


# ───────────────────────────────────────────────────────────────────────




@app.post("/api/chat")
async def chat(req: ChatRequest):
    route = MODEL_MAP.get(req.modelId)
    if not route:
        return JSONResponse({"error": f'Unknown model "{req.modelId}"'}, status_code=400)
    if not req.messages:
        return JSONResponse({"error": "messages must be a non-empty array"}, status_code=400)

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

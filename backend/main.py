import asyncio
import json
import os
from datetime import datetime, timezone
from typing import Literal

from authlib.integrations.starlette_client import OAuth, OAuthError
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import (
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
    StreamingResponse,
)
from pydantic import BaseModel
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.middleware.sessions import SessionMiddleware

from contextlib import asynccontextmanager

from prisma import Prisma, Json, Base64
from prisma.errors import UniqueViolationError
from prisma.models import User

import providers
import security

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

# ───────────────────────── rate limiting ─────────────────────────────────────
# Per-USER limit (keyed by the session's user_id, NOT the IP): if a session
# cookie is stolen, this caps how much of the victim's provider key an attacker
# can burn. Falls back to the client address for unauthenticated requests.
def _rate_limit_key(request: Request) -> str:
    try:
        uid = request.session.get("user_id")
    except Exception:
        uid = None
    return uid or get_remote_address(request)

limiter = Limiter(key_func=_rate_limit_key)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


# Catch-all for unhandled errors. Returns a generic message and — critically —
# never echoes the request body or headers, which can carry a decrypted API key
# or the auth cookie. Only the exception type is logged, never its payload.
@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    print(f"Unhandled error on {request.method} {request.url.path}: {type(exc).__name__}")
    return JSONResponse({"error": "Internal server error."}, status_code=500)

# ───────────────────────── google oauth ──────────────────────────────────────
# Google-only auth. Authlib drives the OAuth 2.0 / OIDC dance: it builds the
# consent redirect, exchanges the code, and — crucially — verifies the
# id_token's signature and audience for us. We never see or store a password.
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.environ.get("GOOGLE_CLIENT_SECRET")
# Must EXACTLY match a redirect URI registered in the Google Cloud console.
# Defaults to the frontend origin so the whole flow stays same-origin through
# the Vite proxy and the session cookie sticks to one origin.
GOOGLE_REDIRECT_URI = os.environ.get(
    "GOOGLE_REDIRECT_URI", "http://localhost:5173/api/auth/google/callback"
)
# Where to send the browser after a successful login.
FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:5173")

# Register lazily: if creds aren't set yet the app still boots, and /login
# returns a clear 503 instead of crashing at import time.
GOOGLE_ENABLED = bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
oauth = OAuth()
if GOOGLE_ENABLED:
    oauth.register(
        name="google",
        client_id=GOOGLE_CLIENT_ID,
        client_secret=GOOGLE_CLIENT_SECRET,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
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
    provider: Literal["openai", "anthropic", "google", "mistral"]
    model: str
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
    provider: str = "anthropic"
    folderId: str | None = None


class SessionUpdate(BaseModel):
    title: str | None = None
    folderId: str | None = None
    provider: str | None = None
    model: str | None = None


class MessageCreate(BaseModel):
    role: Literal["user", "assistant"]
    text: str
    attachments: list[Attachment] | None = None


class MessageDeleteBulk(BaseModel):
    ids: list[str]


# NOTE: `apiKey` intentionally has NO length/pattern constraints. FastAPI echoes
# the offending value in 422 validation errors, so a constraint here would leak
# the key into an error response/logs. All key validation happens manually in the
# handler with clean 400s that never include the key.
class ApiKeyCreate(BaseModel):
    provider: Literal["openai", "anthropic", "google", "mistral"]
    label: str | None = None
    apiKey: str


# ───────────────────────── auth helpers ──────────────────────────────────────

def public_user(user) -> dict:
    # The ONLY shape a user is ever serialized to the client. Whitelist of safe
    # fields — internal columns can never leak through an endpoint response.
    return {
        "id": user.id,
        "email": user.email,
        "displayName": user.displayName,
        "avatarUrl": user.avatarUrl,
        "createdAt": user.createdAt,
    }


async def require_user(request: Request) -> User:
    # Auth gate for every protected route. Identity comes ONLY from the signed
    # session cookie — never from the request body or a query param — so a
    # client can't impersonate another user by sending their id. Declare it as
    # `user: User = Depends(require_user)` on a route and FastAPI runs it first,
    # returning 401 before the handler body if there's no valid session.
    user_id = request.session.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Not authenticated.")
    user = await prisma.user.find_unique(where={"id": user_id})
    if user is None:
        # Session points at a deleted user — drop the stale cookie.
        request.session.clear()
        raise HTTPException(status_code=401, detail="Not authenticated.")
    return user


# Ownership guards for by-id routes. find_first with a userId filter means a
# request for someone else's row returns 404 — never reveal that it exists, and
# never let a user mutate it (IDOR prevention). 404 (not 403) so the response is
# identical whether the row belongs to another user or doesn't exist at all.
async def owned_folder_or_404(folder_id: str, user: User):
    folder = await prisma.folder.find_first(where={"id": folder_id, "userId": user.id})
    if folder is None:
        raise HTTPException(status_code=404, detail="Folder not found.")
    return folder


async def owned_session_or_404(session_id: str, user: User):
    session = await prisma.session.find_first(where={"id": session_id, "userId": user.id})
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return session


# ───────────────────────── SSE helpers ───────────────────────────────────────

def sse(payload: dict) -> bytes:
    return f"data: {json.dumps(payload)}\n\n".encode("utf-8")


# ───────────────────────── routes ────────────────────────────────────────────

@app.get("/", response_class=PlainTextResponse)
def root() -> str:
    return (
        "StudyAI backend is running.\n\n"
        "Endpoints:\n"
        "  GET  /api/health   — health check\n"
        "  /api/auth/google/* — Google sign-in (login / callback)\n"
        "  /api/auth/logout|me — session logout / current user\n"
        "  POST /api/chat     — streaming chat (used by the frontend)\n"
    )


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "providers": sorted(providers.PROVIDERS.keys())}



# ───────────────────────── Auth Endpoints ──────────────────────────────
# Google-only. Identity is established by the OAuth callback and carried in the
# signed session cookie. No endpoint trusts a user id from the request body — it
# always comes from the session (request.session["user_id"]). require_user
# and per-user query scoping build on top of these.

@app.get("/api/auth/google/login")
async def google_login(request: Request):
    if not GOOGLE_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="Google sign-in is not configured on the server.",
        )
    # Authlib stashes a CSRF `state` value in the session and checks it on the
    # callback, so this whole flow is protected against OAuth CSRF.
    return await oauth.google.authorize_redirect(request, GOOGLE_REDIRECT_URI)


@app.get("/api/auth/google/callback")
async def google_callback(request: Request):
    if not GOOGLE_ENABLED:
        raise HTTPException(
            status_code=503,
            detail="Google sign-in is not configured on the server.",
        )

    # Verifies the `state`, exchanges the code, and validates the id_token's
    # signature + audience. Any failure (tampering, denied consent, expired
    # code) raises OAuthError → we bounce back to the frontend, never 500.
    try:
        token = await oauth.google.authorize_access_token(request)
    except OAuthError:
        return RedirectResponse(url=f"{FRONTEND_URL}/?login=failed")

    userinfo = token.get("userinfo")
    if not userinfo:
        userinfo = await oauth.google.userinfo(token=token)

    google_id = userinfo.get("sub")
    email = userinfo.get("email")
    # Don't accept an account whose email Google hasn't verified — prevents a
    # spoofed/unverified address from seeding an account.
    if not google_id or not email or userinfo.get("email_verified") is False:
        return RedirectResponse(url=f"{FRONTEND_URL}/?login=failed")

    display_name = userinfo.get("name") or email.split("@")[0]
    avatar_url = userinfo.get("picture")

    # Find-or-create keyed on the immutable Google `sub`, and refresh the
    # profile fields on every login so name/avatar stay current.
    user = await prisma.user.upsert(
        where={"googleId": google_id},
        data={
            "create": {
                "googleId": google_id,
                "email": email,
                "displayName": display_name,
                "avatarUrl": avatar_url,
            },
            "update": {
                "email": email,
                "displayName": display_name,
                "avatarUrl": avatar_url,
            },
        },
    )

    # Clear Authlib's OAuth state + any prior data before assigning identity →
    # guards against session fixation.
    request.session.clear()
    request.session["user_id"] = user.id
    return RedirectResponse(url=FRONTEND_URL)


@app.post("/api/auth/logout")
async def logout(request: Request):
    request.session.clear()
    return {"ok": True}


@app.get("/api/auth/me")
async def me(user: User = Depends(require_user)):
    return public_user(user)
# ───────────────────────────────────────────────────────────────────────


# ────────────────────── Folder CRUD Enpoints ───────────────────────────
@app.get("/api/folders")
async def list_folders(user: User = Depends(require_user)):
    folders = await prisma.folder.find_many(
        where={"userId": user.id}, order={"order": "asc"}
    )
    return folders

@app.post("/api/folders")
async def create_folder(req: FolderCreate, user: User = Depends(require_user)):
    # A parent must be the caller's own folder, or you could nest under someone
    # else's tree.
    if req.parentId is not None:
        await owned_folder_or_404(req.parentId, user)
    folder = await prisma.folder.create(data={**req.model_dump(), "userId": user.id})
    return folder

@app.patch("/api/folders/{folder_id}")
async def update_folder(folder_id: str, req: FolderUpdate, user: User = Depends(require_user)):
    data = req.model_dump(exclude_unset=True)
    if not data:
        return JSONResponse({"error": "no fields to update"}, status_code=400)
    await owned_folder_or_404(folder_id, user)
    if data.get("parentId") is not None:
        if data["parentId"] == folder_id:
            return JSONResponse({"error": "a folder cannot be its own parent"}, status_code=400)
        await owned_folder_or_404(data["parentId"], user)
    folder = await prisma.folder.update(where={"id": folder_id}, data=data)
    return folder

@app.delete("/api/folders/{folder_id}")
async def delete_folder(folder_id: str, user: User = Depends(require_user)):
    await owned_folder_or_404(folder_id, user)
    folder = await prisma.folder.delete(where={"id": folder_id})
    return folder
# ───────────────────────────────────────────────────────────────────────

# ─────────────────────- Session CRUD Enpoints ──────────────────────────
@app.get("/api/sessions")
async def list_sessions(user: User = Depends(require_user)):
    sessions = await prisma.session.find_many(
        where={"userId": user.id}, order={"updatedAt": "desc"}
    )
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
async def create_session(req: SessionCreate, user: User = Depends(require_user)):
    if req.folderId is not None:
        await owned_folder_or_404(req.folderId, user)
    session = await prisma.session.create(data={**req.model_dump(), "userId": user.id})
    return session

@app.patch("/api/sessions/{session_id}")
async def update_session(session_id: str, req: SessionUpdate, user: User = Depends(require_user)):
    data = req.model_dump(exclude_unset=True)
    if not data:
        return JSONResponse({"error": "no fields to update"}, status_code=400)
    await owned_session_or_404(session_id, user)
    # Moving a session into a folder? That folder must be the caller's too.
    if data.get("folderId") is not None:
        await owned_folder_or_404(data["folderId"], user)
    session = await prisma.session.update(where={"id": session_id}, data=data)
    return session

@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str, user: User = Depends(require_user)):
    await owned_session_or_404(session_id, user)
    session = await prisma.session.delete(where={"id": session_id})
    return session
# ───────────────────────────────────────────────────────────────────────

# ─────────────────────- Messages CRUD Enpoints ─────────────────────────
@app.get("/api/sessions/{session_id}/messages")
async def list_messages(session_id: str, user: User = Depends(require_user)):
    # Messages have no userId of their own; ownership is inherited from the
    # session. Verify that first so you can't read another user's thread by
    # guessing a session id.
    await owned_session_or_404(session_id, user)
    messages = await prisma.message.find_many(
        where={"sessionId": session_id},
        order={"createdAt": "asc"},
    )
    return messages

@app.post("/api/sessions/{session_id}/messages")
async def create_message(session_id: str, req: MessageCreate, user: User = Depends(require_user)):
    await owned_session_or_404(session_id, user)
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
async def delete_messages(req: MessageDeleteBulk, user: User = Depends(require_user)):
    if not req.ids:
        return JSONResponse({"error": "ids must be a non-empty array"}, status_code=400)
    # Relation filter: only delete messages whose parent session belongs to the
    # caller. Ids that aren't theirs are silently skipped, not errored — they
    # simply don't match the filter, so no info leaks about other users' rows.
    count = await prisma.message.delete_many(
        where={"id": {"in": req.ids}, "session": {"is": {"userId": user.id}}}
    )
    return {"deleted": count}


# ───────────────────────────────────────────────────────────────────────




# ─────────────────────── API Key CRUD Endpoints ────────────────────────
# BYOK: users store their own provider keys, encrypted at rest. Responses NEVER
# include the key — only { id, provider, label, last4 }. All routes are auth'd
# and scoped by userId so one user can't read/mutate/test another's keys.

# Gut-check prefix filters — NOT security, just to catch obvious paste mistakes.
def _key_shape_error(provider: str, key: str) -> str | None:
    if provider == "openai" and not key.startswith("sk-"):
        return "OpenAI keys start with 'sk-'."
    if provider == "anthropic" and not key.startswith("sk-ant-"):
        return "Anthropic keys start with 'sk-ant-'."
    if provider == "google" and not key.startswith("AIza"):
        return "Google keys start with 'AIza'."
    if provider == "mistral" and len(key) < 20:
        return "That Mistral key looks too short."
    return None


def _public_key(row) -> dict:
    # The ONLY shape a stored key is serialized to the client. Note: no
    # encryptedKey, ever.
    return {"id": row.id, "provider": row.provider, "label": row.label, "last4": row.last4}


@app.get("/api/keys")
async def list_keys(user: User = Depends(require_user)):
    rows = await prisma.userapikey.find_many(
        where={"userId": user.id}, order={"createdAt": "asc"}
    )
    return [_public_key(r) for r in rows]


@app.post("/api/keys")
async def create_key(req: ApiKeyCreate, user: User = Depends(require_user)):
    key = (req.apiKey or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="API key is required.")
    if len(key) > 256:
        # Length cap so nobody POSTs a huge blob. Message never includes the key.
        raise HTTPException(status_code=400, detail="API key is too long.")
    shape_err = _key_shape_error(req.provider, key)
    if shape_err:
        raise HTTPException(status_code=400, detail=shape_err)

    label = req.label.strip() if req.label else None

    # Postgres treats NULLs as distinct in a UNIQUE index, so the DB constraint
    # won't catch duplicate (userId, provider, NULL-label) rows — check manually.
    existing = await prisma.userapikey.find_first(
        where={"userId": user.id, "provider": req.provider, "label": label}
    )
    if existing:
        raise HTTPException(
            status_code=409,
            detail="A key for this provider and label already exists.",
        )

    try:
        row = await prisma.userapikey.create(data={
            "userId": user.id,
            "provider": req.provider,
            "label": label,
            "encryptedKey": Base64.encode(security.encrypt_key(key)),
            "last4": key[-4:],
        })
    except UniqueViolationError:
        # Race: a concurrent request created the same (userId, provider, label).
        raise HTTPException(
            status_code=409,
            detail="A key for this provider and label already exists.",
        )
    return _public_key(row)


@app.delete("/api/keys/{key_id}")
async def delete_key(key_id: str, user: User = Depends(require_user)):
    # Scoped delete: the userId filter means a request for someone else's key id
    # deletes nothing → 404, so ownership can't be probed (IDOR prevention).
    deleted = await prisma.userapikey.delete_many(
        where={"id": key_id, "userId": user.id}
    )
    if deleted == 0:
        raise HTTPException(status_code=404, detail="Key not found.")
    return {"deleted": deleted}


@app.post("/api/keys/{key_id}/test")
async def test_key(key_id: str, user: User = Depends(require_user)):
    row = await prisma.userapikey.find_first(where={"id": key_id, "userId": user.id})
    if row is None:
        raise HTTPException(status_code=404, detail="Key not found.")
    # Decrypt in memory for this one request only — never stored, cached, logged.
    # Prisma returns Bytes as a Base64 wrapper; .decode() → the raw ciphertext.
    plaintext = security.decrypt_key(row.encryptedKey.decode())
    try:
        ok, error = await providers.verify_key(row.provider, plaintext)
    except providers.ProviderError as e:
        return {"ok": False, "error": e.message}
    return {"ok": True} if ok else {"ok": False, "error": error}
# ───────────────────────────────────────────────────────────────────────


@app.post("/api/chat")
@limiter.limit("20/minute")
async def chat(request: Request, req: ChatRequest, user: User = Depends(require_user)):
    if not req.messages:
        return JSONResponse({"error": "messages must be a non-empty array"}, status_code=400)

    # BYOK: use the caller's own stored key for this provider — never an env key.
    key_row = await prisma.userapikey.find_first(
        where={"userId": user.id, "provider": req.provider}
    )
    if key_row is None:
        # Frontend maps this to "Add a key in Settings".
        return JSONResponse({"error": "no_key_for_provider"}, status_code=400)

    # Decrypt in memory for this request only; the plaintext never leaves this scope.
    api_key = security.decrypt_key(key_row.encryptedKey.decode())
    stream_fn = providers.PROVIDERS[req.provider]  # provider constrained by the model
    messages = [m.model_dump() for m in req.messages]

    async def event_stream():
        try:
            async for tok in stream_fn(api_key, req.model, messages):
                yield sse({"type": "token", "text": tok})
            yield sse({"type": "done"})
        except providers.ProviderError as exc:
            # providers.py has already redacted any key material from the message.
            yield sse({"type": "error", "message": exc.message})
        except Exception:
            # Last-resort guard: never surface internals (or the key) to the client.
            yield sse({"type": "error", "message": "Chat failed due to a server error."})

    headers = {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)

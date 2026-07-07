# AMO

**Live app → https://amo-xt5x.onrender.com**

AMO is a full-stack AI study app. Most AI chat tools treat every conversation as a
throwaway message thread — AMO wraps that chat in a **file system** so you can
organize your AI interactions the way you'd organize study notes: into folders,
named sessions, and persistent, searchable history.

It's **multi-provider and bring-your-own-key**: you sign in with Google, paste
your own API keys for the providers you use (Anthropic, OpenAI, Google, Mistral),
and chat against any of their models. Your keys are encrypted at rest and never
leave the server.

---

## Features

- **Google sign-in** — no passwords; each user only ever sees their own data.
- **Bring-your-own-key (BYOK)** — store your own provider keys; they're encrypted
  at rest (Fernet) and used server-side only, so a raw key never reaches the browser.
- **Multi-provider chat** — Anthropic (Claude), OpenAI (GPT), Google (Gemini),
  and Mistral, with a per-chat provider + model picker.
- **Streaming responses** — tokens stream to the UI over Server-Sent Events.
- **Folders & sessions** — organize chats into a nested folder tree; rename, move,
  and delete. Everything persists in Postgres across reloads.
- **Rich composer** — file attachments, voice input, Markdown + math (KaTeX)
  rendering, and conversation export.
- **Key management** — add, test, and remove provider keys from Settings; a test
  button verifies a key with a zero-token call before you rely on it.

## Tech stack

```
Frontend   →  React 18 (hooks), plain CSS, Vite 5 dev server
Backend    →  FastAPI (async Python), Pydantic, Uvicorn
Database   →  PostgreSQL via Prisma (Prisma Client Python)
Auth       →  Google OAuth 2.0 / OIDC (Authlib) + signed session cookies
Security   →  Fernet-encrypted user keys, per-user query scoping, per-user rate limiting
Providers  →  Anthropic · OpenAI · Google Gemini · Mistral (streaming)
Deploy     →  Docker → Render (single service) + Neon Postgres
```

In production a **single FastAPI process serves both the API and the built
frontend**, so the whole app is one service on one origin (which keeps the OAuth
flow and session cookie same-origin).

---

## Using the live app

1. Go to **https://amo-xt5x.onrender.com** and **Sign in with Google**.
2. Open **Settings → API Keys** and paste a key for at least one provider
   (e.g. Anthropic). Hit **Test** to confirm it works.
3. Start a new chat, pick a **provider + model**, and send a message — the
   response streams back.
4. Organize chats into **folders** in the sidebar; everything is saved to your
   account automatically.

> Note: the app runs on Render's free tier, which sleeps after ~15 minutes idle.
> The first request after a quiet spell can take ~50 seconds to wake up.

---

## Running locally

**Prerequisites:** Python 3.12+, Node 18+, and a local PostgreSQL instance.

### 1. Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Create `backend/.env`:

```bash
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/amo_dev"
SESSION_SECRET=          # python -c "import secrets; print(secrets.token_urlsafe(48))"
KEY_ENCRYPTION_KEY=      # python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
COOKIE_SECURE=false      # local dev is http

# Google OAuth (from Google Cloud Console → Credentials → OAuth client, Web app)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:5173/api/auth/google/callback
FRONTEND_URL=http://localhost:5173
```

Create the database tables, then start the server:

```bash
prisma migrate dev      # applies migrations + generates the client
./dev.sh                # uvicorn on http://localhost:3001
```

### 2. Frontend

```bash
cd frontend
npm install
npm run dev             # Vite on http://localhost:5173
```

The Vite dev server proxies `/api/*` to the backend on port 3001, so open
**http://localhost:5173** and sign in.

> Provider API keys are **not** set in `.env` — they're per-user and added inside
> the app under Settings once you're signed in (BYOK).

---

## How it works

- **Auth & isolation.** Google OAuth establishes identity; a signed, `HttpOnly`
  session cookie carries only the user id. Every database query is scoped by that
  user, so no user can read another's folders, chats, or keys.
- **BYOK key handling.** Stored keys are Fernet-encrypted in Postgres. On a chat
  request the key is decrypted in memory for the lifetime of that one request,
  used to call the provider, and never logged or sent to the browser.
- **Streaming.** The backend calls each provider's streaming endpoint and relays
  tokens to the client as Server-Sent Events, so responses appear as they're
  generated.

## Repository layout

```
backend/     FastAPI app (main.py), providers.py, security.py, Prisma schema + migrations
frontend/    React app — index.html + public/*.jsx, Vite config
Dockerfile   Single-image build (Python + Node) used for deployment
```

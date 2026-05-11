# StudyAI

An AI study assistant chat app. Pick a model, ask questions, attach files
or use voice — get streaming answers back.

## Stack

```
Frontend  →  React 18 + Vite 5
Backend   →  Node + Express (proxy for AI providers)
Models    →  Anthropic Claude, OpenAI GPT, Google Gemini
```

## Run it

```bash
# backend
cd backend && npm install && npm run dev

# frontend (new terminal)
cd frontend && npm install && npm run dev
```

Set your API keys in `backend/.env`:

```
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
```

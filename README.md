# AOM

AOM is an AI study assistant chat web app. While most AI's like Claude, ChatGPT, Copilot and many more focus on the individual chat messages, AOM focuses on a file system. Intended to be used as to help study, or organize important and related chat messages, AOM will help you keep track of your chats, and AI interactions.

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

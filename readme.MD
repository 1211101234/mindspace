# Mindspace 🌿

An anonymous, judgment-free mental health support space.  
No accounts. No usernames to choose. No message logs persisted to disk.

---

## Features

- 🎭 Auto-generated anonymous personas (e.g. `CalmRiver42`)
- 🏠 Topic rooms: Sanctuary, Anxiety, Grief, Stress, Sleep + custom rooms  
- 💬 1-on-1 private DMs (opt-in, mutual consent required)  
- 🔒 Fully ephemeral — messages exist in memory only (server reset = wipe)  

### UI / Design
- 🧩 Clean interface powered by **SVG icons** (scalable, lightweight, no raster assets)
- ⚡ Fast rendering — no heavy icon libraries required
- 🎨 Easy theming (SVG fill/stroke customizable via CSS)

### 🤖 AI Companion (Sage) — *In Progress*
> This feature is currently under development.

Planned behavior:
- Gentle, non-intrusive emotional support
- Context-aware responses (only when needed)
- Crisis detection with immediate escalation to helplines
- Smart silence (won’t interrupt active human support)
- Cooldown system to prevent spam

---

## Quick Start

```bash
npm install

# Set your Anthropic API key (for future Sage integration)
export ANTHROPIC_API_KEY=sk-ant-...

npm start
# → http://localhost:3000
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ Yes | Your Anthropic API key for Sage AI responses |
| `PORT` | No | Port to listen on (default: 3000) |
| `ALLOWED_ORIGIN` | No | Restrict CORS to a specific domain in production |

## Deploy to Railway (recommended)

```bash
git init
git add .
git commit -m "mindspace"
# push to GitHub, then connect repo on railway.app
```

In Railway dashboard → **Variables** tab, add:
```
ANTHROPIC_API_KEY = sk-ant-...
```

Railway auto-detects Node.js and runs `npm start`. Generate a domain under Settings → Networking.

## How Sage (AI) works

Sage listens to each room and decides whether to respond:
- **Always responds** to crisis keywords (self-harm, suicidal ideation) with helpline resources
- **Stays quiet** when 4+ users are actively supporting each other
- **8-second cooldown** per room — never floods the conversation
- If it has nothing useful to add, it replies `PASS` internally and stays silent

## Architecture

```
server.js
├── Anonymous persona generator
├── Room management (in-memory, ephemeral)
├── Crisis keyword detection
├── AI response logic (Anthropic SDK)
└── Socket.io events:
    ├── join room     → assigns room, sends history + presence
    ├── room message  → broadcasts + triggers AI if appropriate
    ├── dm request    → sends invite to target user
    ├── dm accept     → opens private channel between two sockets
    ├── dm message    → routes to DM partner only
    └── disconnect    → cleanup + notifies room

public/index.html
└── Single-file frontend (HTML + CSS + JS)
    ├── Landing: persona preview + room picker
    ├── Sidebar: room nav + presence list + DM buttons
    ├── Chat: message feed + AI typing indicator
    └── DM panel: overlay private chat
```

## Privacy notes

- No user accounts, emails, or passwords
- Personas are randomly generated each session — not stored anywhere
- Messages are in-memory only — a server restart wipes everything
- No analytics, no tracking
- If you want truly zero-knowledge, don't add a database layer

## Extending

**Add message persistence (opt-in rooms only):**
```bash
npm install better-sqlite3
```
Store messages in SQLite per room, clear on a rolling 24h TTL.

**Moderation:**
Add a keyword blocklist in `isCrisis()` / add a separate `isHarmful()` check that mutes the message and notifies the sender privately.

**Rate limiting:**
```bash
npm install express-rate-limit
```
Wrap the Socket.io `room message` handler with a per-socket message counter.
# Mindspace v2

Anonymous mental health support community with AI guide, crisis detection, moderation tools, and full persistence.

## Quick Start

```bash
npm install
node server.js
# → http://localhost:3000
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Optional | Enables Sage AI. Without it, community chat works fine. |
| `REDIS_URL` | Optional | e.g. `redis://localhost:6379`. Falls back to in-memory if not set. |
| `DB_PATH` | Optional | SQLite file path. Default: `./data/mindspace.db` |
| `MOD_SECRET` | Optional | Secret for moderator login. Auto-generated and printed on startup if not set. |
| `PORT` | Optional | Default: 3000 |
| `ALLOWED_ORIGIN` | Optional | CORS origin whitelist. Default: `*` |

## Features

### Safety & Crisis Detection
- Bilingual crisis detection (English + Bahasa Malaysia)
- Two confidence tiers: HIGH (immediate Sage response + mod alert) and MEDIUM (warm check-in)
- All crisis events logged to SQLite with timestamp, room, and confidence level
- Silent mod alerts — crisis notifications pushed to active moderators without disrupting the room

### Moderation
- Access: Press `Ctrl+Shift+M` in the app and enter the mod secret
- Moderators can: remove messages, pin messages, enable slow mode, review and dismiss flagged content
- Users can report any message with a reason — all reports go to the mod queue
- Auto-flagging: profanity and repeated characters trigger automatic content flags
- Mod secret printed to console on startup (set `MOD_SECRET` env to persist)

### Persistence
- **SQLite**: Messages, DMs, flagged content, crisis events, mood check-ins
- **Redis**: Rate limiting, session KV store (falls back to in-memory if not configured)
- Messages auto-pruned to 80 per room — privacy by design
- Server restart preserves room history and DM history

### AI (Sage)
- **Room mode**: Sage responds contextually when helpful; backs off when the community is flowing
- **Private 1-on-1**: Full session with memory, via "Talk to Sage privately"
- **Mood check-in**: On first join, users rate their mood 1-5; Sage responds privately
- **Per-user rate limit**: 30s minimum between AI responses triggered by same user
- **Room-level cooldown**: 8s minimum between AI messages per room

### Reactions
5 reactions available: ❤️ 🤗 👍 🕯️ 🌿
Hover any message to see the reaction bar. Reactions are persisted in SQLite.

### Threaded Replies
Click "↩ reply" on any message to quote and reply. Parent message ID stored on the reply.

### Mood Check-in
Anonymous 1-5 emoji check-in on room join. Scores aggregated per room (no individual tracking). Sage responds warmly based on score.

### Mobile
- Full mobile support with slide-in sidebar drawer (hamburger button)
- Touch-friendly reaction and reply UI
- Responsive layout down to 320px

### Dark Mode
Automatic — follows `prefers-color-scheme`. Full dark palette with all components adapted.

### Accessibility
- Skip link, ARIA roles and labels throughout
- Keyboard navigable room tiles, nav, and overlays
- `aria-live` regions for messages, typing, and notifications
- Focus-visible outlines on all interactive elements
- Escape key closes all overlay panels

## API Endpoints

```
GET  /health              → { status, sqlite, redis }
GET  /mod/flags           → Unreviewed flagged messages (requires x-mod-secret header)
POST /mod/flags/:id/review → Mark flag as reviewed (requires x-mod-secret header)
```

## File Structure

```
mindspace/
├── server.js        Main server + Socket.io event handlers
├── db.js            SQLite + Redis persistence layer
├── moderator.js     Crisis detection, content moderation, AI prompts
├── package.json
├── data/
│   └── mindspace.db  Auto-created SQLite database
└── public/
    └── index.html    Single-page frontend
```

## Installing Redis (optional but recommended)

**macOS**: `brew install redis && brew services start redis`
**Ubuntu**: `sudo apt install redis-server && sudo systemctl start redis`
**Docker**: `docker run -d -p 6379:6379 redis:alpine`

Then set: `REDIS_URL=redis://localhost:6379`
/**
 * server.js — Mindspace v2
 * Features: Redis + SQLite persistence, enhanced crisis detection (EN+BM),
 * moderation tools, reactions, threaded replies, mood check-ins,
 * 1-on-1 Sage sessions, per-user AI rate limiting, DOMPurify server-side
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const crypto     = require('crypto');

const db  = require('./db');
const mod = require('./Moderator');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET', 'POST'] },
  pingTimeout:  60000,
  pingInterval: 25000,
});

// ── Anthropic client ──────────────────────────────────────────────────────────
let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    console.log('✅ Sage AI enabled');
  } catch(e) {
    console.warn('⚠  npm install @anthropic-ai/sdk');
  }
} else {
  console.log('ℹ  No ANTHROPIC_API_KEY — Sage disabled');
}

// ── Static ────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.get('/health', (_req, res) => res.json({ status: 'ok', sqlite: !!db.db, redis: !!db.redis }));

// ── Mod admin endpoints ───────────────────────────────────────────────────────
app.get('/mod/flags', (req, res) => {
  if (req.headers['x-mod-secret'] !== mod.MOD_SECRET) return res.status(403).json({ error: 'forbidden' });
  res.json(db.getUnreviewedFlags());
});
app.post('/mod/flags/:id/review', (req, res) => {
  if (req.headers['x-mod-secret'] !== mod.MOD_SECRET) return res.status(403).json({ error: 'forbidden' });
  db.markFlagReviewed(parseInt(req.params.id));
  res.json({ ok: true });
});

// ── Persona generator ─────────────────────────────────────────────────────────
const ADJECTIVES = [
  'Calm','Gentle','Quiet','Soft','Still','Warm','Kind','Clear','Bright',
  'Tender','Peaceful','Serene','Open','Safe','Brave','Steady','Honest',
  'Hopeful','Patient','Mindful','Grounded','Resilient','Willing','Awake',
];
const NOUNS = [
  'River','Forest','Breeze','Dawn','Cloud','Shore','Garden','Stone',
  'Lantern','Feather','Ember','Willow','Brook','Meadow','Candle',
  'Harbor','Tide','Leaf','Star','Rain','Cedar','Valley','Pebble','Fern',
];
function generatePersona() {
  const adj  = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num  = Math.floor(Math.random() * 90) + 10;
  return `${adj}${noun}${num}`;
}

// ── Default rooms ─────────────────────────────────────────────────────────────
const DEFAULT_ROOMS = [
  { id: 'sanctuary', label: 'Sanctuary',    desc: 'General safe space for everyone' },
  { id: 'anxiety',   label: 'Anxiety',       desc: 'Managing worry & anxious thoughts' },
  { id: 'grief',     label: 'Grief & Loss',  desc: 'Processing loss and heartbreak' },
  { id: 'stress',    label: 'Stress',        desc: 'Work, life, and burnout support' },
  { id: 'sleep',     label: 'Sleep',         desc: 'Insomnia and rest struggles' },
];

// ── In-memory hot state (presence, active DMs) ─────────────────────────────────
// users: socketId -> { persona, room, dmPartner, isMod, joinTs }
const users = {};
// rooms: roomId -> { users: Set<socketId> }  — messages in SQLite
const rooms = {};
// dms: dmKey -> { messages: [] }
const dms   = {};
// sageSessions: socketId -> { messages: [] }  — private Sage 1-on-1
const sageSessions = {};
// aiRoomCooldown: roomId -> ts
const aiRoomCooldown = {};
// aiUserCooldown: socketId -> ts
const aiUserCooldown = {};

const AI_ROOM_COOLDOWN_MS = 8000;
const AI_USER_COOLDOWN_MS = 30000;

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) rooms[roomId] = { users: new Set() };
  return rooms[roomId];
}
function dmKey(a, b) { return [a,b].sort().join(':'); }
function getRoomPresence(roomId) {
  return Object.entries(users)
    .filter(([,u]) => u.room === roomId)
    .map(([id,u]) => ({ id, persona: u.persona, isMod: u.isMod || false }));
}
function hashId(socketId) {
  return crypto.createHash('sha256').update(socketId).digest('hex').slice(0,12);
}

// ── Sanitise text (server-side) ───────────────────────────────────────────────
function sanitise(text) {
  return String(text || '')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;')
    .trim()
    .slice(0, 600);
}

// ── AI response ───────────────────────────────────────────────────────────────
async function getAIResponse(context, recentMessages, triggerText) {
  if (!anthropic) return null;

  const systemPrompt = mod.buildSystemPrompt(context);
  const history = recentMessages.slice(-14).map(m => ({
    role: 'user',
    content: `${m.persona}: ${m.text}`,
  }));

  try {
    const response = await anthropic.messages.create({
      model:      'claude-opus-4-5',
      max_tokens: 220,
      system:     systemPrompt,
      messages: [
        ...history,
        { role: 'user', content: `[Latest] ${triggerText}\n\nRespond as Sage. If nothing genuinely helpful to add, reply exactly: PASS` },
      ],
    });
    const text = response.content[0]?.text?.trim();
    if (!text || text.startsWith('PASS')) return null;
    return text;
  } catch(err) {
    console.error('AI error:', err.message);
    return null;
  }
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  const persona = generatePersona();
  users[socket.id] = { persona, room: null, dmPartner: null, isMod: false, joinTs: Date.now() };

  socket.emit('assigned', { persona, rooms: DEFAULT_ROOMS });

  // ── Join room ──────────────────────────────────────────────────────────────
  socket.on('join room', async (roomId) => {
    const user = users[socket.id];
    if (!user) return;

    const safeId = (roomId || 'sanctuary')
      .toLowerCase().replace(/[^a-z0-9-]/g,'').slice(0,30) || 'sanctuary';

    if (user.room) {
      const prev = user.room;
      socket.leave(prev);
      getOrCreateRoom(prev).users.delete(socket.id);
      socket.to(prev).emit('notification', { type: 'leave', text: `${user.persona} left` });
      io.to(prev).emit('presence', getRoomPresence(prev));
    }

    user.room = safeId;
    socket.join(safeId);
    const room = getOrCreateRoom(safeId);
    room.users.add(socket.id);

    const history = db.getRoomHistory(safeId);
    socket.emit('room history', { roomId: safeId, messages: history });

    socket.to(safeId).emit('notification', { type: 'join', text: `${user.persona} joined` });
    io.to(safeId).emit('presence', getRoomPresence(safeId));

    // Mood check-in prompt (on first room join per session)
    if (!user.moodCheckedIn) {
      socket.emit('mood checkin prompt');
    }
  });

  // ── Mood check-in ─────────────────────────────────────────────────────────
  socket.on('mood checkin', async (score) => {
    const user = users[socket.id];
    if (!user || user.moodCheckedIn) return;
    const s = Math.min(5, Math.max(1, parseInt(score)));
    user.moodCheckedIn = true;
    db.saveMoodCheckin(user.room || 'unknown', s);

    if (anthropic && user.room) {
      const aiText = await getAIResponse('mood', [], `User mood score: ${s}/5`);
      if (aiText) {
        socket.emit('sage private', { text: aiText });
      }
    }
  });

  // ── Room message ───────────────────────────────────────────────────────────
  socket.on('room message', async (payload) => {
    const user = users[socket.id];
    if (!user || !user.room) return;

    const text     = sanitise(typeof payload === 'string' ? payload : payload.text);
    const parentId = payload.parentId || null;
    if (!text) return;

    // Rate limit: 20 messages / 30s per user
    const allowed = await db.checkRateLimit(`msg:${socket.id}`, 20, 30);
    if (!allowed) { socket.emit('rate limited', { message: 'Slow down a little 🙏' }); return; }

    // Content check
    const flags = mod.checkContent(text);

    const msg = {
      id:       Date.now().toString(36) + Math.random().toString(36).slice(2),
      roomId:   user.room,
      persona:  user.persona,
      text,
      ts:       Date.now(),
      isAI:     false,
      parentId,
      reactions:{},
    };

    db.saveMessage(msg);
    io.to(user.room).emit('room message', msg);

    // Crisis detection
    const crisis = mod.detectCrisis(text);
    if (crisis.level !== mod.CONFIDENCE.NONE) {
      db.logCrisisEvent({ roomId: user.room, persona: user.persona, text, confidence: crisis.level });
      // Notify mods silently
      Object.entries(users).forEach(([sid, u]) => {
        if (u.isMod) {
          io.to(sid).emit('mod alert', {
            type:      'crisis',
            level:     crisis.level,
            persona:   user.persona,
            room:      user.room,
            text,
            ts:        Date.now(),
          });
        }
      });
    }

    // Flag if content issues
    if (flags.length > 0 && flags.some(f => f !== 'contains_url')) {
      db.flagMessage({
        messageId:    msg.id,
        roomId:       user.room,
        persona:      user.persona,
        text,
        reporterHash: 'auto:content_filter',
        reason:       flags.join(','),
      });
    }

    // AI response
    const now          = Date.now();
    const roomCoolOk   = (now - (aiRoomCooldown[user.room] || 0)) > AI_ROOM_COOLDOWN_MS;
    const userCoolOk   = (now - (aiUserCooldown[socket.id] || 0)) > AI_USER_COOLDOWN_MS;
    const userCount    = getOrCreateRoom(user.room).users.size;
    const isCrisisHigh = crisis.level === mod.CONFIDENCE.HIGH;
    const isCrisisMed  = crisis.level === mod.CONFIDENCE.MEDIUM;

    const aiContext = isCrisisHigh ? 'crisis_high' : isCrisisMed ? 'crisis_medium' : 'room';
    const shouldRespond = isCrisisHigh
      || (isCrisisMed && userCoolOk)
      || (roomCoolOk && userCoolOk && (userCount < 4 || Math.random() < 0.3));

    if (shouldRespond && anthropic) {
      aiRoomCooldown[user.room] = now;
      aiUserCooldown[socket.id] = now;

      const history = db.getRoomHistory(user.room, 14);
      const aiText  = await getAIResponse(aiContext, history, text);
      if (aiText) {
        const aiMsg = {
          id:       Date.now().toString(36) + 'ai',
          roomId:   user.room,
          persona:  'Sage',
          text:     aiText,
          ts:       Date.now(),
          isAI:     true,
          parentId: isCrisisHigh ? msg.id : null,
          reactions:{},
        };
        db.saveMessage(aiMsg);
        io.to(user.room).emit('room message', aiMsg);
      }
    }
  });

  // ── Typing ─────────────────────────────────────────────────────────────────
  socket.on('typing', () => {
    const user = users[socket.id];
    if (user && user.room) socket.to(user.room).emit('typing', { persona: user.persona });
  });

  // ── Reactions ─────────────────────────────────────────────────────────────
  socket.on('react', ({ msgId, emoji }) => {
    const user  = users[socket.id];
    const VALID = ['❤️','🤗','👍','🕯️','🌿'];
    if (!user || !msgId || !VALID.includes(emoji)) return;

    // Load message reactions from history
    const history = db.getRoomHistory(user.room, 80);
    const msg = history.find(m => m.id === msgId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

    const idx = msg.reactions[emoji].indexOf(user.persona);
    if (idx === -1) msg.reactions[emoji].push(user.persona);
    else            msg.reactions[emoji].splice(idx, 1);
    if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];

    db.updateReactions(msgId, msg.reactions);
    io.to(user.room).emit('reaction update', { msgId, reactions: msg.reactions });
  });

  // ── Report message ─────────────────────────────────────────────────────────
  socket.on('report message', ({ msgId, text, reason }) => {
    const user = users[socket.id];
    if (!user) return;
    db.flagMessage({
      messageId:    msgId,
      roomId:       user.room,
      persona:      'reported',
      text:         sanitise(text),
      reporterHash: hashId(socket.id),
      reason:       sanitise(reason) || 'user report',
    });
    socket.emit('report ack');
  });

  // ── Mod: claim moderator role ──────────────────────────────────────────────
  socket.on('mod auth', (secret) => {
    if (!mod.verifyModSecret(secret)) { socket.emit('mod auth fail'); return; }
    users[socket.id].isMod = true;
    mod.grantMod(socket.id);
    socket.emit('mod auth ok', { flags: db.getUnreviewedFlags() });
    console.log(`🛡  Mod granted to ${users[socket.id]?.persona}`);
  });

  // ── Mod: remove a message ──────────────────────────────────────────────────
  socket.on('mod remove', ({ msgId, roomId }) => {
    if (!mod.isMod(socket.id)) return;
    if (db.db) db.db.prepare(`DELETE FROM messages WHERE id = ?`).run(msgId);
    io.to(roomId).emit('message removed', { msgId });
    socket.emit('mod ack', { action: 'remove', msgId });
  });

  // ── Mod: slow mode ─────────────────────────────────────────────────────────
  socket.on('mod slow mode', ({ roomId, seconds }) => {
    if (!mod.isMod(socket.id)) return;
    io.to(roomId).emit('slow mode', { seconds: seconds || 0 });
  });

  // ── Mod: pin message ───────────────────────────────────────────────────────
  socket.on('mod pin', ({ msgId, roomId, text, persona }) => {
    if (!mod.isMod(socket.id)) return;
    io.to(roomId).emit('pinned message', { msgId, text, persona });
  });

  // ── Mod: review flag ───────────────────────────────────────────────────────
  socket.on('mod review flag', (id) => {
    if (!mod.isMod(socket.id)) return;
    db.markFlagReviewed(id);
    socket.emit('mod ack', { action: 'review', id });
  });

  // ── 1-on-1 Sage session ────────────────────────────────────────────────────
  socket.on('sage start', () => {
    if (!sageSessions[socket.id]) sageSessions[socket.id] = { messages: [] };
    socket.emit('sage session open', {
      history: sageSessions[socket.id].messages,
    });
  });

  socket.on('sage message', async (text) => {
    const user = users[socket.id];
    if (!user) return;

    const clean = sanitise(text);
    if (!clean) return;

    if (!sageSessions[socket.id]) sageSessions[socket.id] = { messages: [] };
    const session = sageSessions[socket.id];

    const userMsg = { persona: user.persona, text: clean, ts: Date.now(), isUser: true };
    session.messages.push(userMsg);
    socket.emit('sage user message', userMsg);

    // Rate limit private Sage: 10 messages / 60s
    const allowed = await db.checkRateLimit(`sage:${socket.id}`, 10, 60);
    if (!allowed) {
      socket.emit('sage reply', { text: "Take a breath — we've been chatting a lot. Give it a minute, and I'm still here. 🌿" });
      return;
    }

    const crisis = mod.detectCrisis(clean);
    const ctx    = crisis.level === mod.CONFIDENCE.HIGH ? 'crisis_high'
                 : crisis.level === mod.CONFIDENCE.MEDIUM ? 'crisis_medium'
                 : 'private';

    if (crisis.level !== mod.CONFIDENCE.NONE) {
      db.logCrisisEvent({ roomId: `sage:${socket.id}`, persona: user.persona, text: clean, confidence: crisis.level });
    }

    if (!anthropic) {
      socket.emit('sage reply', { text: "I'm here with you. Sage AI isn't available right now, but the community rooms are open — you don't have to be alone. 🌿" });
      return;
    }

    const aiText = await getAIResponse(ctx, session.messages, clean);
    if (aiText) {
      const aiMsg = { persona: 'Sage', text: aiText, ts: Date.now(), isUser: false };
      session.messages.push(aiMsg);
      if (session.messages.length > 40) session.messages = session.messages.slice(-40);
      socket.emit('sage reply', aiMsg);
    }
  });

  socket.on('sage end', () => {
    delete sageSessions[socket.id];
    socket.emit('sage session closed');
  });

  // ── DM: request ───────────────────────────────────────────────────────────
  socket.on('dm request', (targetId) => {
    const user   = users[socket.id];
    const target = users[targetId];
    if (!user || !target || targetId === socket.id) return;
    io.to(targetId).emit('dm request', { fromId: socket.id, fromPersona: user.persona });
  });

  socket.on('dm accept', (fromId) => {
    const user = users[socket.id];
    const from = users[fromId];
    if (!user || !from) return;
    user.dmPartner = fromId;
    from.dmPartner = socket.id;
    const key = dmKey(socket.id, fromId);
    if (!dms[key]) dms[key] = { messages: db.getDMHistory(key) };
    socket.emit('dm open', { partnerId: fromId, partnerPersona: from.persona, history: dms[key].messages });
    io.to(fromId).emit('dm open', { partnerId: socket.id, partnerPersona: user.persona, history: dms[key].messages });
  });

  socket.on('dm message', (text) => {
    const user = users[socket.id];
    if (!user || !user.dmPartner) return;
    const clean = sanitise(text);
    if (!clean) return;
    const key = dmKey(socket.id, user.dmPartner);
    if (!dms[key]) dms[key] = { messages: [] };
    const msg = { id: Date.now().toString(36)+Math.random().toString(36).slice(2), persona: user.persona, text: clean, ts: Date.now() };
    dms[key].messages.push(msg);
    db.saveDMMessage(key, msg);
    socket.emit('dm message', msg);
    io.to(user.dmPartner).emit('dm message', msg);
  });

  socket.on('dm close', () => {
    const user = users[socket.id];
    if (!user || !user.dmPartner) return;
    const partnerId = user.dmPartner;
    user.dmPartner = null;
    if (users[partnerId]) { users[partnerId].dmPartner = null; io.to(partnerId).emit('dm closed'); }
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
      if (user.room) {
        getOrCreateRoom(user.room).users.delete(socket.id);
        socket.to(user.room).emit('notification', { type: 'leave', text: `${user.persona} left` });
        io.to(user.room).emit('presence', getRoomPresence(user.room));
      }
      if (user.dmPartner && users[user.dmPartner]) {
        users[user.dmPartner].dmPartner = null;
        io.to(user.dmPartner).emit('dm closed');
      }
      mod.revokeMod(socket.id);
      delete users[socket.id];
      delete sageSessions[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌿 Mindspace v2 running at http://localhost:${PORT}`));
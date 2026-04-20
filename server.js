const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET', 'POST'] },
});

// Sage AI is optional — activates when ANTHROPIC_API_KEY is set
let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    console.log('✅ Sage AI enabled');
  } catch(e) {
    console.log('⚠️  Run npm install to enable Sage AI');
  }
} else {
  console.log('ℹ️  No ANTHROPIC_API_KEY — Sage disabled, community chat works fine');
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Anonymous persona generator ──────────────────────────────────────────────
const ADJECTIVES = [
  'Calm','Gentle','Quiet','Soft','Still','Warm','Kind','Clear',
  'Bright','Tender','Peaceful','Serene','Open','Safe','Brave',
  'Steady','Honest','Hopeful','patient','Mindful',
];
const NOUNS = [
  'River','Forest','Breeze','Dawn','Cloud','Shore','Garden','Stone',
  'Lantern','Feather','Ember','Willow','Brook','Meadow','Candle',
  'Harbor','Tide','Leaf','Star','Rain',
];

function generatePersona() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${adj}${noun}${num}`;
}

// ── Predefined rooms ──────────────────────────────────────────────────────────
const DEFAULT_ROOMS = [
  { id: 'sanctuary',  label: 'Sanctuary',    desc: 'General safe space for everyone' },
  { id: 'anxiety',    label: 'Anxiety',       desc: 'Managing worry & anxious thoughts' },
  { id: 'grief',      label: 'Grief & Loss',  desc: 'Processing loss and heartbreak' },
  { id: 'stress',     label: 'Stress',        desc: 'Work, life, and burnout support' },
  { id: 'sleep',      label: 'Sleep',         desc: 'Insomnia and rest struggles' },
];

// ── In-memory state ───────────────────────────────────────────────────────────
// users: socket.id -> { persona, room, dmPartner }
const users = {};
// rooms: roomId -> { messages: [] (max 80, NOT persisted across restarts), users: Set }
const rooms = {};
// dms: dmKey -> { messages: [] }  dmKey = sorted([idA, idB]).join(':')
const dms = {};
// aiCooldown: roomId -> timestamp of last AI response
const aiCooldown = {};

const MAX_HISTORY = 80;
const AI_COOLDOWN_MS = 8000; // AI won't reply more often than every 8s per room

function getOrCreateRoom(roomId) {
  if (!rooms[roomId]) rooms[roomId] = { messages: [], users: new Set() };
  return rooms[roomId];
}

function dmKey(a, b) { return [a, b].sort().join(':'); }

function getRoomPresence(roomId) {
  return Object.entries(users)
    .filter(([, u]) => u.room === roomId)
    .map(([id, u]) => ({ id, persona: u.persona }));
}

// ── Crisis keyword detection ──────────────────────────────────────────────────
const CRISIS_PATTERNS = [
  /\bsuicid/i, /\bkill\s*(my)?self/i, /\bend\s*(my\s*)?life/i,
  /\bself.?harm/i, /\bcut\s*(my)?self/i, /\bwant\s*to\s*die/i,
  /\bno\s*reason\s*to\s*live/i, /\boverdos/i,
];
function isCrisis(text) { return CRISIS_PATTERNS.some(p => p.test(text)); }

// ── AI response logic ─────────────────────────────────────────────────────────
const AI_PERSONA = 'Sage';
const AI_ID = '__ai__';

async function getAIResponse(roomId, recentMessages, triggerText, crisis = false) {
  if (!anthropic) return null; // no API key set
  const history = recentMessages.slice(-12).map(m => ({
    role: 'user',
    content: `${m.persona}: ${m.text}`,
  }));

  const systemPrompt = crisis
    ? `You are Sage, a compassionate AI presence in a private anonymous mental health support space called Mindspace.
Someone has just shared something that suggests they may be in crisis or experiencing thoughts of self-harm.
Respond with warmth, without panic. Acknowledge their pain. Gently provide crisis resources:
- Malaysia: Befrienders KL: 03-7627 2929 (24hr)
- International: Crisis Text Line: Text HOME to 741741
- International Association for Suicide Prevention: https://www.iasp.info/resources/Crisis_Centres/
Do NOT diagnose. Do NOT be clinical. Be human, warm, present. Keep response under 120 words.`
    : `You are Sage, a gentle AI presence in Mindspace — a private, anonymous mental health support community.
Your role is to offer brief, warm, non-clinical support when it feels natural. You are NOT a therapist.
Guidelines:
- Be warm, present, and human — not robotic or formal
- Validate feelings before offering any perspective
- Never diagnose or prescribe
- Keep responses SHORT (60–100 words max) — this is a chat, not a therapy session
- Only respond when you genuinely have something helpful to add — silence is fine
- Use gentle language. No bullet points. No lists. Just natural conversation.
- If the conversation is flowing well between users, stay quiet
Current room: ${roomId}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 200,
      system: systemPrompt,
      messages: [
        ...history,
        { role: 'user', content: `[Latest message] ${triggerText}\n\nRespond as Sage now, briefly and warmly. If you have nothing genuinely helpful to add, reply with exactly: PASS` },
      ],
    });

    const text = response.content[0]?.text?.trim();
    if (!text || text === 'PASS' || text.startsWith('PASS')) return null;
    return text;
  } catch (err) {
    console.error('AI error:', err.message);
    return null;
  }
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // Assign anonymous persona immediately on connect
  const persona = generatePersona();
  users[socket.id] = { persona, room: null, dmPartner: null };

  // Send persona + room list to client
  socket.emit('assigned', { persona, rooms: DEFAULT_ROOMS });

  // ── Join a room ──
  socket.on('join room', (roomId) => {
    const user = users[socket.id];
    if (!user) return;

    const safeId = (roomId || 'sanctuary').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30) || 'sanctuary';

    // Leave previous room
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

    // Send recent history (no author IDs — just persona + text)
    socket.emit('room history', { roomId: safeId, messages: room.messages });

    // Notify others
    socket.to(safeId).emit('notification', { type: 'join', text: `${user.persona} joined` });
    io.to(safeId).emit('presence', getRoomPresence(safeId));
  });

  // ── Send room message ──
  socket.on('room message', async (text) => {
    const user = users[socket.id];
    if (!user || !user.room) return;

    const trimmed = (text || '').trim().slice(0, 600);
    if (!trimmed) return;

    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      persona: user.persona,
      text: trimmed,
      ts: Date.now(),
      isAI: false,
    };

    const room = getOrCreateRoom(user.room);
    room.messages.push(msg);
    if (room.messages.length > MAX_HISTORY) room.messages.shift();

    io.to(user.room).emit('room message', msg);

    // ── AI response logic ──
    const crisis = isCrisis(trimmed);
    const now = Date.now();
    const lastAI = aiCooldown[user.room] || 0;
    const cooldownOk = (now - lastAI) > AI_COOLDOWN_MS;
    const userCount = room.users.size;

    // Always respond to crisis. For normal messages: respond if cooldown ok.
    // With 3+ users active, AI steps back more (community can handle it).
    const shouldAIRespond = crisis || (cooldownOk && (userCount < 4 || Math.random() < 0.35));

    if (shouldAIRespond) {
      aiCooldown[user.room] = now;
      const aiText = await getAIResponse(user.room, room.messages, trimmed, crisis);
      if (aiText) {
        const aiMsg = {
          id: Date.now().toString(36) + 'ai',
          persona: AI_PERSONA,
          text: aiText,
          ts: Date.now(),
          isAI: true,
        };
        room.messages.push(aiMsg);
        if (room.messages.length > MAX_HISTORY) room.messages.shift();
        io.to(user.room).emit('room message', aiMsg);
      }
    }
  });

  // ── DM: request ──
  socket.on('dm request', (targetId) => {
    const user = users[socket.id];
    const target = users[targetId];
    if (!user || !target || targetId === socket.id) return;

    // Send request to target
    io.to(targetId).emit('dm request', { fromId: socket.id, fromPersona: user.persona });
  });

  // ── DM: accept ──
  socket.on('dm accept', (fromId) => {
    const user = users[socket.id];
    const from = users[fromId];
    if (!user || !from) return;

    user.dmPartner = fromId;
    from.dmPartner = socket.id;

    const key = dmKey(socket.id, fromId);
    if (!dms[key]) dms[key] = { messages: [] };

    socket.emit('dm open', { partnerId: fromId, partnerPersona: from.persona, history: dms[key].messages });
    io.to(fromId).emit('dm open', { partnerId: socket.id, partnerPersona: user.persona, history: dms[key].messages });
  });

  // ── DM: message ──
  socket.on('dm message', (text) => {
    const user = users[socket.id];
    if (!user || !user.dmPartner) return;

    const trimmed = (text || '').trim().slice(0, 600);
    if (!trimmed) return;

    const key = dmKey(socket.id, user.dmPartner);
    if (!dms[key]) dms[key] = { messages: [] };

    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      persona: user.persona,
      text: trimmed,
      ts: Date.now(),
    };

    dms[key].messages.push(msg);
    if (dms[key].messages.length > 100) dms[key].messages.shift();

    socket.emit('dm message', msg);
    io.to(user.dmPartner).emit('dm message', msg);
  });

  // ── DM: close ──
  socket.on('dm close', () => {
    const user = users[socket.id];
    if (!user || !user.dmPartner) return;
    const partnerId = user.dmPartner;
    user.dmPartner = null;
    if (users[partnerId]) {
      users[partnerId].dmPartner = null;
      io.to(partnerId).emit('dm closed');
    }
  });

  // ── Disconnect ──
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
      delete users[socket.id];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Mindspace running at http://localhost:${PORT}`));
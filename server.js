require('dotenv').config();
/**
 * server.js — Mindspace v3
 * Tier 1: Helmet, express-rate-limit, input validation, session expiry, pino logging
 * Tier 2: Dependency safeguards, CBT/DBT prompts, language detection, mod tokens
 * Tier 3: Message search endpoint, mood trend API, volunteer mod applications, scaling prep
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

// ── Structured logger ─────────────────────────────────────────────────────────
let log;
try {
  const pino = require("pino");
  log = pino({
    level: process.env.LOG_LEVEL || "info",
    transport:
      process.env.NODE_ENV !== "production"
        ? {
            target: "pino-pretty",
            options: { colorize: true, ignore: "pid,hostname" },
          }
        : undefined,
    redact: ["req.headers.authorization"],
  });
} catch (e) {
  // Fallback logger if pino not installed
  const L = (level, obj, msg) =>
    console.log(
      `[${level.toUpperCase()}]`,
      msg || obj,
      typeof obj === "string" ? "" : obj,
    );
  log = {
    info: (o, m) => L("info", o, m),
    warn: (o, m) => L("warn", o, m),
    error: (o, m) => L("error", o, m),
  };
}

const db = require("./db");
const mod = require("./moderator");

const app = express();
const server = http.createServer(app);

// ── Helmet security headers ───────────────────────────────────────────────────
try {
  const helmet = require("helmet");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "cdnjs.cloudflare.com", "'unsafe-inline'"],
          scriptSrcAttr: ["'unsafe-inline'"],
          styleSrc: ["'self'", "fonts.googleapis.com", "'unsafe-inline'"],
          fontSrc: ["'self'", "fonts.gstatic.com"],
          connectSrc: ["'self'", "wss:", "ws:"],
          imgSrc: ["'self'", "data:"],
          frameSrc: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );
  log.info("✅ Helmet active");
} catch (e) {
  log.warn("⚠  npm install helmet");
}

// ── HTTP rate limiting ────────────────────────────────────────────────────────
try {
  const rateLimit = require("express-rate-limit");
  const modLimiter = rateLimit({ windowMs: 60_000, max: 30 });
  const apiLimiter = rateLimit({ windowMs: 60_000, max: 100 });
  app.use("/mod", modLimiter);
  app.use("/api", apiLimiter);
  log.info("✅ HTTP rate limiting active");
} catch (e) {
  log.warn("⚠  npm install express-rate-limit");
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN || "*", methods: ["GET", "POST"] },
  pingTimeout: 60_000,
  pingInterval: 25_000,
  maxHttpBufferSize: 1e5,
});

// ── Anthropic ─────────────────────────────────────────────────────────────────
let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  try {
    const Anthropic = require("@anthropic-ai/sdk");
    anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    log.info("✅ Sage AI enabled");
  } catch (e) {
    log.warn("⚠  npm install @anthropic-ai/sdk");
  }
} else {
  log.info("ℹ  No ANTHROPIC_API_KEY — Sage disabled");
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "50kb" }));

// ── Mod token system ──────────────────────────────────────────────────────────
const modTokens = new Map(); // token -> { persona, issuedAt }
function issueModToken(persona) {
  const token = crypto.randomBytes(24).toString("hex");
  modTokens.set(token, { persona, issuedAt: Date.now() });
  return token;
}
function requireMod(req, res, next) {
  const secret = req.headers["x-mod-secret"];
  const token = req.headers["x-mod-token"];
  if (secret === mod.MOD_SECRET) return next();
  if (token) {
    const entry = modTokens.get(token);
    if (entry && Date.now() - entry.issuedAt < 8 * 3600_000) return next();
  }
  log.warn({ ip: req.ip }, "Unauthorised mod attempt");
  res.status(403).json({ error: "forbidden" });
}

// ── Input validation ──────────────────────────────────────────────────────────
const validateRoomId = (r) =>
  (typeof r === "string" ? r : "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 30) || "sanctuary";
const validateText = (t, max = 600) =>
  (typeof t === "string" ? t : "").trim().slice(0, max);
const validateScore = (s) => {
  const n = parseInt(s, 10);
  return isNaN(n) ? null : Math.min(5, Math.max(1, n));
};
const validateEmoji = (e) =>
  ["❤️", "🤗", "👍", "🕯️", "🌿"].includes(e) ? e : null;
function sanitise(t, max = 600) {
  return String(t || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/\//g, "&#x2F;")
    .trim()
    .slice(0, max);
}
function hashId(id) {
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 12);
}

// ── Persona generator ─────────────────────────────────────────────────────────
const ADJ = [
  "Calm",
  "Gentle",
  "Quiet",
  "Soft",
  "Still",
  "Warm",
  "Kind",
  "Clear",
  "Bright",
  "Tender",
  "Peaceful",
  "Serene",
  "Open",
  "Safe",
  "Brave",
  "Steady",
  "Honest",
  "Hopeful",
  "Patient",
  "Mindful",
  "Grounded",
  "Resilient",
  "Willing",
  "Awake",
];
const NOUN = [
  "River",
  "Forest",
  "Breeze",
  "Dawn",
  "Cloud",
  "Shore",
  "Garden",
  "Stone",
  "Lantern",
  "Feather",
  "Ember",
  "Willow",
  "Brook",
  "Meadow",
  "Candle",
  "Harbor",
  "Tide",
  "Leaf",
  "Star",
  "Rain",
  "Cedar",
  "Valley",
  "Pebble",
  "Fern",
];
const generatePersona = () =>
  `${ADJ[Math.floor(Math.random() * ADJ.length)]}${NOUN[Math.floor(Math.random() * NOUN.length)]}${Math.floor(Math.random() * 90) + 10}`;

// ── Default rooms ─────────────────────────────────────────────────────────────
const DEFAULT_ROOMS = [
  {
    id: "sanctuary",
    label: "Sanctuary",
    desc: "General safe space for everyone",
  },
  {
    id: "anxiety",
    label: "Anxiety",
    desc: "Managing worry & anxious thoughts",
  },
  {
    id: "grief",
    label: "Grief & Loss",
    desc: "Processing loss and heartbreak",
  },
  { id: "stress", label: "Stress", desc: "Work, life, and burnout support" },
  { id: "sleep", label: "Sleep", desc: "Insomnia and rest struggles" },
];

// ── In-memory state ───────────────────────────────────────────────────────────
const users = {};
const rooms = {};
const dms = {};
const sageSessions = {};
const aiRoomCooldown = {};
const aiUserCooldown = {};
const AI_ROOM_CD = 8_000;
const AI_USER_CD = 30_000;
const IDLE_LIMIT = 30 * 60_000;

// Sage dependency thresholds
const SAGE_NUDGE_AT = 12;
const SAGE_MAX = 20;
const SAGE_NUDGE =
  "I've noticed we've been talking for a while — that's okay, but it might also help to take a short break, step outside, or reach out to someone you trust. I'll be here when you're back. 🌿";

const getOrCreateRoom = (id) => {
  if (!rooms[id]) rooms[id] = { users: new Set() };
  return rooms[id];
};
const dmKey = (a, b) => [a, b].sort().join(":");
const getRoomPresence = (rid) =>
  Object.entries(users)
    .filter(([, u]) => u.room === rid)
    .map(([id, u]) => ({ id, persona: u.persona, isMod: u.isMod || false }));

// ── CBT/DBT daily prompt library ──────────────────────────────────────────────
const CBT_PROMPTS = [
  "What's one thought that's been looping in your head today? Try writing it down — sometimes that's enough to loosen its grip.",
  "If a close friend shared this worry with you, what would you tell them?",
  "Is this thought a fact, or an interpretation? What changes if you treat it as a possibility?",
  "Before you sleep tonight, name three small things that were okay today — not perfect, just okay.",
  "What's one small thing you've been putting off that would give you a little relief once done?",
  "What's one activity — even 10 minutes — that usually leaves you feeling slightly better?",
  "Who is one person you feel safe around? When did you last spend time with them?",
  "What matters most to you right now? Is your energy aligned with that?",
  "When things feel overwhelming, what's the one thing that has helped you get through hard moments before?",
  "What would 'good enough for today' look like — not perfect, just enough?",
  "What's one thing you can do in the next hour that is gentle and kind to yourself?",
  "What is one thing about your situation you cannot control? What might it mean to loosen your grip on it — just slightly?",
  "What would it mean to accept today exactly as it is, not as you wish it were?",
  "What's one quality about yourself — a skill, a way you showed up — you can acknowledge today, even quietly?",
  "Where do you feel stress in your body right now? Just noticing, no judgment needed.",
  "What's one boundary you could set this week to protect your energy?",
  "What does rest look like for you — not sleep, but genuine rest?",
  "If this difficult period is temporary (and it likely is), what would you want to remember from it?",
];
function getDailyPrompt(socketId) {
  const day = Math.floor(Date.now() / 86_400_000);
  const seed = parseInt(hashId(socketId + String(day)), 16);
  return CBT_PROMPTS[seed % CBT_PROMPTS.length];
}

// ── Language detection (EN / BM) ──────────────────────────────────────────────
const BM_PATTERN =
  /\b(saya|aku|kamu|awak|dia|kami|kita|mereka|tidak|tak|ada|tiada|sangat|memang|boleh|mahu|nak|dah|pun|lah|kan|ke\b|la\b|ye\b|ye ke|betul|macam|mcm|kenapa|siapa|bila|mana|camne|camana|macamana)\b/i;
function detectLang(text) {
  return BM_PATTERN.test(text) ? "bm" : "en";
}

// ── AI response ───────────────────────────────────────────────────────────────
async function getAIResponse(
  context,
  history,
  triggerText,
  lang = "en",
  memoryCtx = "",
) {
  if (!anthropic) return null;
  const baseSystem = mod.buildSystemPrompt(context, lang);
  const system = memoryCtx ? `${baseSystem}${memoryCtx}` : baseSystem;
  const msgs = history
    .slice(-14)
    .map((m) => ({ role: "user", content: `${m.persona}: ${m.text}` }));
  try {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 220,
      system,
      messages: [
        ...msgs,
        {
          role: "user",
          content: `[Latest] ${triggerText}\n\nRespond as Sage. If nothing genuinely helpful to add, reply exactly: PASS`,
        },
      ],
    });
    const text = res.content[0]?.text?.trim();
    return !text || text.startsWith("PASS") ? null : text;
  } catch (err) {
    log.error({ err: err.message }, "AI error");
    return null;
  }
}

// ── Session expiry ────────────────────────────────────────────────────────────
try {
  const cron = require("node-cron");
  cron.schedule("*/5 * * * *", () => {
    const now = Date.now();
    let expired = 0;
    Object.entries(users).forEach(([sid, user]) => {
      if (user.lastActive && now - user.lastActive > IDLE_LIMIT) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) {
          sock.emit("session expiring", {
            message:
              "Your session has been idle for 30 minutes. Reconnect when you're ready. 💚",
          });
          setTimeout(() => sock.disconnect(true), 5000);
          expired++;
        }
      }
    });
    if (expired > 0) log.info({ expired }, "Session expiry sweep");
  });
  log.info("✅ Session expiry cron active");
} catch (e) {
  log.warn("⚠  npm install node-cron for session expiry");
}

// ── HTTP routes ───────────────────────────────────────────────────────────────
app.get("/health", (_, res) =>
  res.json({ status: "ok", sqlite: !!db.db, redis: !!db.redis }),
);
app.get("/safety", (_, res) =>
  res.sendFile(path.join(__dirname, "public", "safety.html")),
);

app.get("/api/mood/:roomId", (req, res) => {
  const roomId = validateRoomId(req.params.roomId);
  res.json({ roomId, trend: db.getMoodTrend(roomId, 7) });
});

app.get("/api/search/:roomId", (req, res) => {
  const roomId = validateRoomId(req.params.roomId);
  const q = validateText(req.query.q, 80);
  if (!q || q.length < 2) return res.json({ results: [] });
  res.json({ results: db.searchMessages(roomId, q) });
});

// Mod endpoints
app.get("/mod/flags", requireMod, (_, res) =>
  res.json(db.getUnreviewedFlags()),
);
app.post("/mod/flags/:id/review", requireMod, (req, res) => {
  db.markFlagReviewed(parseInt(req.params.id));
  res.json({ ok: true });
});
app.post("/mod/token", requireMod, (req, res) => {
  const token = issueModToken(sanitise(req.body?.persona || "unknown", 50));
  res.json({ token });
});
app.post("/mod/apply", (req, res) => {
  const { persona, why, availability } = req.body || {};
  if (!persona || !why)
    return res.status(400).json({ error: "Missing fields" });
  db.saveModApplication({
    persona: sanitise(persona, 50),
    why: sanitise(why, 500),
    availability: sanitise(availability || "", 100),
  });
  log.info({ persona }, "Mod application");
  res.json({
    ok: true,
    message: "Application received. We'll be in touch via the room.",
  });
});

// ── Mod dashboard routes ──────────────────────────────────────────────────────
app.get("/mod/dashboard/stats", requireMod, (req, res) => {
  const totalUsers = Object.keys(users).length;
  const activeRooms = Object.values(rooms).filter(
    (r) => r.users.size > 0,
  ).length;
  const pendingFlags = db.getUnreviewedFlags().length;
  const crisisToday = db.getCrisisToday ? db.getCrisisToday() : 0;
  const pendingApps = db.getModApplications
    ? db.getModApplications().length
    : 0;
  res.json({ totalUsers, activeRooms, pendingFlags, crisisToday, pendingApps });
});

app.get("/mod/rooms", requireMod, (req, res) => {
  const roomList = Object.entries(rooms).map(([id, room]) => {
    const meta = DEFAULT_ROOMS.find((r) => r.id === id) || { label: id };
    const trend = db.getMoodTrend(id, 1);
    const avgMood = trend.length ? trend[0].avg : null;
    const history = db.getRoomHistory(id, 1);
    const lastMsg = history.length ? history[history.length - 1].text : null;
    return {
      id,
      label: meta.label || id,
      userCount: room.users.size,
      avgMood,
      lastMsg,
    };
  });
  // Include default rooms with 0 users too
  DEFAULT_ROOMS.forEach((r) => {
    if (!roomList.find((x) => x.id === r.id)) {
      roomList.push({
        id: r.id,
        label: r.label,
        userCount: 0,
        avgMood: null,
        lastMsg: null,
      });
    }
  });
  res.json({ rooms: roomList });
});

app.get("/mod/applications", requireMod, (req, res) => {
  const applications = db.getModApplications ? db.getModApplications() : [];
  res.json({ applications });
});

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  const persona = generatePersona();
  users[socket.id] = {
    persona,
    room: null,
    dmPartner: null,
    isMod: false,
    joinTs: Date.now(),
    lastActive: Date.now(),
    lang: "en",
  };
  socket.emit("assigned", { persona, rooms: DEFAULT_ROOMS });
  socket.onAny(() => {
    if (users[socket.id]) users[socket.id].lastActive = Date.now();
  });

  // ── Join room ──────────────────────────────────────────────────────────────
  socket.on("join room", (roomId) => {
    const user = users[socket.id];
    if (!user) return;
    const safeId = validateRoomId(roomId);
    if (user.room) {
      socket.leave(user.room);
      getOrCreateRoom(user.room).users.delete(socket.id);
      socket
        .to(user.room)
        .emit("notification", { type: "leave", text: `${user.persona} left` });
      io.to(user.room).emit("presence", getRoomPresence(user.room));
    }
    user.room = safeId;
    socket.join(safeId);
    getOrCreateRoom(safeId).users.add(socket.id);
    socket.emit("room history", {
      roomId: safeId,
      messages: db.getRoomHistory(safeId),
    });
    socket
      .to(safeId)
      .emit("notification", { type: "join", text: `${user.persona} joined` });
    io.to(safeId).emit("presence", getRoomPresence(safeId));
    if (!user.moodCheckedIn) socket.emit("mood checkin prompt");
    setTimeout(
      () => socket.emit("daily prompt", { text: getDailyPrompt(socket.id) }),
      3500,
    );
  });

  // ── Mood check-in ─────────────────────────────────────────────────────────
  socket.on("mood checkin", async (score) => {
    const user = users[socket.id];
    if (!user || user.moodCheckedIn) return;
    const s = validateScore(score);
    if (!s) return;
    user.moodCheckedIn = true;
    db.saveMoodCheckin(user.room || "unknown", s);
    if (anthropic) {
      const t = await getAIResponse(
        "mood",
        [],
        `User mood score: ${s}/5`,
        user.lang,
      );
      if (t) socket.emit("sage private", { text: t });
    }
  });

  // ── Room message ───────────────────────────────────────────────────────────
  socket.on("room message", async (payload) => {
    const user = users[socket.id];
    if (!user || !user.room) return;
    const raw = typeof payload === "string" ? payload : payload?.text || "";
    const text = sanitise(raw);
    const parentId =
      typeof payload?.parentId === "string"
        ? payload.parentId.slice(0, 32)
        : null;
    if (!text) return;

    const ok = await db.checkRateLimit(`msg:${socket.id}`, 20, 30);
    if (!ok) {
      socket.emit("rate limited", { message: "Slow down a little 🙏" });
      return;
    }

    user.lang = detectLang(text);
    const flags = mod.checkContent(text);
    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      roomId: user.room,
      persona: user.persona,
      text,
      ts: Date.now(),
      isAI: false,
      parentId,
      reactions: {},
    };
    db.saveMessage(msg);
    io.to(user.room).emit("room message", msg);

    if (flags.length && flags.some((f) => f !== "contains_url"))
      db.flagMessage({
        messageId: msg.id,
        roomId: user.room,
        persona: user.persona,
        text,
        reporterHash: "auto",
        reason: flags.join(","),
      });

    const crisis = mod.detectCrisis(text);
    if (crisis.level !== mod.CONFIDENCE.NONE) {
      db.logCrisisEvent({
        roomId: user.room,
        persona: user.persona,
        text,
        confidence: crisis.level,
      });
      Object.entries(users).forEach(([sid, u]) => {
        if (u.isMod)
          io.to(sid).emit("mod alert", {
            type: "crisis",
            level: crisis.level,
            persona: user.persona,
            room: user.room,
            ts: Date.now(),
          });
      });
    }

    const now = Date.now(),
      roomOk = now - (aiRoomCooldown[user.room] || 0) > AI_ROOM_CD,
      userOk = now - (aiUserCooldown[socket.id] || 0) > AI_USER_CD;
    const uCount = getOrCreateRoom(user.room).users.size;
    const isHigh = crisis.level === mod.CONFIDENCE.HIGH,
      isMid = crisis.level === mod.CONFIDENCE.MEDIUM;
    const ctx = isHigh ? "crisis_high" : isMid ? "crisis_medium" : "room";
    const shouldAI =
      isHigh ||
      (isMid && userOk) ||
      (roomOk && userOk && (uCount < 4 || Math.random() < 0.3));

    if (shouldAI && anthropic) {
      aiRoomCooldown[user.room] = now;
      aiUserCooldown[socket.id] = now;
      const t = await getAIResponse(
        ctx,
        db.getRoomHistory(user.room, 14),
        text,
        user.lang,
      );
      if (t) {
        const m = {
          id: Date.now().toString(36) + "ai",
          roomId: user.room,
          persona: "Sage",
          text: t,
          ts: Date.now(),
          isAI: true,
          parentId: isHigh ? msg.id : null,
          reactions: {},
        };
        db.saveMessage(m);
        io.to(user.room).emit("room message", m);
      }
    }
  });

  socket.on("typing", () => {
    const u = users[socket.id];
    if (u?.room) socket.to(u.room).emit("typing", { persona: u.persona });
  });

  socket.on("react", ({ msgId, emoji }) => {
    const user = users[socket.id];
    if (!user) return;
    const e = validateEmoji(emoji);
    if (!e || typeof msgId !== "string") return;
    const h = db.getRoomHistory(user.room, 80),
      m = h.find((x) => x.id === msgId);
    if (!m) return;
    if (!m.reactions) m.reactions = {};
    if (!m.reactions[e]) m.reactions[e] = [];
    const idx = m.reactions[e].indexOf(user.persona);
    if (idx === -1) m.reactions[e].push(user.persona);
    else m.reactions[e].splice(idx, 1);
    if (!m.reactions[e].length) delete m.reactions[e];
    db.updateReactions(msgId, m.reactions);
    io.to(user.room).emit("reaction update", { msgId, reactions: m.reactions });
  });

  socket.on("report message", ({ msgId, text, reason }) => {
    const user = users[socket.id];
    if (!user || typeof msgId !== "string") return;
    db.flagMessage({
      messageId: msgId.slice(0, 32),
      roomId: user.room,
      persona: "reported",
      text: sanitise(text, 200),
      reporterHash: hashId(socket.id),
      reason: sanitise(reason, 80) || "user report",
    });
    socket.emit("report ack");
  });

  socket.on("mod auth", (secret) => {
    if (!mod.verifyModSecret(secret)) {
      socket.emit("mod auth fail");
      return;
    }
    users[socket.id].isMod = true;
    mod.grantMod(socket.id);
    const token = issueModToken(users[socket.id].persona);
    socket.emit("mod auth ok", { flags: db.getUnreviewedFlags(), token });
    log.info({ persona: users[socket.id]?.persona }, "Mod granted");
  });
  socket.on("mod remove", ({ msgId, roomId }) => {
    if (!mod.isMod(socket.id)) return;
    if (db.db) db.db.prepare("DELETE FROM messages WHERE id=?").run(msgId);
    io.to(roomId).emit("message removed", { msgId });
  });
  socket.on("mod slow mode", ({ roomId, seconds }) => {
    if (!mod.isMod(socket.id)) return;
    io.to(roomId).emit("slow mode", { seconds: seconds || 0 });
  });
  socket.on("mod pin", ({ msgId, roomId, text, persona }) => {
    if (!mod.isMod(socket.id)) return;
    io.to(roomId).emit("pinned message", { msgId, text, persona });
  });
  socket.on("mod review flag", (id) => {
    if (!mod.isMod(socket.id)) return;
    db.markFlagReviewed(id);
    socket.emit("mod ack", { action: "review", id });
  });

  // ── Mod dashboard socket handlers ─────────────────────────────────────────────
  socket.on("mod request dashboard", () => {
    if (!mod.isMod(socket.id)) return;
    const totalUsers = Object.keys(users).length;
    const activeRooms = Object.values(rooms).filter(
      (r) => r.users.size > 0,
    ).length;
    const roomList = Object.entries(rooms).map(([id, room]) => {
      const meta = DEFAULT_ROOMS.find((r) => r.id === id) || { label: id };
      const trend = db.getMoodTrend(id, 1);
      const avgMood = trend.length ? trend[0].avg : null;
      const history = db.getRoomHistory(id, 1);
      const lastMsg = history.length ? history[history.length - 1].text : null;
      return {
        id,
        label: meta.label || id,
        userCount: room.users.size,
        avgMood,
        lastMsg,
      };
    });
    socket.emit("mod dashboard data", {
      stats: { totalUsers, activeRooms },
      rooms: roomList,
    });
  });

  socket.on("mod broadcast", ({ roomId, text }) => {
    if (!mod.isMod(socket.id)) return;
    const clean = sanitise(text, 400);
    if (!clean) return;
    const msg = {
      id: Date.now().toString(36) + "guide",
      persona: "Room Guide",
      text: clean,
      ts: Date.now(),
      isAI: false,
      reactions: {},
    };
    if (roomId) {
      msg.roomId = roomId;
      db.saveMessage(msg);
      io.to(roomId).emit("room message", msg);
    } else {
      Object.keys(rooms).forEach((rid) => {
        const m = { ...msg, id: Date.now().toString(36) + rid, roomId: rid };
        db.saveMessage(m);
        io.to(rid).emit("room message", m);
      });
    }
    log.info(
      { persona: users[socket.id]?.persona, roomId: roomId || "all" },
      "Mod broadcast",
    );
  });

  // ── Sage 1-on-1 (with dependency safeguards) ──────────────────────────────
  socket.on("sage start", () => {
    if (!sageSessions[socket.id])
      sageSessions[socket.id] = {
        messages: [],
        startTs: Date.now(),
        msgCount: 0,
        nudgeSent: false,
      };
    socket.emit("sage session open", {
      history: sageSessions[socket.id].messages,
    });
  });
  socket.on("sage message", async (text) => {
    const user = users[socket.id];
    if (!user) return;
    const clean = sanitise(text);
    if (!clean) return;
    if (!sageSessions[socket.id])
      sageSessions[socket.id] = {
        messages: [],
        startTs: Date.now(),
        msgCount: 0,
        nudgeSent: false,
      };
    const sess = sageSessions[socket.id];

    if (sess.msgCount >= SAGE_MAX) {
      socket.emit("sage reply", {
        text: "We've been talking for quite a while. It's a good time for a break — sometimes stepping away helps things settle. You can always come back, or visit the community room. Take care. 🌿",
        isBreak: true,
      });
      return;
    }
    sess.msgCount++;
    const userMsg = {
      persona: user.persona,
      text: clean,
      ts: Date.now(),
      isUser: true,
    };
    sess.messages.push(userMsg);
    socket.emit("sage user message", userMsg);

    const ok = await db.checkRateLimit(`sage:${socket.id}`, 10, 60);
    if (!ok) {
      socket.emit("sage reply", {
        text: "Take a breath — give it a minute, and I'm still here. 🌿",
      });
      return;
    }

    const crisis = mod.detectCrisis(clean);
    if (crisis.level !== mod.CONFIDENCE.NONE)
      db.logCrisisEvent({
        roomId: `sage:${socket.id}`,
        persona: user.persona,
        text: clean,
        confidence: crisis.level,
      });

    if (sess.msgCount === SAGE_NUDGE_AT && !sess.nudgeSent) {
      sess.nudgeSent = true;
      socket.emit("sage reply", { text: SAGE_NUDGE, isNudge: true });
    }

    if (!anthropic) {
      socket.emit("sage reply", {
        text: "I'm here with you. Sage AI isn't available right now, but the community rooms are open. 🌿",
      });
      return;
    }

    const ctx =
      crisis.level === mod.CONFIDENCE.HIGH
        ? "crisis_high"
        : crisis.level === mod.CONFIDENCE.MEDIUM
          ? "crisis_medium"
          : "private";
    const memCtx = user.sageMemoryCtx || "";
    const t = await getAIResponse(ctx, sess.messages, clean, user.lang, memCtx);
    if (t) {
      const m = { persona: "Sage", text: t, ts: Date.now(), isUser: false };
      sess.messages.push(m);
      if (sess.messages.length > 40) sess.messages = sess.messages.slice(-40);
      socket.emit("sage reply", m);
    }
  });
  socket.on("sage end", () => {
    delete sageSessions[socket.id];
    socket.emit("sage session closed");
  });

  // Sage memory context — client sends encrypted memory summary, we prepend to next session prompt
  socket.on("sage memory context", (ctx) => {
    if (typeof ctx !== "string") return;
    const user = users[socket.id];
    if (!user) return;
    user.sageMemoryCtx = ctx.slice(0, 2000); // cap at 2000 chars
  });

  // ── DM ──────────────────────────────────────────────────────────────────────
  socket.on("dm request", (targetId) => {
    const u = users[socket.id],
      t = users[targetId];
    if (!u || !t || targetId === socket.id) return;
    io.to(targetId).emit("dm request", {
      fromId: socket.id,
      fromPersona: u.persona,
    });
  });
  socket.on("dm accept", (fromId) => {
    const u = users[socket.id],
      f = users[fromId];
    if (!u || !f) return;
    u.dmPartner = fromId;
    f.dmPartner = socket.id;
    const key = dmKey(socket.id, fromId);
    if (!dms[key]) dms[key] = { messages: db.getDMHistory(key) };
    socket.emit("dm open", {
      partnerId: fromId,
      partnerPersona: f.persona,
      history: dms[key].messages,
    });
    io.to(fromId).emit("dm open", {
      partnerId: socket.id,
      partnerPersona: u.persona,
      history: dms[key].messages,
    });
  });
  socket.on("dm message", (text) => {
    const u = users[socket.id];
    if (!u || !u.dmPartner) return;
    const clean = sanitise(text);
    if (!clean) return;
    const key = dmKey(socket.id, u.dmPartner);
    if (!dms[key]) dms[key] = { messages: [] };
    const m = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      persona: u.persona,
      text: clean,
      ts: Date.now(),
    };
    dms[key].messages.push(m);
    db.saveDMMessage(key, m);
    socket.emit("dm message", m);
    io.to(u.dmPartner).emit("dm message", m);
  });
  socket.on("dm close", () => {
    const u = users[socket.id];
    if (!u || !u.dmPartner) return;
    const pid = u.dmPartner;
    u.dmPartner = null;
    if (users[pid]) {
      users[pid].dmPartner = null;
      io.to(pid).emit("dm closed");
    }
  });

  socket.on("disconnect", () => {
    const u = users[socket.id];
    if (!u) return;
    if (u.room) {
      getOrCreateRoom(u.room).users.delete(socket.id);
      socket
        .to(u.room)
        .emit("notification", { type: "leave", text: `${u.persona} left` });
      io.to(u.room).emit("presence", getRoomPresence(u.room));
    }
    if (u.dmPartner && users[u.dmPartner]) {
      users[u.dmPartner].dmPartner = null;
      io.to(u.dmPartner).emit("dm closed");
    }
    mod.revokeMod(socket.id);
    delete users[socket.id];
    delete sageSessions[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log.info({ port: PORT }, "🌿 Mindspace v3"));

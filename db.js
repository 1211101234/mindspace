/**
 * db.js — Persistence layer for Mindspace
 * Uses SQLite (better-sqlite3) for messages/flags/mods
 * Uses Redis (ioredis) for presence/sessions if available, else falls back to in-memory
 */

const path = require('path');
const fs   = require('fs');

// ── SQLite ────────────────────────────────────────────────────────────────────
let Database;
try { Database = require('better-sqlite3'); } catch(e) {
  console.warn('⚠  better-sqlite3 not installed — run: npm install better-sqlite3');
  Database = null;
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'mindspace.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let db = null;
if (Database) {
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id         TEXT PRIMARY KEY,
      room_id    TEXT NOT NULL,
      persona    TEXT NOT NULL,
      text       TEXT NOT NULL,
      is_ai      INTEGER DEFAULT 0,
      ts         INTEGER NOT NULL,
      parent_id  TEXT,
      reactions  TEXT DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, ts);

    CREATE TABLE IF NOT EXISTS dm_messages (
      id         TEXT PRIMARY KEY,
      dm_key     TEXT NOT NULL,
      persona    TEXT NOT NULL,
      text       TEXT NOT NULL,
      ts         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dm_key ON dm_messages(dm_key, ts);

    CREATE TABLE IF NOT EXISTS flagged_messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id    TEXT NOT NULL,
      room_id       TEXT,
      persona       TEXT,
      text          TEXT,
      reporter_hash TEXT,
      reason        TEXT,
      ts            INTEGER NOT NULL,
      reviewed      INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS crisis_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    TEXT,
      persona    TEXT,
      text       TEXT,
      confidence TEXT,
      ts         INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS moderators (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_hash TEXT UNIQUE NOT NULL,
      socket_id    TEXT,
      granted_ts   INTEGER,
      active       INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS mood_checkins (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id  TEXT NOT NULL,
      score    INTEGER NOT NULL,
      ts       INTEGER NOT NULL
    );
  `);
  console.log('✅ SQLite ready:', DB_PATH);
}

// ── Redis ─────────────────────────────────────────────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL);
    redis.on('connect', () => console.log('✅ Redis connected'));
    redis.on('error',   (e) => console.warn('⚠  Redis error:', e.message));
  } catch(e) {
    console.warn('⚠  ioredis not installed — run: npm install ioredis');
  }
}

// ── In-memory fallback ────────────────────────────────────────────────────────
const memStore = {};

// ── Unified KV helpers (Redis or memory) ─────────────────────────────────────
async function kvSet(key, value, ttlSeconds) {
  const str = JSON.stringify(value);
  if (redis) {
    if (ttlSeconds) await redis.set(key, str, 'EX', ttlSeconds);
    else            await redis.set(key, str);
  } else {
    memStore[key] = { value, expires: ttlSeconds ? Date.now() + ttlSeconds*1000 : null };
  }
}
async function kvGet(key) {
  if (redis) {
    const v = await redis.get(key);
    return v ? JSON.parse(v) : null;
  }
  const entry = memStore[key];
  if (!entry) return null;
  if (entry.expires && Date.now() > entry.expires) { delete memStore[key]; return null; }
  return entry.value;
}
async function kvDel(key) {
  if (redis) await redis.del(key);
  else       delete memStore[key];
}
async function kvKeys(pattern) {
  if (redis) return await redis.keys(pattern);
  const rx = new RegExp('^' + pattern.replace(/\*/g,'.*') + '$');
  return Object.keys(memStore).filter(k => {
    const e = memStore[k];
    if (e.expires && Date.now() > e.expires) { delete memStore[k]; return false; }
    return rx.test(k);
  });
}

// ── Message helpers ───────────────────────────────────────────────────────────
const MAX_ROOM_HISTORY = 80;

function saveMessage(msg) {
  if (!db) return;
  db.prepare(`
    INSERT OR REPLACE INTO messages (id, room_id, persona, text, is_ai, ts, parent_id, reactions)
    VALUES (@id, @room_id, @persona, @text, @is_ai, @ts, @parent_id, @reactions)
  `).run({
    id:        msg.id,
    room_id:   msg.roomId,
    persona:   msg.persona,
    text:      msg.text,
    is_ai:     msg.isAI ? 1 : 0,
    ts:        msg.ts,
    parent_id: msg.parentId || null,
    reactions: JSON.stringify(msg.reactions || {}),
  });
  // Prune old messages
  db.prepare(`
    DELETE FROM messages WHERE room_id = ? AND id NOT IN (
      SELECT id FROM messages WHERE room_id = ? ORDER BY ts DESC LIMIT ?
    )
  `).run(msg.roomId, msg.roomId, MAX_ROOM_HISTORY);
}

function getRoomHistory(roomId, limit = MAX_ROOM_HISTORY) {
  if (!db) return [];
  return db.prepare(`
    SELECT * FROM messages WHERE room_id = ? ORDER BY ts DESC LIMIT ?
  `).all(roomId, limit).reverse().map(row => ({
    id:       row.id,
    roomId:   row.room_id,
    persona:  row.persona,
    text:     row.text,
    isAI:     row.is_ai === 1,
    ts:       row.ts,
    parentId: row.parent_id || null,
    reactions:JSON.parse(row.reactions || '{}'),
  }));
}

function updateReactions(msgId, reactions) {
  if (!db) return;
  db.prepare(`UPDATE messages SET reactions = ? WHERE id = ?`)
    .run(JSON.stringify(reactions), msgId);
}

function saveDMMessage(dmKey, msg) {
  if (!db) return;
  db.prepare(`
    INSERT OR REPLACE INTO dm_messages (id, dm_key, persona, text, ts)
    VALUES (@id, @dm_key, @persona, @text, @ts)
  `).run({ id: msg.id, dm_key: dmKey, persona: msg.persona, text: msg.text, ts: msg.ts });
}

function getDMHistory(dmKey, limit = 100) {
  if (!db) return [];
  return db.prepare(`SELECT * FROM dm_messages WHERE dm_key = ? ORDER BY ts DESC LIMIT ?`)
    .all(dmKey, limit).reverse();
}

// ── Moderation helpers ────────────────────────────────────────────────────────
function flagMessage({ messageId, roomId, persona, text, reporterHash, reason }) {
  if (!db) return;
  db.prepare(`
    INSERT INTO flagged_messages (message_id, room_id, persona, text, reporter_hash, reason, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(messageId, roomId, persona, text, reporterHash, reason || 'user report', Date.now());
}

function logCrisisEvent({ roomId, persona, text, confidence }) {
  if (!db) return;
  db.prepare(`
    INSERT INTO crisis_events (room_id, persona, text, confidence, ts)
    VALUES (?, ?, ?, ?, ?)
  `).run(roomId, persona, text, confidence, Date.now());
}

function getUnreviewedFlags() {
  if (!db) return [];
  return db.prepare(`SELECT * FROM flagged_messages WHERE reviewed = 0 ORDER BY ts DESC`).all();
}

function markFlagReviewed(id) {
  if (!db) return;
  db.prepare(`UPDATE flagged_messages SET reviewed = 1 WHERE id = ?`).run(id);
}

// ── Mood helpers ──────────────────────────────────────────────────────────────
function saveMoodCheckin(roomId, score) {
  if (!db) return;
  db.prepare(`INSERT INTO mood_checkins (room_id, score, ts) VALUES (?, ?, ?)`)
    .run(roomId, score, Date.now());
}

function getRoomMoodAverage(roomId, withinMs = 3600000) {
  if (!db) return null;
  const since = Date.now() - withinMs;
  const row = db.prepare(`
    SELECT AVG(score) as avg, COUNT(*) as cnt
    FROM mood_checkins WHERE room_id = ? AND ts > ?
  `).get(roomId, since);
  return row && row.cnt > 0 ? { avg: parseFloat(row.avg.toFixed(1)), count: row.cnt } : null;
}

// ── Rate limiting (Redis-backed or memory) ────────────────────────────────────
const memRateLimits = {};
async function checkRateLimit(key, maxCount, windowSeconds) {
  const now = Date.now();
  if (redis) {
    const pipe = redis.pipeline();
    pipe.lpush(key, now);
    pipe.ltrim(key, 0, maxCount - 1);
    pipe.lrange(key, 0, -1);
    pipe.expire(key, windowSeconds);
    const results = await pipe.exec();
    const timestamps = results[2][1].map(Number);
    const windowStart = now - windowSeconds * 1000;
    const recent = timestamps.filter(t => t > windowStart);
    return recent.length <= maxCount;
  } else {
    if (!memRateLimits[key]) memRateLimits[key] = [];
    const windowStart = now - windowSeconds * 1000;
    memRateLimits[key] = memRateLimits[key].filter(t => t > windowStart);
    if (memRateLimits[key].length >= maxCount) return false;
    memRateLimits[key].push(now);
    return true;
  }
}

module.exports = {
  db, redis,
  kvSet, kvGet, kvDel, kvKeys,
  saveMessage, getRoomHistory, updateReactions,
  saveDMMessage, getDMHistory,
  flagMessage, logCrisisEvent, getUnreviewedFlags, markFlagReviewed,
  saveMoodCheckin, getRoomMoodAverage,
  checkRateLimit,
};
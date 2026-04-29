/**
 * db.js — Mindspace v3
 * Tier 1: SQLite via better-sqlite3, in-memory fallback
 * Tier 2: FTS5 search, mood trends, mod applications
 * Tier 3: Crisis today, mod applications queue, dashboard stats
 */

const path = require('path');
const fs   = require('fs');

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

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(text, persona, content='messages', content_rowid='rowid');

    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text, persona) VALUES (new.rowid, new.text, new.persona);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text, persona) VALUES('delete', old.rowid, old.text, old.persona);
    END;

    CREATE TABLE IF NOT EXISTS dm_messages (
      id      TEXT PRIMARY KEY,
      dm_key  TEXT NOT NULL,
      persona TEXT NOT NULL,
      text    TEXT NOT NULL,
      ts      INTEGER NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_crisis_ts ON crisis_events(ts);

    CREATE TABLE IF NOT EXISTS moderators (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_hash TEXT UNIQUE NOT NULL,
      socket_id    TEXT,
      granted_ts   INTEGER,
      active       INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS mod_applications (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      persona      TEXT NOT NULL,
      why          TEXT NOT NULL,
      availability TEXT,
      ts           INTEGER NOT NULL,
      reviewed     INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mod_apps_reviewed ON mod_applications(reviewed, ts);

    CREATE TABLE IF NOT EXISTS mood_checkins (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      score   INTEGER NOT NULL,
      ts      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mood_room ON mood_checkins(room_id, ts);
  `);
  console.log('✅ SQLite ready:', DB_PATH);
}

// ── In-memory fallback (Redis or memory) ──────────────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
  try {
    const Redis = require('ioredis');
    redis = new Redis(process.env.REDIS_URL);
    redis.on('connect', () => console.log('✅ Redis connected'));
    redis.on('error',   (e) => console.warn('⚠  Redis error:', e.message));
  } catch(e) { console.warn('⚠  npm install ioredis'); }
}

const memStore = {};
async function kvSet(k, v, ttl) {
  const s = JSON.stringify(v);
  if (redis) { if (ttl) await redis.set(k, s, 'EX', ttl); else await redis.set(k, s); }
  else memStore[k] = { value: v, expires: ttl ? Date.now() + ttl * 1000 : null };
}
async function kvGet(k) {
  if (redis) { const v = await redis.get(k); return v ? JSON.parse(v) : null; }
  const e = memStore[k];
  if (!e) return null;
  if (e.expires && Date.now() > e.expires) { delete memStore[k]; return null; }
  return e.value;
}
async function kvDel(k) {
  if (redis) await redis.del(k);
  else delete memStore[k];
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const memRL = {};
async function checkRateLimit(key, maxCount, windowSecs) {
  const now = Date.now();
  if (redis) {
    const pipe = redis.pipeline();
    pipe.lpush(key, now);
    pipe.ltrim(key, 0, maxCount - 1);
    pipe.lrange(key, 0, -1);
    pipe.expire(key, windowSecs);
    const res = await pipe.exec();
    const ts  = res[2][1].map(Number);
    return ts.filter(t => t > now - windowSecs * 1000).length <= maxCount;
  }
  if (!memRL[key]) memRL[key] = [];
  const win = now - windowSecs * 1000;
  memRL[key] = memRL[key].filter(t => t > win);
  if (memRL[key].length >= maxCount) return false;
  memRL[key].push(now);
  return true;
}

// ── Messages ──────────────────────────────────────────────────────────────────
const MAX_HISTORY = 80;

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
  // Keep only the last MAX_HISTORY messages per room
  db.prepare(`
    DELETE FROM messages
    WHERE room_id = ? AND id NOT IN (
      SELECT id FROM messages WHERE room_id = ? ORDER BY ts DESC LIMIT ?
    )
  `).run(msg.roomId, msg.roomId, MAX_HISTORY);
}

function getRoomHistory(roomId, limit = MAX_HISTORY) {
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
    reactions: JSON.parse(row.reactions || '{}'),
  }));
}

function updateReactions(msgId, reactions) {
  if (!db) return;
  db.prepare(`UPDATE messages SET reactions = ? WHERE id = ?`)
    .run(JSON.stringify(reactions), msgId);
}

// Full-text search over room messages
function searchMessages(roomId, query, limit = 30) {
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT m.id, m.persona, m.text, m.ts, m.is_ai
      FROM messages m
      JOIN messages_fts f ON m.rowid = f.rowid
      WHERE m.room_id = ? AND messages_fts MATCH ?
      ORDER BY m.ts DESC LIMIT ?
    `).all(roomId, query + '*', limit).map(r => ({
      id:     r.id,
      persona: r.persona,
      text:   r.text,
      ts:     r.ts,
      isAI:   r.is_ai === 1,
    }));
  } catch(e) {
    // Fallback to LIKE if FTS fails
    return db.prepare(`
      SELECT id, persona, text, ts, is_ai
      FROM messages
      WHERE room_id = ? AND text LIKE ?
      ORDER BY ts DESC LIMIT ?
    `).all(roomId, `%${query}%`, limit).map(r => ({
      id:      r.id,
      persona: r.persona,
      text:    r.text,
      ts:      r.ts,
      isAI:    r.is_ai === 1,
    }));
  }
}

// ── DMs ───────────────────────────────────────────────────────────────────────
function saveDMMessage(dmKey, msg) {
  if (!db) return;
  db.prepare(`
    INSERT OR REPLACE INTO dm_messages (id, dm_key, persona, text, ts)
    VALUES (?, ?, ?, ?, ?)
  `).run(msg.id, dmKey, msg.persona, msg.text, msg.ts);
}

function getDMHistory(dmKey, limit = 100) {
  if (!db) return [];
  return db.prepare(`
    SELECT * FROM dm_messages WHERE dm_key = ? ORDER BY ts DESC LIMIT ?
  `).all(dmKey, limit).reverse();
}

// ── Moderation ────────────────────────────────────────────────────────────────
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
  return db.prepare(`
    SELECT * FROM flagged_messages WHERE reviewed = 0 ORDER BY ts DESC
  `).all();
}

function markFlagReviewed(id) {
  if (!db) return;
  db.prepare(`UPDATE flagged_messages SET reviewed = 1 WHERE id = ?`).run(id);
}

// ── Mod applications ──────────────────────────────────────────────────────────
function saveModApplication({ persona, why, availability }) {
  if (!db) return;
  db.prepare(`
    INSERT INTO mod_applications (persona, why, availability, ts)
    VALUES (?, ?, ?, ?)
  `).run(persona, why, availability || '', Date.now());
}

function getModApplications(reviewedOnly = false) {
  if (!db) return [];
  try {
    if (reviewedOnly) {
      return db.prepare(`
        SELECT * FROM mod_applications WHERE reviewed = 0 ORDER BY ts DESC LIMIT 50
      `).all();
    }
    return db.prepare(`
      SELECT * FROM mod_applications ORDER BY ts DESC LIMIT 50
    `).all();
  } catch(e) { return []; }
}

function markApplicationReviewed(id) {
  if (!db) return;
  db.prepare(`UPDATE mod_applications SET reviewed = 1 WHERE id = ?`).run(id);
}

// ── Crisis stats ──────────────────────────────────────────────────────────────
function getCrisisToday() {
  if (!db) return 0;
  try {
    const since = Date.now() - 86_400_000;
    return db.prepare(`
      SELECT COUNT(*) as count FROM crisis_events WHERE ts > ?
    `).get(since)?.count || 0;
  } catch(e) { return 0; }
}

function getCrisisHistory(days = 7) {
  if (!db) return [];
  try {
    const since = Date.now() - days * 86_400_000;
    return db.prepare(`
      SELECT room_id, persona, text, confidence, ts
      FROM crisis_events
      WHERE ts > ?
      ORDER BY ts DESC
      LIMIT 100
    `).all(since);
  } catch(e) { return []; }
}

// ── Mood ──────────────────────────────────────────────────────────────────────
function saveMoodCheckin(roomId, score) {
  if (!db) return;
  db.prepare(`
    INSERT INTO mood_checkins (room_id, score, ts) VALUES (?, ?, ?)
  `).run(roomId, score, Date.now());
}

// N-day daily averages for a room
function getMoodTrend(roomId, days = 7) {
  if (!db) return [];
  const since = Date.now() - days * 86_400_000;
  const rows  = db.prepare(`
    SELECT
      CAST(ts / 86400000 AS INTEGER) as day_bucket,
      AVG(score) as avg_score,
      COUNT(*) as count
    FROM mood_checkins
    WHERE room_id = ? AND ts > ?
    GROUP BY day_bucket
    ORDER BY day_bucket ASC
  `).all(roomId, since);
  return rows.map(r => ({
    date:  new Date(r.day_bucket * 86_400_000).toISOString().slice(0, 10),
    avg:   parseFloat(r.avg_score.toFixed(2)),
    count: r.count,
  }));
}

function getRoomMoodAverage(roomId, withinMs = 3_600_000) {
  if (!db) return null;
  const row = db.prepare(`
    SELECT AVG(score) as avg, COUNT(*) as cnt
    FROM mood_checkins
    WHERE room_id = ? AND ts > ?
  `).get(roomId, Date.now() - withinMs);
  return row?.cnt > 0 ? { avg: parseFloat(row.avg.toFixed(1)), count: row.cnt } : null;
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  db,
  redis,

  // KV store
  kvSet,
  kvGet,
  kvDel,

  // Rate limiting
  checkRateLimit,

  // Messages
  saveMessage,
  getRoomHistory,
  updateReactions,
  searchMessages,

  // DMs
  saveDMMessage,
  getDMHistory,

  // Moderation
  flagMessage,
  logCrisisEvent,
  getUnreviewedFlags,
  markFlagReviewed,

  // Mod applications
  saveModApplication,
  getModApplications,
  markApplicationReviewed,

  // Crisis stats
  getCrisisToday,
  getCrisisHistory,

  // Mood
  saveMoodCheckin,
  getMoodTrend,
  getRoomMoodAverage,
};
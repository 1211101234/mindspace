/**
 * moderator.js — Crisis detection, content moderation, and mod tools
 */

// ── Crisis patterns (EN + BM) ─────────────────────────────────────────────────
const CRISIS_HIGH = [
  // English
  /\bsuicid(e|al|ing)\b/i,
  /\bkill\s*(my|me)?\s*self\b/i,
  /\bend\s*(my\s*)?(life|it\s*all)\b/i,
  /\bwant\s*to\s*die\b/i,
  /\bno\s*(point|reason)\s*(in\s*)?(living|life|going on)\b/i,
  /\boverdos(e|ing)\b/i,
  /\bcut\s*(my|me)?\s*self\b/i,
  /\bself.?harm\b/i,
  /\b(hanging|hang)\s*my\s*self\b/i,
  /\bjump\s*(off|from)\b/i,
  // Bahasa Malaysia
  /\bbunuh\s*diri\b/i,
  /\bnk\s*mati\b/i,
  /\bnaknak\s*mati\b/i,
  /\btidak\s*nak\s*hidup\b/i,
  /\btk\s*nak\s*hidup\b/i,
  /\bnak\s*mati\b/i,
  /\bhidup\s*dah\s*takde\s*makna\b/i,
  /\bletak\s*nyawa\b/i,
  /\btamat\s*hidup\b/i,
  /\bmati\s*je\s*(la|lah)\b/i,
];

const CRISIS_MEDIUM = [
  /\bcan'?t\s*(go on|cope|take it)\b/i,
  /\bgive\s*up\s*(on\s*)?(life|everything|living)?\b/i,
  /\bno\s*one\s*(cares?|would miss)\b/i,
  /\bbetter\s*off\s*(dead|without me)\b/i,
  /\bhopeless\b/i,
  /\bworthless\b/i,
  /\bdisappear\s*forever\b/i,
  /\bnever\s*wake\s*up\b/i,
  /\bmassive\s*pain\b/i,
  /\btiada\s*harapan\b/i,
  /\btidak\s*berguna\b/i,
  /\btk\s*ada\s*guna\b/i,
  /\bserik\s*hidup\b/i,
  /\bpenat\s*(sangat\s*)?(hidup|dengan hidup)\b/i,
  /\blelah\s*(dengan\s*)?(hidup|kehidupan)\b/i,
];

// Confidence levels
const CONFIDENCE = { HIGH: 'high', MEDIUM: 'medium', NONE: 'none' };

function detectCrisis(text) {
  if (!text) return { level: CONFIDENCE.NONE };
  if (CRISIS_HIGH.some(p => p.test(text)))   return { level: CONFIDENCE.HIGH };
  if (CRISIS_MEDIUM.some(p => p.test(text))) return { level: CONFIDENCE.MEDIUM };
  return { level: CONFIDENCE.NONE };
}

// ── Spam / abuse detection ────────────────────────────────────────────────────
const SPAM_PATTERNS = [
  /(.)\1{9,}/,          // 10+ repeated characters
  /https?:\/\/\S+/gi,   // URLs (flag, not block)
  /\b(fuck|shit|cunt|bitch|nigger|faggot)\b/gi,
];

function checkContent(text) {
  const flags = [];
  if (!text) return flags;
  if (SPAM_PATTERNS[0].test(text))    flags.push('spam:repeated_chars');
  if (SPAM_PATTERNS[1].test(text))    flags.push('contains_url');
  if (SPAM_PATTERNS[2].test(text))    flags.push('profanity');
  return flags;
}

// ── Mod permission store (in-memory, backed by DB via server.js) ──────────────
const activeMods = new Set(); // Set of socket IDs that are active moderators

function grantMod(socketId) { activeMods.add(socketId); }
function revokeMod(socketId) { activeMods.delete(socketId); }
function isMod(socketId)     { return activeMods.has(socketId); }

// Mod secret — set via MOD_SECRET env var or generated on startup
const MOD_SECRET = process.env.MOD_SECRET || Math.random().toString(36).slice(2);
if (!process.env.MOD_SECRET) {
  console.log('🔑 Mod secret (set MOD_SECRET env to persist):', MOD_SECRET);
}

function verifyModSecret(secret) { return secret === MOD_SECRET; }

// ── AI system prompts per context ─────────────────────────────────────────────
function buildSystemPrompt(context) {
  const base = `You are Sage, a gentle AI presence in Mindspace — an anonymous, judgment-free mental health support community. You are NOT a therapist or medical professional.

Core principles:
- Validate feelings before anything else
- Be warm, human, and present — never clinical or robotic
- Keep responses SHORT (60–100 words) — this is a chat, not a session
- Never diagnose, prescribe, or give specific medical advice
- Use natural language — no bullet points, no lists
- If the conversation is flowing well, stay quiet (respond PASS)
- Always prioritise human connection over AI response`;

  const contexts = {
    room: `${base}

Context: You are in a group support room. Multiple people may be present. Respond only when genuinely helpful.`,

    crisis_high: `You are Sage in Mindspace. Someone has shared something that strongly suggests they may be in crisis.

Respond with deep warmth and no panic. Acknowledge their pain directly. Gently share these resources:
- Malaysia: Befrienders KL: 03-7627 2929 (24h)
- Malaysia: MIASA: 03-7732 2414
- International: Crisis Text Line: Text HOME to 741741
- Emergency: 999 (MY) / 112 (International)

Say something human first. Then mention one resource naturally. Under 120 words. Never minimise what they've shared.`,

    crisis_medium: `${base}

Someone has shared something that sounds heavy and possibly hopeless. Respond with extra warmth. Validate their pain. Gently ask if they're okay or if they'd like to talk more. Mention that support is available if they need it. Under 100 words.`,

    private: `${base}

Context: You are in a private 1-on-1 conversation with a single user. You can be slightly more personal and extended in your responses (up to 150 words). Remember previous messages in this conversation.`,

    mood: `You are Sage. A user just completed a mood check-in. Respond warmly and briefly (40-60 words) to their mood score. Be specific to their score — don't be generic. For low scores (1-2): extra warmth, validation, ask gently what's going on. For mid scores (3): acknowledge it's okay to be in the middle. For high scores (4-5): celebrate gently. Never be saccharine.`,
  };

  return contexts[context] || contexts.room;
}

module.exports = {
  detectCrisis, CONFIDENCE,
  checkContent,
  grantMod, revokeMod, isMod, verifyModSecret, MOD_SECRET,
  buildSystemPrompt,
};
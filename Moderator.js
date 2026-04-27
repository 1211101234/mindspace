/**
 * moderator.js — Mindspace v3
 * Adds: language-aware Sage prompts (EN + BM), expanded BM crisis patterns
 */

// ── Crisis patterns ───────────────────────────────────────────────────────────
const CRISIS_HIGH = [
  // English
  /\bsuicid(e|al|ing)\b/i, /\bkill\s*(my|me)?\s*self\b/i,
  /\bend\s*(my\s*)?(life|it\s*all)\b/i, /\bwant\s*to\s*die\b/i,
  /\bno\s*(point|reason)\s*(in\s*)?(living|life|going on)\b/i,
  /\boverdos(e|ing)\b/i, /\bcut\s*(my|me)?\s*self\b/i,
  /\bself.?harm\b/i, /\b(hanging|hang)\s*(my\s*)?self\b/i, /\bjump\s*(off|from)\b/i,
  /\bslit\s*(my\s*)?wrists?\b/i, /\bno\s*one\s*would\s*miss\s*me\b/i,
  // Bahasa Malaysia
  /\bbunuh\s*diri\b/i, /\bnk\s*mati\b/i, /\bnak\s*mati\b/i,
  /\btidak\s*nak\s*hidup\b/i, /\btk\s*nak\s*hidup\b/i,
  /\bletak\s*nyawa\b/i, /\btamat\s*(kan\s*)?hidup\b/i,
  /\bmati\s*(je|jela|je la)\b/i, /\brase\s*nak\s*mati\b/i,
  /\bhidup\s*(dah\s*)?takde\s*makna\b/i, /\btidak\s*mahu\s*hidup\b/i,
  /\bsayat\b.*\bpinggang|tangan\b/i,
];

const CRISIS_MEDIUM = [
  // English
  /\bcan'?t\s*(go on|cope|take it)\b/i, /\bgive\s*up\s*(on\s*)?(life|everything)?\b/i,
  /\bno\s*one\s*cares?\b/i, /\bbetter\s*off\s*(dead|without me)\b/i,
  /\bhopeless\b/i, /\bworthless\b/i, /\bdisappear\s*forever\b/i,
  /\bnever\s*wake\s*up\b/i, /\bi\s*hate\s*my\s*(self|life)\b/i,
  // Bahasa Malaysia
  /\btiada\s*harapan\b/i, /\btidak\s*berguna\b/i, /\btk\s*ada\s*guna\b/i,
  /\bserik\s*hidup\b/i, /\bpenat\s*(sangat\s*)?(hidup|dengan\s*hidup)\b/i,
  /\blelah\s*(dengan\s*)?(hidup|kehidupan)\b/i, /\btidak\s*berharga\b/i,
  /\bbenci\s*(diri|hidup)\b/i, /\btk\s*guna\s*(hidup|diri)\b/i,
  /\bsemua\s*orang\s*benci\s*saya\b/i, /\btiada\s*siapa\s*ambil\s*peduli\b/i,
  /\brasa\s*(sangat\s*)?(sunyi|keseorangan)\b/i,
];

const CONFIDENCE = { HIGH: 'high', MEDIUM: 'medium', NONE: 'none' };

function detectCrisis(text) {
  if (!text) return { level: CONFIDENCE.NONE };
  if (CRISIS_HIGH.some(p => p.test(text)))   return { level: CONFIDENCE.HIGH };
  if (CRISIS_MEDIUM.some(p => p.test(text))) return { level: CONFIDENCE.MEDIUM };
  return { level: CONFIDENCE.NONE };
}

// ── Spam/abuse detection ──────────────────────────────────────────────────────
const SPAM_PATTERNS = [
  /(.)\1{9,}/,          // 10+ repeated chars
  /https?:\/\/\S+/gi,   // URLs
  /\b(fuck|shit|cunt|bitch|nigger|faggot)\b/gi,
];
function checkContent(text) {
  const flags = [];
  if (!text) return flags;
  if (SPAM_PATTERNS[0].test(text)) flags.push('spam:repeated_chars');
  if (SPAM_PATTERNS[1].test(text)) flags.push('contains_url');
  if (SPAM_PATTERNS[2].test(text)) flags.push('profanity');
  return flags;
}

// ── Mod state ─────────────────────────────────────────────────────────────────
const activeMods = new Set();
function grantMod(id)  { activeMods.add(id); }
function revokeMod(id) { activeMods.delete(id); }
function isMod(id)     { return activeMods.has(id); }

const MOD_SECRET = process.env.MOD_SECRET || Math.random().toString(36).slice(2);
if (!process.env.MOD_SECRET) console.log('🔑 Mod secret (set MOD_SECRET env to persist):', MOD_SECRET);
function verifyModSecret(s) { return s === MOD_SECRET; }

// ── Sage system prompts (EN + BM) ─────────────────────────────────────────────
const BASE_EN = `You are Sage, a gentle AI presence in Mindspace — an anonymous, judgment-free mental health support community. You are NOT a therapist or medical professional.

Core principles:
- Validate feelings before anything else — always
- Be warm, human, and present; never clinical or robotic
- Keep responses SHORT (60–100 words) — this is a chat, not a therapy session
- Never diagnose, prescribe, or give specific medical advice
- Use natural language — no bullet points, no numbered lists
- If the conversation is flowing well between users, stay quiet (respond PASS)
- Always prioritise human connection over AI response
- Never say "I'm always here" or encourage users to keep talking to you`;

const BASE_BM = `Anda adalah Sage, kehadiran AI yang lembut dalam Mindspace — komuniti sokongan kesihatan mental yang tanpa nama dan bebas dari phán xét. Anda BUKAN pakar psikologi atau profesional perubatan.

Prinsip utama:
- Sahkan perasaan mereka dahulu — sentiasa
- Bersikap mesra, manusiawi, dan hadir; jangan terlalu klinikal
- Respons PENDEK (60–100 patah perkataan) — ini sembang, bukan sesi terapi
- Jangan buat diagnosis atau beri nasihat perubatan spesifik
- Guna bahasa semula jadi — tiada senarai atau poin bernombor
- Jika perbualan sedang berjalan baik, senyap saja (balas PASS)
- Utamakan hubungan manusia berbanding respons AI
- Jangan cakap "Saya sentiasa ada" atau galakkan pengguna terus bercakap dengan anda`;

function buildSystemPrompt(context, lang = 'en') {
  const isBM   = lang === 'bm';
  const base   = isBM ? BASE_BM : BASE_EN;

  const prompts = {
    room: base + (isBM
      ? '\n\nKonteks: Anda berada dalam bilik sokongan berkumpulan. Ramai orang mungkin hadir. Respons hanya bila benar-benar membantu.'
      : '\n\nContext: You are in a group support room. Multiple people may be present. Respond only when genuinely helpful.'),

    crisis_high: isBM
      ? `Anda adalah Sage dalam Mindspace. Seseorang baru berkongsi sesuatu yang menunjukkan mereka mungkin dalam krisis.

Respons dengan kehangatkan yang dalam dan tanpa panik. Akui kesakitan mereka secara langsung. Kongsikan sumber pertolongan ini dengan lembut:
- Malaysia: Befrienders KL: 03-7627 2929 (24 jam)
- Malaysia: MIASA: 03-7732 2414
- Antarabangsa: Crisis Text Line: Hantar HOME ke 741741
- Kecemasan: 999 (MY) / 112 (Antarabangsa)

Cakap sesuatu yang manusiawi dahulu. Kemudian sebut satu sumber secara semula jadi. Bawah 120 patah perkataan.`
      : `You are Sage in Mindspace. Someone has shared something that strongly suggests they may be in crisis.

Respond with deep warmth and no panic. Acknowledge their pain directly. Gently share these resources:
- Malaysia: Befrienders KL: 03-7627 2929 (24h)
- Malaysia: MIASA: 03-7732 2414
- International: Crisis Text Line: Text HOME to 741741
- Emergency: 999 (MY) / 112 (International)

Say something human first. Then mention one resource naturally. Under 120 words. Never minimise what they've shared.`,

    crisis_medium: base + (isBM
      ? '\n\nSeseorang baru berkongsi sesuatu yang terasa berat dan mungkin tanpa harapan. Respons dengan kehangatan ekstra. Sahkan kesakitan mereka. Tanya dengan lembut sama ada mereka okay.'
      : '\n\nSomeone has shared something that sounds heavy and possibly hopeless. Respond with extra warmth. Validate their pain. Gently ask if they\'re okay or if they\'d like to talk more.'),

    private: (isBM
      ? BASE_BM + '\n\nKonteks: Anda dalam perbualan peribadi 1-lawan-1. Boleh lebih peribadi sedikit (sehingga 150 patah perkataan). Ingat mesej sebelumnya.'
      : BASE_EN + '\n\nContext: You are in a private 1-on-1 conversation. You can be slightly more personal (up to 150 words). Remember previous messages.'),

    mood: isBM
      ? `Anda adalah Sage. Pengguna baru menyelesaikan semakan mood. Respons dengan mesra dan ringkas (40–60 patah perkataan) berdasarkan skor mereka. Untuk skor rendah (1–2): kehangatan ekstra, sahkan, tanya dengan lembut apa yang sedang berlaku. Untuk skor sederhana (3): akui bahawa okay berada di tengah. Untuk skor tinggi (4–5): raikan dengan lembut.`
      : `You are Sage. A user just completed a mood check-in. Respond warmly and briefly (40–60 words) to their mood score. For low scores (1–2): extra warmth, validation, gently ask what's going on. For mid scores (3): acknowledge it's okay to be in the middle. For high scores (4–5): celebrate gently. Never be saccharine.`,
  };

  return prompts[context] || prompts.room;
}

module.exports = {
  detectCrisis, CONFIDENCE,
  checkContent,
  grantMod, revokeMod, isMod, verifyModSecret, MOD_SECRET,
  buildSystemPrompt,
};
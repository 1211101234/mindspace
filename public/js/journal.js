// ── journal.js ────────────────────────────────────────────────────────────────
// Client-side encrypted private journal using AES-GCM + PBKDF2.
// All crypto is browser-side only — nothing is ever sent to the server.

const JOURNAL_STORE = 'mindspace-journal-enc';
const JOURNAL_SALT  = 'mindspace-journal-salt-v1';

let journalKey      = null;   // CryptoKey — null means locked
let journalEntries  = [];     // [{ id, ts, plaintext }]
let currentEntryId  = null;
let journalSaveTimer = null;

// ── Crypto ────────────────────────────────────────────────────────────────────

async function deriveKey(passphrase) {
  const enc = new TextEncoder();
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(passphrase || JOURNAL_SALT), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(JOURNAL_SALT), iterations: 200_000, hash: 'SHA-256' },
    keyMat,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptEntries(entries, key) {
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(entries));
  const enc  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: Array.from(iv), enc: Array.from(new Uint8Array(enc)) };
}

async function decryptEntries(stored, key) {
  const iv  = new Uint8Array(stored.iv);
  const enc = new Uint8Array(stored.enc);
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, enc);
  return JSON.parse(new TextDecoder().decode(dec));
}

// ── Lock / unlock ─────────────────────────────────────────────────────────────

async function unlockJournal() {
  const pass  = document.getElementById('journal-pass').value;
  const errEl = document.getElementById('journal-unlock-err');
  errEl.style.display = 'none';
  try {
    journalKey = await deriveKey(pass);
    const stored = localStorage.getItem(JOURNAL_STORE);
    if (stored) {
      try {
        journalEntries = await decryptEntries(JSON.parse(stored), journalKey);
      } catch (e) {
        errEl.style.display = 'block';
        journalKey = null;
        return;
      }
    } else {
      journalEntries = [];
    }
    document.getElementById('journal-lock').style.display = 'none';
    document.getElementById('journal-main').classList.add('visible');
    renderJournalList();
    if (journalEntries.length === 0) journalNewEntry();
  } catch (e) {
    errEl.textContent = 'Something went wrong — try again.';
    errEl.style.display = 'block';
  }
}

function lockJournal() {
  journalKey     = null;
  journalEntries = [];
  currentEntryId = null;
  document.getElementById('journal-lock').style.display = 'block';
  document.getElementById('journal-main').classList.remove('visible');
  document.getElementById('journal-pass').value = '';
  document.getElementById('journal-unlock-err').style.display = 'none';
}

document.getElementById('journal-pass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') unlockJournal();
});

// ── Persist ───────────────────────────────────────────────────────────────────

async function journalPersist() {
  if (!journalKey) return;
  try {
    const enc = await encryptEntries(journalEntries, journalKey);
    localStorage.setItem(JOURNAL_STORE, JSON.stringify(enc));
    const status = document.getElementById('journal-save-status');
    if (status) { status.textContent = 'Saved ✓'; setTimeout(() => { status.textContent = ''; }, 2000); }
  } catch (e) {
    const status = document.getElementById('journal-save-status');
    if (status) status.textContent = 'Save failed';
  }
}

// ── List & editor ─────────────────────────────────────────────────────────────

function renderJournalList(filter = '') {
  const list = document.getElementById('journal-list');
  const entries = filter
    ? journalEntries.filter((e) => e.plaintext.toLowerCase().includes(filter.toLowerCase()))
    : journalEntries;
  list.innerHTML = '';
  if (!entries.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:12px 8px;text-align:center">No entries yet</div>';
    return;
  }
  [...entries].sort((a, b) => b.ts - a.ts).forEach((entry) => {
    const div = document.createElement('div');
    div.className = 'journal-entry-item' + (entry.id === currentEntryId ? ' active' : '');
    div.setAttribute('role', 'listitem');
    div.innerHTML = `<div class="jei-date">${new Date(entry.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}</div><div class="jei-preview">${esc(entry.plaintext.slice(0, 60) || 'Empty entry')}</div>`;
    div.onclick = () => journalOpenEntry(entry.id);
    list.appendChild(div);
  });
}

function journalOpenEntry(id) {
  const entry = journalEntries.find((e) => e.id === id);
  if (!entry) return;
  currentEntryId = id;
  document.getElementById('journal-textarea').value = entry.plaintext;
  document.getElementById('journal-current-date').textContent = new Date(entry.ts).toLocaleString([], {
    month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  renderJournalList();
}

function journalNewEntry() {
  const entry = { id: Date.now().toString(36), ts: Date.now(), plaintext: '' };
  journalEntries.unshift(entry);
  journalOpenEntry(entry.id);
  document.getElementById('journal-textarea').focus();
}

function journalAutoSave() {
  if (!currentEntryId) return;
  const entry = journalEntries.find((e) => e.id === currentEntryId);
  if (entry) {
    entry.plaintext = document.getElementById('journal-textarea').value;
    entry.ts = Date.now();
  }
  renderJournalList();
  clearTimeout(journalSaveTimer);
  journalSaveTimer = setTimeout(journalPersist, 1500);
}

function journalSave() {
  journalAutoSave();
  clearTimeout(journalSaveTimer);
  journalPersist();
}

function journalDeleteEntry() {
  if (!currentEntryId) return;
  if (!confirm('Delete this entry? This cannot be undone.')) return;
  journalEntries = journalEntries.filter((e) => e.id !== currentEntryId);
  currentEntryId = null;
  document.getElementById('journal-textarea').value = '';
  document.getElementById('journal-current-date').textContent = '—';
  journalPersist();
  renderJournalList();
  if (journalEntries.length === 0) journalNewEntry();
  else journalOpenEntry(journalEntries[0].id);
}

function journalSearch(q) {
  renderJournalList(q);
}
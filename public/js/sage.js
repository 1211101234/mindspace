// ── sage.js ───────────────────────────────────────────────────────────────────
// Sage private AI panel and persistent memory.

// ── Memory ────────────────────────────────────────────────────────────────────

const MEMORY_KEY = 'mindspace-sage-memory';

function getSageMemory() {
  try { return JSON.parse(localStorage.getItem(MEMORY_KEY) || '[]'); }
  catch (e) { return []; }
}

function addSageMemory(entry) {
  if (!prefs.memory) return;
  const mem = getSageMemory();
  mem.push({ ts: Date.now(), text: entry.slice(0, 200) });
  while (mem.length > 20) mem.shift();
  localStorage.setItem(MEMORY_KEY, JSON.stringify(mem));
}

function buildMemoryContext() {
  if (!prefs.memory) return '';
  const mem = getSageMemory();
  if (!mem.length) return '';
  const lines = mem.map((m) => `- ${m.text}`).join('\n');
  return `\n\n[User memory — things they've shared before]:\n${lines}\n[Reference naturally if relevant, don't recite the list]`;
}

function showMemorySummary() {
  const mem = getSageMemory();
  const summary = document.getElementById('memory-summary');
  const clearBtn = document.getElementById('memory-clear-btn');
  if (!prefs.memory) {
    if (summary) summary.style.display = 'none';
    if (clearBtn) clearBtn.style.display = 'none';
    return;
  }
  if (mem.length === 0) {
    if (summary) { summary.style.display = 'block'; summary.innerHTML = '<div style="font-size:12px;color:var(--muted)">No memories yet — start a Sage session to begin.</div>'; }
    if (clearBtn) clearBtn.style.display = 'none';
  } else {
    if (summary) {
      summary.style.display = 'block';
      summary.innerHTML = `<div style="font-size:12px;color:var(--text2);background:var(--sage-ai-bg);border-radius:8px;padding:10px 12px;border:1px solid rgba(107,158,138,.2)">${mem.length} memory fragment${mem.length > 1 ? 's' : ''} stored · Most recent: <em>${esc(mem[mem.length - 1].text.slice(0, 60))}…</em></div>`;
    }
    if (clearBtn) clearBtn.style.display = 'block';
  }
}

function clearSageMemory() {
  if (!confirm('Clear all Sage memories? This cannot be undone.')) return;
  localStorage.removeItem(MEMORY_KEY);
  showMemorySummary();
  updateSageMemoryBadge();
  showToast('Sage memory cleared 🌿');
}

function updateSageMemoryBadge() {
  const badge = document.getElementById('sage-memory-badge');
  if (badge) badge.style.display = prefs.memory ? 'inline-block' : 'none';
}

// ── Panel ─────────────────────────────────────────────────────────────────────

function openSagePanel() {
  socket.emit('sage start');
  document.getElementById('sage-panel').classList.add('open');
  closeSidebar();
  updateSageMemoryBadge();
  if (prefs.memory) {
    const ctx = buildMemoryContext();
    if (ctx) socket.emit('sage memory context', ctx);
  }
}

function closeSagePanel() {
  socket.emit('sage end');
  document.getElementById('sage-panel').classList.remove('open');
}

function sendSageMessage() {
  const input = document.getElementById('sage-msg-input');
  const text = input.value.trim();
  if (!text) return;
  if (prefs.memory) addSageMemory(text);
  socket.emit('sage message', text);
  input.value = '';
  input.focus();
}

document.getElementById('sage-msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendSageMessage(); }
});

// ── Render ────────────────────────────────────────────────────────────────────

function renderSageMsg(msg) {
  const el = document.getElementById('sage-messages');
  const div = document.createElement('div');
  const isUser = msg.isUser || msg.persona !== 'Sage';
  div.className = `msg ${isUser ? 'me' : 'ai-msg'}`;
  div.setAttribute('role', 'article');
  div.innerHTML = `
    <div class="msg-meta">
      <span class="persona-name">${isUser ? esc(myPersona) : '🌿 Sage'}</span>
      ${!isUser ? '<span class="ai-label">guide</span>' : ''}
      <span style="font-size:10px;color:var(--muted)">${fmtTime(msg.ts || Date.now())}</span>
    </div>
    <div class="msg-bubble">${esc(msg.text)}</div>
  `;
  el.appendChild(div);
}

function showSageTyping() {
  const el = document.getElementById('sage-messages');
  if (el.querySelector('.sage-typing')) return;
  const div = document.createElement('div');
  div.className = 'sage-typing';
  div.innerHTML = `<span>Sage is reflecting</span><div class="typing-dots" aria-label="typing"><span></span><span></span><span></span></div>`;
  el.appendChild(div);
  scrollBottom('sage-messages');
}

function removeSageTyping() {
  const t = document.getElementById('sage-messages').querySelector('.sage-typing');
  if (t) t.remove();
}

// Share a journal entry into Sage
function journalShareWithSage() {
  const entry = journalEntries.find((e) => e.id === currentEntryId);
  if (!entry || !entry.plaintext.trim()) { showToast('Nothing to share — write something first.'); return; }
  closePanel('journal-panel');
  openSagePanel();
  setTimeout(() => {
    const input = document.getElementById('sage-msg-input');
    input.value = `I wanted to share something from my journal: "${entry.plaintext.slice(0, 400)}"`;
    input.focus();
    showToast('Journal entry loaded — send when ready 🌿');
  }, 300);
}

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('sage session open', ({ history }) => {
  const msgs = document.getElementById('sage-messages');
  const intro = msgs.querySelector('.sage-intro');
  msgs.innerHTML = '';
  if (intro) msgs.appendChild(intro);
  if (history) history.forEach((m) => renderSageMsg(m));
  scrollBottom('sage-messages');
});

socket.on('sage user message', (msg) => {
  removeSageTyping();
  renderSageMsg(msg);
  scrollBottom('sage-messages');
  showSageTyping();
});

socket.on('sage reply', (msg) => {
  removeSageTyping();
  renderSageMsg(msg);
  scrollBottom('sage-messages');
  if (prefs.memory && msg.text && msg.text.length > 40) {
    addSageMemory(`Sage noted: ${msg.text.slice(0, 160)}`);
  }
});

socket.on('sage session closed', () => {});

socket.on('sage private', ({ text }) => {
  showToast(`🌿 Sage: ${text}`, 8000);
});
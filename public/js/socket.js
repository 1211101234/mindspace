// ── socket.js ─────────────────────────────────────────────────────────────────
// Socket.IO connection, shared state, and all core socket event handlers.

const socket = io();

// ── Shared state (read by all modules) ───────────────────────────────────────
let myPersona    = '';
let currentRoom  = null;
let availableRooms = [];
let lastSender   = '';
let lastSenderTs = 0;
let replyToMsg   = null;   // { id, persona, text }
let slowModeSecs = 0;
let lastMsgTs    = 0;
const ROOM_META  = {};
const typingUsers = {};

// ── assigned ──────────────────────────────────────────────────────────────────

socket.on('assigned', ({ persona, rooms }) => {
  myPersona      = persona;
  availableRooms = rooms;
  document.getElementById('persona-display').textContent = persona;
  document.getElementById('my-persona-tag').textContent  = persona;
  rooms.forEach((r) => { ROOM_META[r.id] = r; });
  renderLandingRooms(rooms);
  // Re-apply language pref if BM is on
  if (prefs.bm) applyUILang('bm');
});

// ── Room events ───────────────────────────────────────────────────────────────

socket.on('room history', ({ messages }) => {
  const el = document.getElementById('messages');
  el.innerHTML = '';
  lastSender   = '';
  lastSenderTs = 0;
  if (messages.length) {
    addHistoryMarker(`${messages.length} earlier messages`);
    messages.forEach((m) => renderMsg(m));
  }
  scrollBottom('messages');
});

socket.on('room message', (msg) => {
  removeTypingIndicator(msg.persona);
  renderMsg(msg);
  scrollBottom('messages');
  if (msg.persona !== myPersona) {
    playChime('message');
    if (!msg.isAI) sendBrowserNotif(`#${currentRoom}`, `${msg.persona}: ${msg.text.slice(0, 80)}`);
  }
});

socket.on('notification', ({ type, text }) => {
  lastSender = '';
  const div  = document.createElement('div');
  div.className = `notif ${type}`;
  div.textContent = text;
  document.getElementById('messages').appendChild(div);
  scrollBottom('messages');
});

socket.on('presence', (users) => {
  const list = document.getElementById('presence-list');
  list.innerHTML = '';
  users.forEach((u) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'listitem');
    if (u.persona === myPersona) li.classList.add('me');
    const modMark = u.isMod ? ' <span style="font-size:10px;color:var(--accent)">🛡</span>' : '';
    li.innerHTML = `
      <span class="p-name">
        <span class="p-dot" aria-hidden="true"></span>
        ${esc(u.persona)}
        ${u.persona === myPersona ? '<span style="color:var(--muted);font-size:10px" aria-label="you">(you)</span>' : ''}
        ${modMark}
      </span>
      ${u.persona !== myPersona
        ? `<button class="dm-btn" onclick="requestDM('${u.id}')" aria-label="Send private message to ${esc(u.persona)}">DM</button>`
        : ''}
    `;
    list.appendChild(li);
  });
});

socket.on('rate limited', ({ message }) => {
  showToast(message);
});

socket.on('reaction update', ({ msgId, reactions }) => {
  const el = document.querySelector(`.msg[data-msg-id="${msgId}"] .msg-reactions`);
  if (el) renderReactions(el, msgId, reactions);
});

socket.on('slow mode', ({ seconds }) => {
  slowModeSecs = seconds || 0;
  const badge  = document.getElementById('slow-mode-badge');
  badge.classList.toggle('visible', slowModeSecs > 0);
});

socket.on('pinned message', ({ text, persona }) => {
  document.getElementById('pinned-text').textContent = `${persona}: ${text}`;
  document.getElementById('pinned-bar').classList.add('show');
});

socket.on('report ack', () => {
  showToast('Report submitted. Thank you for helping keep this space safe.');
});

// ── Typing ────────────────────────────────────────────────────────────────────

socket.on('typing', ({ persona }) => {
  if (persona === myPersona) return;
  showTypingIndicator(persona);
  if (typingUsers[persona]) clearTimeout(typingUsers[persona]);
  typingUsers[persona] = setTimeout(() => removeTypingIndicator(persona), 3500);
});

// ── Daily prompt ──────────────────────────────────────────────────────────────

socket.on('daily prompt', ({ text }) => {
  const bar = document.getElementById('daily-prompt-bar');
  document.getElementById('dp-text').textContent = text;
  if (!sessionStorage.getItem('dp-dismissed')) bar.classList.add('show');
});

function dismissDailyPrompt() {
  document.getElementById('daily-prompt-bar').classList.remove('show');
  sessionStorage.setItem('dp-dismissed', '1');
}

// ── Session expiry ────────────────────────────────────────────────────────────

socket.on('session expiring', ({ message }) => {
  const b = document.getElementById('session-banner');
  document.getElementById('session-banner-msg').textContent = message;
  b.classList.add('show');
  setTimeout(() => b.classList.remove('show'), 8000);
});

function dismissSessionBanner() {
  document.getElementById('session-banner').classList.remove('show');
  if (currentRoom) socket.emit('join room', currentRoom);
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd+F → search
  if ((e.ctrlKey || e.metaKey) && e.key === 'f' && document.getElementById('app').classList.contains('visible')) {
    const inInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName);
    if (!inInput) { e.preventDefault(); toggleSearch(); }
  }
  // Ctrl+Shift+M → mod auth
  if (e.ctrlKey && e.shiftKey && e.key === 'M') {
    const secret = prompt('Moderator secret:');
    if (secret) socket.emit('mod auth', secret);
  }
});

// ── PWA service worker ────────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW registration failed:', e));
  });
}
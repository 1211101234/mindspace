// ── messages.js ───────────────────────────────────────────────────────────────
// Message rendering, reactions, replies, reporting, search, and typing indicators.

const REACTIONS = ['❤️', '🤗', '👍', '🕯️', '🌿'];

// ── Render message ────────────────────────────────────────────────────────────

function renderMsg(msg, container = 'messages') {
  const el = document.getElementById(container);
  const isMe = msg.persona === myPersona;
  const isAI = msg.isAI;
  const ts = msg.ts || Date.now();
  const sameU = !isAI && msg.persona === lastSender && ts - lastSenderTs < 60000;
  const div = document.createElement('div');

  let cls = isAI ? 'msg ai-msg' : `msg ${isMe ? 'me' : 'other'}`;
  if (sameU) cls += ' consecutive';
  div.className = cls;
  div.dataset.msgId = msg.id;
  div.setAttribute('role', 'article');
  div.setAttribute('aria-label', `${msg.persona}: ${msg.text}`);

  const replyHTML = msg.parentId ? `<div class="reply-quote">↩ reply</div>` : '';

  const reactBtns = REACTIONS.map(
    (e) => `<button onclick="sendReaction('${msg.id}','${e}')" aria-label="React with ${e}" title="${e}">${e}</button>`
  ).join('');
  const reactBar = !isAI ? `<div class="react-bar" aria-label="React to message">${reactBtns}</div>` : '';

  const metaHTML = `<div class="msg-meta">
    <span class="persona-name">${isAI ? '🌿 Sage' : esc(msg.persona)}</span>
    ${isAI ? '<span class="ai-label">guide</span>' : ''}
    <span style="font-size:10px;color:var(--muted)">${fmtTime(ts)}</span>
  </div>`;

  const actionsHTML = !isAI
    ? `<div class="msg-actions">
        <button class="reply-btn" onclick="setReply('${msg.id}','${esc(msg.persona)}','${esc(msg.text.slice(0, 60))}')" aria-label="Reply to ${esc(msg.persona)}">↩ reply</button>
        ${!isMe ? `<button class="report-btn" onclick="openReport('${msg.id}','${esc(msg.text.slice(0, 60))}')" aria-label="Report message">⚑ report</button>` : ''}
      </div>`
    : '';

  div.innerHTML = `
    ${metaHTML}
    ${replyHTML}
    <div class="msg-bubble">${reactBar}${esc(msg.text)}</div>
    <div class="msg-reactions" data-msg-id="${msg.id}"></div>
    ${actionsHTML}
  `;

  el.appendChild(div);

  if (msg.reactions && Object.keys(msg.reactions).length > 0) {
    renderReactions(div.querySelector('.msg-reactions'), msg.id, msg.reactions);
  }

  if (!isAI) {
    lastSender = msg.persona;
    lastSenderTs = ts;
  } else {
    lastSender = '';
  }
}

function renderReactions(container, msgId, reactions) {
  container.innerHTML = '';
  Object.entries(reactions).forEach(([emoji, users]) => {
    if (!users || users.length === 0) return;
    const pill = document.createElement('button');
    pill.className = 'reaction-pill' + (users.includes(myPersona) ? ' mine' : '');
    pill.setAttribute('aria-label', `${emoji} ${users.length} reaction${users.length > 1 ? 's' : ''}`);
    pill.innerHTML = `${emoji} <span class="r-count">${users.length}</span>`;
    pill.onclick = () => sendReaction(msgId, emoji);
    container.appendChild(pill);
  });
}

function addHistoryMarker(text) {
  const div = document.createElement('div');
  div.className = 'history-marker';
  div.textContent = text;
  document.getElementById('messages').appendChild(div);
}

// ── Reply ─────────────────────────────────────────────────────────────────────

function setReply(id, persona, text) {
  replyToMsg = { id, persona, text };
  document.getElementById('reply-preview').textContent = `${persona}: ${text}`;
  document.getElementById('reply-bar').classList.add('show');
  document.getElementById('msg-input').focus();
}

function cancelReply() {
  replyToMsg = null;
  document.getElementById('reply-bar').classList.remove('show');
  document.getElementById('reply-preview').textContent = '';
}

// ── Reactions ─────────────────────────────────────────────────────────────────

function sendReaction(msgId, emoji) {
  socket.emit('react', { msgId, emoji });
}

// ── Report ────────────────────────────────────────────────────────────────────

let pendingReportMsg = null;

function openReport(msgId, text) {
  pendingReportMsg = { id: msgId, text };
  document.getElementById('report-dialog').classList.add('show');
}

function closeReport() {
  pendingReportMsg = null;
  document.getElementById('report-dialog').classList.remove('show');
}

function submitReport() {
  if (!pendingReportMsg) return;
  const reason = document.getElementById('report-reason').value;
  socket.emit('report message', { msgId: pendingReportMsg.id, text: pendingReportMsg.text, reason });
  closeReport();
}

// ── Send message ──────────────────────────────────────────────────────────────

function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;

  if (slowModeSecs > 0) {
    const elapsed = (Date.now() - lastMsgTs) / 1000;
    if (elapsed < slowModeSecs) {
      showToast(`Slow mode — wait ${Math.ceil(slowModeSecs - elapsed)}s before sending`);
      return;
    }
  }
  lastMsgTs = Date.now();

  socket.emit('room message', { text, parentId: replyToMsg?.id || null });
  input.value = '';
  input.style.height = 'auto';
  cancelReply();
  input.focus();
}

// Auto-resize textarea + typing emit
let _typingDebounce = null;
document.getElementById('msg-input').addEventListener('input', function () {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 100) + 'px';
  clearTimeout(_typingDebounce);
  _typingDebounce = setTimeout(() => { if (currentRoom) socket.emit('typing'); }, 300);
});

document.getElementById('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ── Typing indicators ─────────────────────────────────────────────────────────

function showTypingIndicator(persona) {
  const el = document.getElementById('messages');
  if (el.querySelector(`.typing-indicator[data-persona="${persona}"]`)) return;
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.dataset.persona = persona;
  div.innerHTML = `<span>${esc(persona)}</span><div class="typing-dots" aria-label="typing"><span></span><span></span><span></span></div>`;
  el.appendChild(div);
  scrollBottom('messages');
}

function removeTypingIndicator(persona) {
  const ind = document.getElementById('messages').querySelector(`.typing-indicator[data-persona="${persona}"]`);
  if (ind) ind.remove();
  delete typingUsers[persona];
}

// ── Message search ────────────────────────────────────────────────────────────

let _searchTimeout = null;

function toggleSearch() {
  const bar = document.getElementById('search-bar');
  const results = document.getElementById('search-results');
  const isOpen = bar.classList.toggle('show');
  if (isOpen) {
    document.getElementById('search-input').focus();
  } else {
    results.classList.remove('show');
    results.innerHTML = '';
    document.getElementById('search-input').value = '';
  }
}

document.getElementById('search-input').addEventListener('input', function () {
  const q = this.value.trim();
  clearTimeout(_searchTimeout);
  if (!q || q.length < 2) {
    document.getElementById('search-results').classList.remove('show');
    return;
  }
  _searchTimeout = setTimeout(() => runSearch(q), 350);
});

document.getElementById('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toggleSearch();
});

async function runSearch(q) {
  if (!currentRoom) return;
  try {
    const res = await fetch(`/api/search/${encodeURIComponent(currentRoom)}?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderSearchResults(data.results || [], q);
  } catch (e) {
    renderSearchResults([], q);
  }
}

function renderSearchResults(results, q) {
  const el = document.getElementById('search-results');
  el.innerHTML = '';
  if (!results.length) {
    el.innerHTML = `<div class="sr-empty">No messages found for "${esc(q)}"</div>`;
    el.classList.add('show');
    return;
  }
  results.forEach((r) => {
    const div = document.createElement('div');
    div.className = 'search-result';
    div.setAttribute('role', 'option');
    const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hi = r.text.replace(new RegExp(`(${safeQ})`, 'gi'), '<mark style="background:rgba(122,158,126,.3);border-radius:2px">$1</mark>');
    div.innerHTML = `<div class="sr-persona">${esc(r.persona)}${r.isAI ? ' · Sage' : ''}</div><div class="sr-text">${hi}</div><div class="sr-time">${fmtTime(r.ts)}</div>`;
    el.appendChild(div);
  });
  el.classList.add('show');
}
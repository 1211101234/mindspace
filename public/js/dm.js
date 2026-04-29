// ── dm.js ─────────────────────────────────────────────────────────────────────
// Direct messaging panel logic.

let pendingDMFrom = null;

function requestDM(targetId) {
  socket.emit('dm request', targetId);
}

function acceptDM() {
  if (!pendingDMFrom) return;
  socket.emit('dm accept', pendingDMFrom);
  document.getElementById('dm-toast').classList.remove('show');
}

function declineDM() {
  pendingDMFrom = null;
  document.getElementById('dm-toast').classList.remove('show');
}

function sendDM() {
  const input = document.getElementById('dm-msg-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('dm message', text);
  input.value = '';
  input.focus();
}

function closeDM() {
  socket.emit('dm close');
  document.getElementById('dm-panel').classList.remove('open');
}

document.getElementById('dm-msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendDM(); }
});

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('dm request', ({ fromId, fromPersona }) => {
  pendingDMFrom = fromId;
  document.getElementById('dm-requester').textContent = fromPersona;
  document.getElementById('dm-toast').classList.add('show');
  playChime('dm');
});

socket.on('dm open', ({ partnerPersona, history }) => {
  document.getElementById('dm-partner-name').textContent = partnerPersona;
  document.getElementById('dm-messages').innerHTML = '';
  if (history) history.forEach((m) => renderMsg(m, 'dm-messages'));
  document.getElementById('dm-panel').classList.add('open');
  scrollBottom('dm-messages');
});

socket.on('dm message', (msg) => {
  renderMsg(msg, 'dm-messages');
  scrollBottom('dm-messages');
});

socket.on('dm closed', () => {
  if (document.getElementById('dm-panel').classList.contains('open')) {
    const div = document.createElement('div');
    div.style.cssText = 'align-self:center;font-size:11px;color:var(--muted);padding:8px;text-align:center';
    div.textContent = 'The other person ended the conversation.';
    document.getElementById('dm-messages').appendChild(div);
    scrollBottom('dm-messages');
  }
});
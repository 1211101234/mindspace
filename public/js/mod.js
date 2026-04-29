// ── mod.js ────────────────────────────────────────────────────────────────────
// Moderator panel, flag review, and message removal.

function showModPanel(flags) {
  const panel = document.getElementById('mod-panel');
  panel.classList.add('visible');
  panel.innerHTML = `
    <div class="mod-card" style="position:relative">
      <button class="mod-close" onclick="document.getElementById('mod-panel').classList.remove('visible')" aria-label="Close mod panel">×</button>
      <h3>🛡 Flagged Messages (${flags.length})</h3>
      ${flags.slice(0, 5).map((f) => `
        <div class="mod-flag-item">
          <div>${esc(f.persona || '?')}: ${esc((f.text || '').slice(0, 80))}</div>
          <div class="flag-reason">${esc(f.reason || '')} · ${new Date(f.ts).toLocaleTimeString()}</div>
          <div class="flag-actions">
            <button class="flag-dismiss" onclick="modReview(${f.id})">Dismiss</button>
            <button class="flag-remove"  onclick="modRemove('${f.message_id}','${f.room_id || currentRoom}',${f.id})">Remove message</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function modReview(id) {
  socket.emit('mod review flag', id);
  showToast('Flag dismissed');
}

function modRemove(msgId, roomId, flagId) {
  socket.emit('mod remove', { msgId, roomId });
  socket.emit('mod review flag', flagId);
  showToast('Message removed');
}

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('mod auth ok', ({ flags }) => {
  document.getElementById('mod-badge').classList.add('visible');
  document.getElementById('mod-dashboard-btn').style.display = 'flex';
  showToast('🛡 Moderator access granted — dashboard unlocked');
  if (flags && flags.length > 0) showModPanel(flags);
});

socket.on('mod auth fail', () => {
  showToast('Incorrect moderator secret.');
});

socket.on('mod alert', ({ type, level, persona, room, text }) => {
  const msg = level === 'high'
    ? `🚨 HIGH CRISIS — ${persona} in #${room}: "${text.slice(0, 60)}…"`
    : `⚠️ Concern — ${persona} in #${room}: "${text.slice(0, 60)}…"`;
  showToast(msg, 12000);
});

socket.on('message removed', ({ msgId }) => {
  const el = document.querySelector(`.msg[data-msg-id="${msgId}"]`);
  if (el) {
    el.classList.add('removed');
    el.querySelector('.msg-bubble').textContent = 'Message removed by moderator';
  }
});
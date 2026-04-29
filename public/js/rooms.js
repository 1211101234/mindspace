// ── rooms.js ──────────────────────────────────────────────────────────────────
// Handles the landing screen, room selection, and room navigation.

let selectedRoom = null;

// ── Landing ───────────────────────────────────────────────────────────────────

function renderLandingRooms(rooms) {
  const grid = document.getElementById('room-grid');
  grid.innerHTML = '';
  rooms.forEach((r) => {
    const tile = document.createElement('div');
    tile.className = 'room-tile';
    tile.setAttribute('role', 'radio');
    tile.setAttribute('aria-checked', 'false');
    tile.setAttribute('tabindex', '0');
    tile.dataset.id = r.id;
    tile.innerHTML = `<div class="rt-name">${esc(r.label)}</div><div class="rt-desc">${esc(r.desc)}</div>`;

    const select = () => {
      document.querySelectorAll('.room-tile').forEach((t) => {
        t.classList.remove('selected');
        t.setAttribute('aria-checked', 'false');
      });
      tile.classList.add('selected');
      tile.setAttribute('aria-checked', 'true');
      selectedRoom = r.id;
      document.getElementById('custom-room-input').value = '';
      document.getElementById('enter-btn').disabled = false;
    };

    tile.onclick = select;
    tile.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } };
    grid.appendChild(tile);
  });
}

document.getElementById('custom-room-input').addEventListener('input', (e) => {
  const val = e.target.value.trim();
  if (val) {
    document.querySelectorAll('.room-tile').forEach((t) => {
      t.classList.remove('selected');
      t.setAttribute('aria-checked', 'false');
    });
    selectedRoom = val.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
    document.getElementById('enter-btn').disabled = !selectedRoom;
  } else {
    selectedRoom = null;
    document.getElementById('enter-btn').disabled = true;
  }
});

function enterApp() {
  if (!selectedRoom) return;
  document.getElementById('landing').classList.add('out');
  setTimeout(() => {
    document.getElementById('landing').style.display = 'none';
    document.getElementById('app').classList.add('visible');
    buildRoomNav();
    joinRoom(selectedRoom);
  }, 600);
}

// ── Room navigation ───────────────────────────────────────────────────────────

function buildRoomNav() {
  const nav = document.getElementById('room-nav');
  nav.innerHTML = '';
  availableRooms.forEach((r) => addRoomToNav(r.id, r.label));
}

function addRoomToNav(id, label) {
  const nav = document.getElementById('room-nav');
  if (nav.querySelector(`[data-id="${id}"]`)) return;
  const li = document.createElement('li');
  li.dataset.id = id;
  li.setAttribute('role', 'listitem');
  li.setAttribute('tabindex', '0');
  li.innerHTML = `<span class="room-hash" aria-hidden="true">#</span>${esc(label || id)}`;
  li.onclick = () => { joinRoom(id); closeSidebar(); };
  li.onkeydown = (e) => { if (e.key === 'Enter') { joinRoom(id); closeSidebar(); } };
  nav.appendChild(li);
}

function sidebarJoinRoom() {
  const input = document.getElementById('sidebar-room-input');
  const val = input.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
  if (!val) return;
  ROOM_META[val] = { id: val, label: val, desc: 'Community room' };
  addRoomToNav(val, val);
  joinRoom(val);
  input.value = '';
  closeSidebar();
}

function joinRoom(roomId) {
  currentRoom = roomId;
  const meta = ROOM_META[roomId] || { label: roomId, desc: 'Community room' };
  document.getElementById('room-header-name').textContent = meta.label || roomId;
  document.getElementById('room-header-desc').textContent = meta.desc || '';
  document.getElementById('messages').innerHTML = '';
  lastSender = '';
  lastSenderTs = 0;
  replyToMsg = null;
  cancelReply();

  // Clear typing indicators
  Object.keys(typingUsers).forEach((k) => {
    clearTimeout(typingUsers[k]);
    delete typingUsers[k];
  });

  document.querySelectorAll('#room-nav li').forEach((li) =>
    li.classList.toggle('active', li.dataset.id === roomId)
  );
  socket.emit('join room', roomId);
}

// ── Mobile sidebar ────────────────────────────────────────────────────────────

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const ov = document.getElementById('sidebar-overlay');
  const btn = document.getElementById('hamburger-btn');
  const open = sb.classList.toggle('mobile-open');
  ov.classList.toggle('show', open);
  btn.setAttribute('aria-expanded', open);
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('mobile-open');
  document.getElementById('sidebar-overlay').classList.remove('show');
  document.getElementById('hamburger-btn').setAttribute('aria-expanded', 'false');
}
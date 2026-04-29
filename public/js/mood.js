// ── mood.js ───────────────────────────────────────────────────────────────────
// Mood check-in overlay and room mood trend chart.

// ── Check-in ─────────────────────────────────────────────────────────────────

function submitMood(score) {
  document.querySelectorAll('.mood-btn').forEach((b) =>
    b.classList.toggle('chosen', parseInt(b.dataset.score) === score)
  );
  socket.emit('mood checkin', score);
  setTimeout(() => {
    document.getElementById('mood-overlay').classList.remove('open');
    showToast('Thanks for checking in 🌿');
  }, 600);
}

function skipMood() {
  socket.emit('mood checkin', null);
  document.getElementById('mood-overlay').classList.remove('open');
}

socket.on('mood checkin prompt', () => {
  setTimeout(() => document.getElementById('mood-overlay').classList.add('open'), 1200);
});

// ── Chart (Canvas) ────────────────────────────────────────────────────────────

async function loadMoodChart() {
  if (!currentRoom) return;
  try {
    const res  = await fetch(`/api/mood/${encodeURIComponent(currentRoom)}`);
    const data = await res.json();
    renderMoodChart(data.trend || []);
  } catch (e) {}
}

function renderMoodChart(trend) {
  const canvas = document.getElementById('mood-chart');
  const empty  = document.getElementById('mood-chart-empty');
  if (!canvas) return;
  if (!trend || !trend.length) {
    canvas.style.display = 'none';
    empty.style.display  = 'block';
    return;
  }
  canvas.style.display = 'block';
  empty.style.display  = 'none';

  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const scores = trend.map((d) => d.avg);
  const minS   = Math.max(1, Math.min(...scores) - 0.5);
  const maxS   = Math.min(5, Math.max(...scores) + 0.5);
  const pad    = 12;
  const xs     = trend.map((_, i) => pad + i * ((W - pad * 2) / Math.max(trend.length - 1, 1)));
  const ys     = scores.map((s) => H - pad - ((s - minS) / (maxS - minS || 1)) * (H - pad * 2));

  // Grid lines
  ctx.strokeStyle = 'rgba(122,158,126,.15)';
  ctx.lineWidth   = 1;
  for (let i = 1; i <= 4; i++) {
    const y = pad + (i / 5) * (H - pad * 2);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(W - pad, y); ctx.stroke();
  }

  const isDark    = window.matchMedia('(prefers-color-scheme:dark)').matches;
  const fillColor = isDark ? 'rgba(106,144,112,.25)' : 'rgba(122,158,126,.2)';
  const lineColor = isDark ? '#6a9070' : '#7a9e7e';

  // Fill area
  ctx.beginPath();
  ctx.moveTo(xs[0], H - pad);
  xs.forEach((x, i) => ctx.lineTo(x, ys[i]));
  ctx.lineTo(xs[xs.length - 1], H - pad);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  // Line
  ctx.beginPath();
  xs.forEach((x, i) => { if (i === 0) ctx.moveTo(x, ys[i]); else ctx.lineTo(x, ys[i]); });
  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // Dots
  xs.forEach((x, i) => {
    ctx.beginPath();
    ctx.arc(x, ys[i], 3.5, 0, Math.PI * 2);
    ctx.fillStyle = lineColor;
    ctx.fill();
  });

  // Date labels
  ctx.fillStyle = isDark ? 'rgba(184,175,164,.5)' : 'rgba(154,144,136,.7)';
  ctx.font      = '9px DM Sans, sans-serif';
  ctx.textAlign = 'center';
  trend.forEach((d, i) => ctx.fillText(d.date.slice(5), xs[i], H - 1));
}
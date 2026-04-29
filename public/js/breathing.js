// ── breathing.js ──────────────────────────────────────────────────────────────
// Guided box breathing exercise (4-4-4-4).

const PHASES = [
  { label: 'Breathe in', cls: 'inhale', dur: 4 },
  { label: 'Hold',       cls: 'hold',   dur: 4 },
  { label: 'Breathe out',cls: 'exhale', dur: 4 },
  { label: 'Hold',       cls: 'hold',   dur: 4 },
];

let breatheInterval = null;
let phaseIdx        = 0;
let phaseCount      = 0;

function startBreathing() {
  if (breatheInterval) return;
  const btn = document.getElementById('breathe-start-btn');
  btn.textContent = 'Running…';
  btn.disabled    = true;
  phaseIdx = 0;
  runPhase();
}

function runPhase() {
  const p = PHASES[phaseIdx];
  document.getElementById('breathe-circle').className = 'breathe-circle ' + p.cls;
  document.getElementById('breathe-label').textContent = p.label;
  phaseCount = p.dur;
  document.getElementById('breathe-count').textContent = phaseCount;

  breatheInterval = setInterval(() => {
    phaseCount--;
    document.getElementById('breathe-count').textContent = phaseCount;
    if (phaseCount <= 0) {
      clearInterval(breatheInterval);
      breatheInterval = null;
      phaseIdx = (phaseIdx + 1) % PHASES.length;
      runPhase();
    }
  }, 1000);
}

function stopBreathing() {
  if (breatheInterval) { clearInterval(breatheInterval); breatheInterval = null; }
  document.getElementById('breathe-circle').className  = 'breathe-circle';
  document.getElementById('breathe-label').textContent  = 'Ready';
  document.getElementById('breathe-count').textContent  = '—';
  const btn = document.getElementById('breathe-start-btn');
  btn.textContent = 'Begin';
  btn.disabled    = false;
  phaseIdx = 0;
}
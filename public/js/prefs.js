// ── prefs.js ──────────────────────────────────────────────────────────────────
// User preferences: font size, sound, notifications, high contrast, language.

const prefs = JSON.parse(localStorage.getItem('mindspace-prefs') || '{}');

// ── Overlay panels ────────────────────────────────────────────────────────────

function openPanel(id) {
  document.getElementById(id).classList.add('open');
  if (id === 'settings-panel') loadMoodChart();
}

function closePanel(id) {
  document.getElementById(id).classList.remove('open');
}

// Close on backdrop click
document.querySelectorAll('.overlay-panel').forEach((panel) => {
  panel.addEventListener('click', (e) => {
    if (e.target === panel) {
      if (panel.id === 'breathe-panel') stopBreathing();
      panel.classList.remove('open');
    }
  });
});

// Close on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.overlay-panel.open').forEach((p) => {
      if (p.id === 'breathe-panel') stopBreathing();
      p.classList.remove('open');
    });
    document.getElementById('mood-overlay').classList.remove('open');
    closeReport();
  }
});

// ── Font size ─────────────────────────────────────────────────────────────────

function setFontSize(size) {
  document.body.classList.remove('font-lg', 'font-xl');
  if (size === 'lg') document.body.classList.add('font-lg');
  if (size === 'xl') document.body.classList.add('font-xl');
  ['fz-sm', 'fz-lg', 'fz-xl'].forEach((id) => document.getElementById(id).classList.remove('active'));
  document.getElementById(`fz-${size}`).classList.add('active');
  localStorage.setItem('mindspace-font', size);
}

// Restore saved font size on load
(function () {
  const saved = localStorage.getItem('mindspace-font');
  if (saved && saved !== 'sm') setFontSize(saved);
})();

// ── Toggle preference ─────────────────────────────────────────────────────────

function togglePref(key) {
  prefs[key] = !prefs[key];
  localStorage.setItem('mindspace-prefs', JSON.stringify(prefs));
  const row = document.getElementById(`pref-${key}`);
  if (row) {
    row.classList.toggle('on', !!prefs[key]);
    row.setAttribute('aria-checked', prefs[key] ? 'true' : 'false');
  }
  if (key === 'notif'    && prefs[key]) requestNotifPermission();
  if (key === 'contrast') document.body.classList.toggle('high-contrast', !!prefs[key]);
  if (key === 'memory')  { showMemorySummary(); updateSageMemoryBadge(); }
  if (key === 'bm')      applyUILang(prefs.bm ? 'bm' : 'en');
}

function initPrefs() {
  Object.keys(prefs).forEach((k) => {
    const row = document.getElementById(`pref-${k}`);
    if (row) {
      row.classList.toggle('on', !!prefs[k]);
      row.setAttribute('aria-checked', prefs[k] ? 'true' : 'false');
    }
  });
  if (prefs.contrast) document.body.classList.add('high-contrast');
  if (prefs.memory)   showMemorySummary();
  if (prefs.bm)       applyUILang('bm');
}
initPrefs();

// ── Notifications ─────────────────────────────────────────────────────────────

async function requestNotifPermission() {
  if (!('Notification' in window)) {
    showToast("Browser notifications aren't supported here.");
    prefs.notif = false;
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    prefs.notif = false;
    localStorage.setItem('mindspace-prefs', JSON.stringify(prefs));
    document.getElementById('pref-notif').classList.remove('on');
    showToast('Notification permission denied.');
  }
}

function sendBrowserNotif(title, body) {
  if (!prefs.notif || Notification.permission !== 'granted' || document.hasFocus()) return;
  new Notification(title, { body, icon: '/icon-192.png', tag: 'mindspace' });
}

// ── Sound (Web Audio API) ─────────────────────────────────────────────────────

let audioCtx = null;

function playChime(type = 'message') {
  if (!prefs.sound) return;
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { return; }
  }
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type = 'sine';
  if (type === 'dm') {
    osc.frequency.setValueAtTime(520, audioCtx.currentTime);
    osc.frequency.setValueAtTime(660, audioCtx.currentTime + 0.1);
  } else {
    osc.frequency.setValueAtTime(440, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(380, audioCtx.currentTime + 0.2);
  }
  gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
  osc.start(audioCtx.currentTime);
  osc.stop(audioCtx.currentTime + 0.35);
}

// ── BM / language strings ─────────────────────────────────────────────────────

const UI_STRINGS = {
  en: {
    placeholder: 'Share what\'s on your mind...',
    moodTitle:   'How are you feeling?',
    moodSubtitle:'A quick check-in helps Sage understand how the room is doing today. Fully anonymous.',
    moodSkip:    'Skip for now',
    sageIntro:   'Sage is a gentle AI presence here to listen and support — not to diagnose or advise. This conversation is private. Take your time. 🌿',
  },
  bm: {
    placeholder: 'Kongsi apa yang ada di fikiran anda...',
    moodTitle:   'Bagaimana perasaan anda?',
    moodSubtitle:'Semak masuk ringkas ini membantu Sage memahami keadaan bilik hari ini. Sepenuhnya tanpa nama.',
    moodSkip:    'Langkau buat masa ini',
    sageIntro:   'Sage ialah kehadiran AI yang lembut untuk mendengar dan menyokong — bukan untuk mendiagnosis atau menasihati. Perbualan ini adalah peribadi. Ambil masa anda. 🌿',
  },
};

function applyUILang(lang) {
  const s = UI_STRINGS[lang] || UI_STRINGS.en;
  const inp = document.getElementById('msg-input');
  if (inp) inp.placeholder = s.placeholder;
  const moodTitle = document.querySelector('#mood-overlay .mood-card h2');
  if (moodTitle) moodTitle.textContent = s.moodTitle;
  const moodSub = document.querySelector('#mood-overlay .mood-card p');
  if (moodSub) moodSub.textContent = s.moodSubtitle;
  const moodSkip = document.querySelector('.mood-skip');
  if (moodSkip) moodSkip.textContent = s.moodSkip;
  const sageIntroEl = document.querySelector('.sage-intro');
  if (sageIntroEl) sageIntroEl.textContent = s.sageIntro;
}

// ── Mod volunteer application ─────────────────────────────────────────────────

async function submitModApplication() {
  const why   = document.getElementById('mod-why').value.trim();
  const avail = document.getElementById('mod-avail').value.trim();
  if (!why) { showToast('Please share why you want to help.'); return; }
  try {
    const res  = await fetch('/mod/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: myPersona, why, availability: avail }),
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById('mod-apply-form').style.display = 'none';
      document.getElementById('mod-apply-sent').style.display = 'block';
    } else {
      showToast('Something went wrong — try again.');
    }
  } catch (e) {
    showToast('Could not submit — check your connection.');
  }
}
// ── utils.js ─────────────────────────────────────────────────────────────────
// Shared utility functions used across all modules.

/**
 * Sanitise a string for safe HTML insertion.
 * Uses DOMPurify when available, falls back to manual escaping.
 */
function esc(s) {
  if (typeof DOMPurify !== 'undefined') return DOMPurify.sanitize(String(s));
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Format a timestamp as HH:MM.
 * @param {number} ts - Unix timestamp in ms
 */
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Scroll a scrollable container to the bottom.
 * @param {string} id - Element ID
 */
function scrollBottom(id) {
  const el = document.getElementById(id);
  if (el) el.scrollTop = el.scrollHeight;
}

// ── Toast notification ────────────────────────────────────────────────────────
let _toastTimeout = null;

/**
 * Show a temporary toast notification at the top of the screen.
 * @param {string} msg
 * @param {number} duration - ms before auto-dismiss (default 4000)
 */
function showToast(msg, duration = 4000) {
  const el = document.getElementById('toast-notify');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimeout);
  _toastTimeout = setTimeout(() => el.classList.remove('show'), duration);
}
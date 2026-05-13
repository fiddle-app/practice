'use strict';

// =================================================================
// SHARED PERSISTENT DIAGNOSTIC LOG
// Used by: microbreaker, ear-tuner
// -----------------------------------------------------------------
// Captures console.log / console.warn / console.error, uncaught
// errors, and unhandled promise rejections to localStorage. Survives
// crashes and reloads — viewable in each app's Settings → Diagnostics
// (Copy / Clear). Created so iPhone PWA crashes (no Web Inspector
// without a Mac tether) can be diagnosed remotely from the device.
//
// Prefix configuration:
//   window.__DIAG_LOG_PREFIX__ must be set BEFORE this script loads.
//   Each app sets it in an inline <script> tag in <head>, before the
//   <script src="js/diag-log.js"> tag. Microbreaker uses 'mb',
//   ear-tuner uses 'et'. Falls back to 'app' if unset.
//   The prefix also matches the inline boot-watchdog script's hardcoded
//   prefix (mb-boot-attempts / et-boot-attempts etc.), so the
//   diagBootStatus / diagSimulateCrashAndReload / diagResetBootCounter
//   helpers below read the same keys the watchdog writes.
//
// Globals exposed:
//   diagRead()                    → Array<{t,level,msg}>
//   diagClear()                   → void
//   diagBootStatus()              → string (Settings line)
//   diagSimulateCrashAndReload()  → void (test helper)
//   diagResetBootCounter()        → void (test helper)
//   logEvent(msg)                 → void (explicit "log this" — same
//                                   persistence as console.log; some
//                                   apps prefer this naming for app-
//                                   event breadcrumbs)
//   copyLog()                     → void (clipboard + 'Copied!' UI;
//                                   targets #s-copy-log-btn if present)
//   clearLog()                    → void (alias for diagClear + UI
//                                   refresh if updateLogUI present)
//
// Storage: localStorage["<prefix>-diag-log"]. Ring buffer capped at
// 500 entries × 1500 chars = ~750 KB max — iOS PWA quota is 5+ MB so
// the cap leaves ample room while still preserving enough breadcrumbs
// before a crash for the "open Settings → scroll to Diagnostics → Copy
// log" workflow to capture the relevant context.
// =================================================================

const DIAG_PREFIX = (typeof window !== 'undefined' && window.__DIAG_LOG_PREFIX__) || 'app';
const DIAG_KEY    = DIAG_PREFIX + '-diag-log';
const DIAG_MAX    = 500;

function diagAppend(level, msg) {
  try {
    const arr = JSON.parse(localStorage.getItem(DIAG_KEY) || '[]');
    arr.push({ t: Date.now(), level, msg: String(msg).slice(0, 1500) });
    while (arr.length > DIAG_MAX) arr.shift();
    localStorage.setItem(DIAG_KEY, JSON.stringify(arr));
  } catch (_) {
    // Don't recurse on log-write failure — that's how a logger creates
    // a stack-overflow crash. Silent drop is the right move.
  }
}

function diagFormatArgs(args) {
  return Array.from(args).map((a) => {
    if (a == null) return String(a);
    if (a instanceof Error) {
      return `${a.name || 'Error'}: ${a.message || ''}\n${a.stack || ''}`;
    }
    if (typeof a === 'object') {
      try { return JSON.stringify(a); } catch (_) { return '[Object]'; }
    }
    return String(a);
  }).join(' ');
}

function diagRead() {
  try { return JSON.parse(localStorage.getItem(DIAG_KEY) || '[]'); }
  catch (_) { return []; }
}

function diagClear() {
  try { localStorage.removeItem(DIAG_KEY); } catch (_) {}
}

// ── Boot watchdog status / test helpers ──────────────────────────
// Shared between the Settings → Diagnostics → "Crash recovery"
// section and any inline #debug URL panel. Reads the same LS keys the
// inline boot-watchdog writes in each app's <head>.

function diagBootStatus() {
  try {
    var counter = localStorage.getItem(DIAG_PREFIX + '-boot-attempts') || '0';
    var clean   = localStorage.getItem(DIAG_PREFIX + '-clean-shutdown');
    var cleanText = clean === '1' ? 'clean'
                  : clean === '0' ? 'running/crashed'
                  : '(none yet)';
    return 'boot-attempts: ' + counter + '  ·  shutdown-marker: ' + cleanText;
  } catch (_) { return '(localStorage unavailable)'; }
}

// Set the suppress flag and reload — the next boot's watchdog reads
// <prefix>-clean-shutdown still at '0' (never set to '1' on this
// unload because the suppress flag short-circuits the markClean
// handler) and treats it as a crash signal, incrementing the counter.
// Press 3 times to reach the recovery threshold.
function diagSimulateCrashAndReload() {
  try { localStorage.setItem(DIAG_PREFIX + '-test-suppress-clean', '1'); } catch (_) {}
  location.reload();
}

// Zero the bad-boot counter and set the shutdown marker to '1' (clean)
// — useful if a real crash counted falsely or after testing.
function diagResetBootCounter() {
  try {
    localStorage.setItem(DIAG_PREFIX + '-boot-attempts', '0');
    localStorage.setItem(DIAG_PREFIX + '-clean-shutdown', '1');
  } catch (_) {}
}

// ── Explicit app-event logging ───────────────────────────────────
// Same persistence as console.log; some apps (ear-tuner) prefer the
// `logEvent` naming for breadcrumb-style app-event capture (round
// start/end, note plays). Identical behaviour to console.log under
// the hood — both go through diagAppend.

function logEvent(msg) {
  diagAppend('log', msg);
}

// ── Clipboard / UI helpers ───────────────────────────────────────
// copyLog and clearLog know about a small UI convention used by both
// apps' Settings panel: a "Copy" button with id="s-copy-log-btn"
// flashes "Copied!" then reverts. If the button isn't in the DOM (some
// future app might not surface it), the clipboard write still happens.

function copyLog() {
  try {
    const entries = diagRead();
    const text = entries.length
      ? entries.map(function (e) {
          const ts = new Date(e.t).toISOString().replace('T', ' ').slice(0, 22);
          return '[' + ts + '] ' + e.level + ': ' + e.msg;
        }).join('\n')
      : '(empty)';
    const btn = document.getElementById('s-copy-log-btn');
    navigator.clipboard.writeText(text).then(function () {
      if (btn) {
        btn.textContent = 'Copied!';
        btn.classList.add('feedback');
        setTimeout(function () {
          btn.textContent = 'Copy';
          btn.classList.remove('feedback');
        }, 1800);
      }
    }).catch(function () {
      prompt('Copy log:', text);
    });
    diagAppend('info', 'Log copied');
  } catch (_) {}
}

function clearLog() {
  diagClear();
  if (typeof updateLogUI === 'function') updateLogUI();
  diagAppend('info', 'Log cleared');
}

// ── Console wrapping ─────────────────────────────────────────────
// Every existing console.log / .warn / .error site keeps working
// unchanged, but each call now also persists. console.debug is
// intentionally NOT wrapped — too noisy (per-utterance recognizer
// events fire through it).

const _origConsoleError = console.error.bind(console);
const _origConsoleWarn  = console.warn.bind(console);
const _origConsoleLog   = console.log.bind(console);
console.error = function (...args) {
  diagAppend('error', diagFormatArgs(args));
  return _origConsoleError(...args);
};
console.warn = function (...args) {
  diagAppend('warn', diagFormatArgs(args));
  return _origConsoleWarn(...args);
};
console.log = function (...args) {
  diagAppend('log', diagFormatArgs(args));
  return _origConsoleLog(...args);
};

// Uncaught synchronous errors — the most useful signal for "page
// crashed" investigations on iOS.
window.addEventListener('error', function (ev) {
  const msg = ev.error
    ? `${ev.error.name || 'Error'}: ${ev.error.message || ev.message}\n${ev.error.stack || ''}`
    : `${ev.message || '(no message)'} at ${ev.filename || '?'}:${ev.lineno || '?'}:${ev.colno || '?'}`;
  diagAppend('error', msg);
});

// Promise rejections that no .catch ever consumed.
window.addEventListener('unhandledrejection', function (ev) {
  const r = ev.reason;
  const msg = r instanceof Error
    ? `Unhandled rejection: ${r.name || 'Error'}: ${r.message || ''}\n${r.stack || ''}`
    : `Unhandled rejection: ${diagFormatArgs([r])}`;
  diagAppend('error', msg);
});

// Mark the boot so we can see in the log how many reloads have
// happened between crashes.
diagAppend('info', `boot prefix=${DIAG_PREFIX} — ${navigator.userAgent}`);

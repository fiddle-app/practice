'use strict';

// =================================================================
// PERSISTENT DIAGNOSTIC LOG
// -----------------------------------------------------------------
// Captures console.error / console.warn, uncaught errors, and
// unhandled promise rejections to localStorage. Survives crashes and
// reloads — viewable in Settings → Diagnostics. Created so iPhone
// PWA crashes (no Web Inspector available without a Mac tether) can
// be diagnosed remotely from the device.
//
// Globals exposed:
//   diagRead()   → Array<{t:number,level:string,msg:string}>
//   diagClear()  → void
//
// Storage: localStorage.mb-diag-log (JSON array, capped at 500 entries).
// =================================================================

const DIAG_KEY = 'mb-diag-log';
// 500-entry ring buffer, ~750 KB at the per-entry 1500-char cap. Sized so that
// the few clicks needed after a crash (boot → unlock → open Settings → scroll
// to Diagnostics → Copy log) don't push the pre-crash breadcrumb trail off the
// end. iOS Safari PWA localStorage quota is 5+ MB — this leaves plenty of room.
const DIAG_MAX = 500;

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
// section and the inline #debug URL panel. The inline panel duplicates
// the simulation logic for robustness — these helpers exist so Settings
// stays DRY.

function diagBootStatus() {
  try {
    var counter = localStorage.getItem('mb-boot-attempts') || '0';
    var clean   = localStorage.getItem('mb-clean-shutdown');
    var cleanText = clean === '1' ? 'clean'
                  : clean === '0' ? 'running/crashed'
                  : '(none yet)';
    return 'boot-attempts: ' + counter + '  ·  shutdown-marker: ' + cleanText;
  } catch (_) { return '(localStorage unavailable)'; }
}

// Set the suppress flag and reload — the next boot's watchdog reads
// mb-clean-shutdown still at '0' (never set to '1' on this unload because
// the suppress flag short-circuits the markClean handler) and treats it
// as a crash signal, incrementing the counter. Press 3 times to reach
// the recovery threshold.
function diagSimulateCrashAndReload() {
  try { localStorage.setItem('mb-test-suppress-clean', '1'); } catch (_) {}
  location.reload();
}

// Zero the bad-boot counter and set the shutdown marker to '1' (clean) —
// useful if a real crash counted falsely or after testing.
function diagResetBootCounter() {
  try {
    localStorage.setItem('mb-boot-attempts', '0');
    localStorage.setItem('mb-clean-shutdown', '1');
  } catch (_) {}
}

// Wrap console.error, console.warn, and console.log — every existing call
// site keeps working unchanged, but each call now also persists. console.log
// was added when the iPhone PWA started crashing in scenarios where no error
// or warn fired before the kill — checkpoint markers (the "[bp] ..." lines
// in voice.js / voice-commands.js / ui.js) need a persistent sink to survive
// the crash. console.debug is intentionally NOT wrapped — too noisy (per-
// utterance recognizer events fire through it).
const _origConsoleError = console.error.bind(console);
const _origConsoleWarn  = console.warn.bind(console);
const _origConsoleLog   = console.log.bind(console);
console.error = function(...args) {
  diagAppend('error', diagFormatArgs(args));
  return _origConsoleError(...args);
};
console.warn = function(...args) {
  diagAppend('warn', diagFormatArgs(args));
  return _origConsoleWarn(...args);
};
console.log = function(...args) {
  diagAppend('log', diagFormatArgs(args));
  return _origConsoleLog(...args);
};

// Uncaught synchronous errors — the most useful signal for "page
// crashed" investigations on iOS.
window.addEventListener('error', (ev) => {
  const msg = ev.error
    ? `${ev.error.name || 'Error'}: ${ev.error.message || ev.message}\n${ev.error.stack || ''}`
    : `${ev.message || '(no message)'} at ${ev.filename || '?'}:${ev.lineno || '?'}:${ev.colno || '?'}`;
  diagAppend('error', msg);
});

// Promise rejections that no .catch ever consumed.
window.addEventListener('unhandledrejection', (ev) => {
  const r = ev.reason;
  const msg = r instanceof Error
    ? `Unhandled rejection: ${r.name || 'Error'}: ${r.message || ''}\n${r.stack || ''}`
    : `Unhandled rejection: ${diagFormatArgs([r])}`;
  diagAppend('error', msg);
});

// Mark the boot so we can see in the log how many reloads have
// happened between crashes.
diagAppend('info', `boot — ${navigator.userAgent}`);

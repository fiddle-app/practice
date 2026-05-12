'use strict';

// =================================================================
// VOICE COMMANDS — microbreaker integration
// -----------------------------------------------------------------
// Wires the shared voice-commands lib (_shared/js/voice-commands.js,
// vendored at js/voice-commands.js) into a per-screen command dispatch.
// Voice listens whenever the feature is enabled and the model is ready,
// regardless of which screen is active. Recognized commands route to the
// VOICE_CONTEXT_HANDLERS entry for the current screen, derived from
// overlay state + timer phase via vcCurrentContext().
//
// Buckets:
//   claim / reject       → user-defined "correct" / "wrong" phrases (vrGood /
//                          vrBad in settings); fall back to ["correct"] /
//                          ["wrong"] if the user clears the list
//   cmdStart / cmdReady / cmdDone / cmdNext / cmdPause / cmdPlay /
//   cmdSettings / cmdInfo / cmdClose / cmdReview / cmdReplay /
//   cmdRepCounter        → built-in navigation commands (not customizable)
//
// Globals consumed:
//   audioCtx, ensureAudio()       (audio-ctx.js)
//   micStream, acquireMic()       (mic.js)
//   settings, saveSettings()      (settings.js)
//   $ helper                      (boot.js / global)
//   createVoiceCommands()         (voice-commands.js — eagerly loaded)
//   window.Vosk                   (vosk-browser.js — LAZY-loaded inside
//                                   vcKickOffLoad on first opt-in; not in
//                                   the boot critical path)
//   phase, isPaused               (timer.js)
//   reviewBuffer, reviewPlaying   (ui.js)
// Globals exposed:
//   vc                            — the voice-commands instance (or null
//                                   until the lazy script + model are loaded)
//   vcStart(), vcStop()           — public API; called on Get Started, phase
//                                   change, focus regain
//   vcKickOffLoad()               — called by ui.js on Get Started
//   vcOnSettingChange(name)       — called by ui.js when toggles flip
// =================================================================

const VC_MODEL_URL =
  'https://fiddle-app.github.io/voice-models/vosk-model-small-en-us-0.15.tar.gz';
const VC_WORKLET_URL = 'js/voice-commands-worklet.js';

// Fallback claim/reject phrases when the user has cleared their custom list.
// The user's vrGood / vrBad arrays REPLACE these entirely when non-empty —
// the prior "merge built-ins on top" model is gone. Defaults seeded in
// settings.js so a fresh install gets ["correct","good"] / ["wrong","restart"].
const VC_BUILTIN_GOOD_FALLBACK = ['correct'];
const VC_BUILTIN_BAD_FALLBACK  = ['wrong'];

// Built-in navigation commands (not user-customizable). Each bucket name is
// referenced in VOICE_CONTEXT_HANDLERS to map a recognized phrase to a
// per-screen action. Keep this list in sync with the informational text in
// the Settings → Voice Recognition section of index.html.
const VC_BUILTIN_COMMANDS = {
  cmdStart:      ['start'],
  cmdReady:      ['ready'],
  cmdDone:       ['done'],
  cmdNext:       ['next'],
  cmdPause:      ['pause'],
  cmdPlay:       ['play'],
  cmdSettings:   ['settings'],
  cmdInfo:       ['info', 'information'],
  cmdClose:      ['close'],
  cmdReview:     ['review', 'recording', 'review recording'],
  cmdReplay:     ['replay'],
  cmdRepCounter: ['rep counter', 'counter', 'reps'],
};

function vcDedupeBucket(arr) {
  const seen = new Set();
  const out  = [];
  for (const w of (Array.isArray(arr) ? arr : [])) {
    const key = String(w || '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function vcBuildCommands() {
  const userGood = vcDedupeBucket(settings.vrGood);
  const userBad  = vcDedupeBucket(settings.vrBad);
  const claim  = userGood.length ? userGood : VC_BUILTIN_GOOD_FALLBACK.slice();
  const reject = userBad.length  ? userBad  : VC_BUILTIN_BAD_FALLBACK.slice();
  return Object.assign({ claim, reject }, VC_BUILTIN_COMMANDS);
}

// ── Per-screen command dispatch ───────────────────────────────────
// Handlers fire button clicks where possible — that way disabled state,
// existing wiring, and any side effects of the click already work for free.
// "play" and "pause" are NOT synonyms: each only fires its action if the
// app is in the matching state (paused vs. playing).
//
// TODO (when EarTuner adopts voice control): promote this map + the
// vcCurrentContext() derivation pattern to _shared/js/voice-context.js.
// The contract worth preserving is "context derived from DOM/state on
// demand, not via setVoiceContext propagation." Today's handlers are
// entangled with microbreaker globals (phase, isPaused, reviewBuffer,
// *-overlay IDs) — the lift will need parameterization, e.g.
// createVoiceContextRouter({ getContext, handlers }).
const VOICE_CONTEXT_HANDLERS = {
  welcome: {
    // Voice can't reach the welcome screen — no audio gesture yet.
  },
  ready: {
    cmdStart:    () => $('start-btn-inner').click(),
    cmdReady:    () => $('start-btn-inner').click(),
    cmdInfo:     () => $('info-btn').click(),
    cmdSettings: () => $('settings-btn').click(),
  },
  practice: {
    // claim/reject are rep-counter-only and ONLY fire while the panel is
    // expanded. When the panel is closed, the rep counter is "off" — voice
    // pretends it doesn't exist and these go to /dev/null. Per Casey's
    // amendment: nothing acts as a synonym for "correct" except the words
    // explicitly in the user's list (vrGood). cmdDone/Ready/Next are
    // navigation commands that advance the phase — they never claim a rep.
    // cmdStart is intentionally NOT mapped here — "start" only makes
    // sense on the Ready screen, not mid-practice.
    claim:         () => { if (typeof rcExpanded !== 'undefined' && rcExpanded && typeof rcClaimNext === 'function') rcClaimNext(); },
    reject:        () => { if (typeof rcExpanded !== 'undefined' && rcExpanded && typeof rcClearAll  === 'function') rcClearAll();  },
    cmdReady:      () => $('btn-next').click(),
    cmdDone:       () => $('btn-next').click(),
    cmdNext:       () => $('btn-next').click(),
    cmdPause:      () => { if (typeof isPaused !== 'undefined' && !isPaused) $('btn-play-pause').click(); },
    cmdPlay:       () => { if (typeof isPaused !== 'undefined' &&  isPaused) $('btn-play-pause').click(); },
    cmdSettings:   () => $('settings-btn').click(),
    cmdClose:      () => $('close-btn').click(),  // ends the chunk → returns to ready
    cmdRepCounter: () => $('rc-toggle-btn').click(),
  },
  break: {
    // cmdStart NOT mapped here — "start" only works on the Ready screen.
    cmdReady:    () => $('btn-next').click(),
    cmdDone:     () => $('btn-next').click(),
    cmdNext:     () => $('btn-next').click(),
    cmdPause:    () => { if (typeof isPaused !== 'undefined' && !isPaused) $('btn-play-pause').click(); },
    cmdPlay:     () => { if (typeof isPaused !== 'undefined' &&  isPaused) $('btn-play-pause').click(); },
    cmdSettings: () => $('settings-btn').click(),
    cmdClose:    () => $('close-btn').click(),    // ends the chunk → returns to ready
    cmdReview:   () => {
      const btn = $('review-btn');
      if (btn && btn.style.display !== 'none' && !btn.disabled) btn.click();
    },
  },
  rest: {
    // cmdStart NOT mapped here — "start" only works on the Ready screen.
    cmdReady:    () => $('btn-next').click(),
    cmdDone:     () => $('btn-next').click(),
    cmdNext:     () => $('btn-next').click(),
    cmdPause:    () => { if (typeof isPaused !== 'undefined' && !isPaused) $('btn-play-pause').click(); },
    cmdPlay:     () => { if (typeof isPaused !== 'undefined' &&  isPaused) $('btn-play-pause').click(); },
    cmdSettings: () => $('settings-btn').click(),
    cmdInfo:     () => $('info-btn').click(),
  },
  review: {
    // Review playback is Web-Audio (AudioBufferSourceNode through audioCtx),
    // not an <audio> element — we check `reviewPlaying` (ui.js global)
    // instead of an .paused property. cmdPlay also gates on reviewBuffer
    // existing so "play" said before the decode finishes is a no-op.
    cmdPause:  () => { if (typeof reviewPlaying !== 'undefined' && reviewPlaying) $('rev-playpause').click(); },
    cmdPlay:   () => {
      if (typeof reviewBuffer === 'undefined' || !reviewBuffer) return;
      if (typeof reviewPlaying !== 'undefined' && !reviewPlaying) $('rev-playpause').click();
    },
    cmdClose:  () => $('rev-exit').click(),
    cmdReplay: () => $('rev-restart').click(),
  },
  info: {
    cmdClose: () => $('info-close-btn').click(),
  },
  settings: {
    cmdClose: () => $('s-done-btn').click(),
  },
};

// Overlays take precedence over phase. Read-on-demand so handlers never
// dispatch into a stale screen (no separate context-tracking variable).
function vcCurrentContext() {
  if ($('welcome-overlay')  && $('welcome-overlay').classList.contains('open'))  return 'welcome';
  if ($('settings-overlay') && $('settings-overlay').classList.contains('open')) return 'settings';
  if ($('info-overlay')     && $('info-overlay').classList.contains('open'))     return 'info';
  if ($('review-overlay')   && $('review-overlay').classList.contains('open'))   return 'review';
  if (typeof phase === 'undefined') return 'ready';
  if (phase === 'work')       return 'practice';
  if (phase === 'rest-count') return 'rest';
  return phase; // 'ready' or 'break'
}

let vc = null;
let _vcTranscriptClearTimer = null;
let _voskScriptPromise = null;

// Per-session voice suppression. The user can choose "No thanks, I'll use
// the buttons" on the Welcome / Hello / Resume screens — that flips this
// flag for the rest of the session, even though the persistent
// `settings.voiceCommands` preference is unchanged. Toggling Settings →
// "Listen for voice commands" OFF then back ON clears it via
// vcOnSettingChange (the explicit toggle is the user's "yes, I want voice
// after all" signal).
let _vcSuppressedThisSession = false;
function setVoiceSessionSuppressed(suppressed) {
  _vcSuppressedThisSession = !!suppressed;
}

// Lazy-load vosk-browser.js (5.5 MB UMD bundle that exposes window.Vosk).
// Eager-loading via a <script> tag in index.html cost us ~6 MB of boot-time
// parse and a base64 worker source that never gets GC'd until the user opts
// in to voice. By the time the welcome overlay is asking the user whether
// they want voice at all, that cost has already crashed the iPhone PWA.
//
// UMD note: vosk-browser.js sets window.Vosk via the global-object branch of
// its UMD wrapper. ES dynamic import() would route into the exports/module
// branch and miss window.Vosk entirely — we use script-tag injection.
function loadVoskScript() {
  if (window.Vosk) return Promise.resolve();
  if (_voskScriptPromise) return _voskScriptPromise;
  _voskScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src   = 'js/vosk-browser.js';
    s.async = true;
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error('vosk-browser.js failed to load'));
    document.head.appendChild(s);
  });
  return _voskScriptPromise;
}

// ── Boot ──────────────────────────────────────────────────────────
function vcInit() {
  // One-time legacy cleanup: pre-Phase-1 voice-commands.js maintained its own
  // IDB cache at DB name 'voice-models' (~40 MB of dead tar.gz blob on
  // upgraded installs). Phase 1 dropped that path; Vosk now uses '/vosk' via
  // IDBFS. Fire-and-forget delete — no-op for fresh installs, idempotent.
  try { indexedDB.deleteDatabase('voice-models'); } catch (_) {}

  // The Vosk-dependent bits (window.Vosk + the createVoiceCommands instance
  // that depends on it) are constructed lazily inside vcKickOffLoad on first
  // opt-in — Get Started in welcome, or toggling the "Listen for voice
  // commands" switch on. Until then `vc` stays null and the Settings panel
  // shows "Idle".
  if (typeof createVoiceCommands !== 'function') {
    console.warn('[voice] shared lib not present — feature disabled');
    vcUpdateStatus('Not available');
    return;
  }
  vcUpdateStatus('Idle');
}

async function vcKickOffLoad() {
  if (typeof createVoiceCommands !== 'function') return;
  if (_vcSuppressedThisSession) return;
  if (vc && (vc.state === 'loading' || vc.state === 'ready' || vc.state === 'listening')) return;

  try {
    await loadVoskScript();
  } catch (e) {
    console.warn('[voice]', e.message);
    vcUpdateStatus('Error — script load failed');
    return;
  }

  if (!vc) {
    vc = createVoiceCommands({
      modelUrl:      VC_MODEL_URL,
      workletUrl:    VC_WORKLET_URL,
      commands:      vcBuildCommands(),
      strictGrammar: !!settings.limitVrVocab,
      onCommand:     vcOnCommand,
      onTranscript:  vcOnTranscript,
      onStateChange: vcOnStateChange,
      onError:       vcOnError,
    });
    if (!vc.supported) {
      console.warn('[voice] not supported in this browser');
      vcUpdateStatus('Not supported');
      vc = null;
      return;
    }
  }

  vc.load(); // fire-and-forget; state events drive UI
}

// ── State / loader UI ─────────────────────────────────────────────
// No granular progress callback yet — the Vosk worker owns fetch + extract
// internally and we haven't wired its log() messages to a percentage. Until
// then the loader is just an indeterminate "Loading voice assets…" overlay
// driven purely by state transitions. Worker chatter is logged via
// console.log('[vosk-worker]', ...) in voice-commands.js — capture the
// real format on desktop, then design the percentage UI from real output.
// Previous state tracker so we can distinguish meaningful transitions.
// Specifically: auto-start should fire on 'loading' → 'ready' (model
// finished loading after the user opted in), NOT on 'listening' → 'ready'
// (which is what vc.stop() does). Without this distinction, calling
// vcStop() during _onMaybeBackgrounded triggered an immediate auto-restart
// that left a stale pending vcStart in the microtask queue across the
// iOS suspension boundary — manifested as 'null is not an object' on
// vc.start at voice.js:409 when the page resumed minutes later.
let _vcLastState = null;

function vcOnStateChange(state) {
  const prev = _vcLastState;
  _vcLastState = state;

  const labels = {
    idle:       'Not loaded',
    loading:    'Loading…',
    ready:      'Ready',
    listening:  'Listening',
    error:      'Error — check console',
  };
  vcUpdateStatus(labels[state] || state);

  if (state === 'loading') {
    // Hide the loader if the welcome overlay is showing — the user is reading
    // and we don't want to compete for attention. closeWelcome() in ui.js
    // re-surfaces the loader if the load is still in flight at that point.
    const welcomeOpen = $('welcome-overlay') && $('welcome-overlay').classList.contains('open');
    if (!welcomeOpen) vcShowLoader();
    return;
  }

  vcHideLoader();

  // Auto-start ONLY on the 'loading' → 'ready' transition (model finished
  // loading after opt-in via Hello / Welcome / Settings toggle). The
  // 'listening' → 'ready' transition is what vc.stop() does — auto-starting
  // there would race with our explicit stop and leave a pending vcStart in
  // the queue across iOS suspension. The 'idle' → 'ready' transition
  // shouldn't happen in our flow today, but excluding it costs nothing.
  const justFinishedLoading = state === 'ready' && prev === 'loading';
  const shouldAutoStart = justFinishedLoading
    && micStream
    && settings.voiceCommands
    && !_vcSuppressedThisSession;
  console.log('[voice] state ' + prev + '→' + state +
              (shouldAutoStart ? ' (auto-start)' : ''));
  if (shouldAutoStart) {
    vcStart();
  }
}

function vcShowLoader() {
  const el = $('vc-loader');
  if (!el) return;
  el.hidden = false;
}
function vcHideLoader() {
  const el = $('vc-loader');
  if (el) el.hidden = true;
}

function vcUpdateStatus(text) {
  const el = $('s-vc-status');
  if (el) el.textContent = text;
}

// ── Transcript echo ───────────────────────────────────────────────
// Single-element display: anchored bottom-center by CSS, vertically
// centered with the settings + info icons. Shows partials and finals;
// the only thing settings.vcKeepLastWord changes is whether finals
// auto-clear after 2 seconds (off, default) or stay on-screen until
// the next recognition (on). Partials always auto-clear so they don't
// linger between utterances.
function vcOnTranscript(text, isFinal) {
  const el = $('vc-transcript');
  if (!el || !text) return;
  // Vosk's strict-grammar mode emits "[unk]" for utterances that don't match
  // any in-vocab phrase. The literal token is debug-friendly but visually
  // noisy for an end user — replace with "?" so the on-screen echo reads as
  // "I heard something, but it wasn't a command." Applies to both whole-string
  // and embedded occurrences (multi-word partials).
  const display = text.replace(/\[unk\]/g, '?');
  el.textContent = display;
  el.classList.add('visible');
  if (_vcTranscriptClearTimer) {
    clearTimeout(_vcTranscriptClearTimer);
    _vcTranscriptClearTimer = null;
  }
  if (!isFinal || !settings.vcKeepLastWord) {
    _vcTranscriptClearTimer = setTimeout(() => {
      el.classList.remove('visible');
      _vcTranscriptClearTimer = null;
    }, 2000);
  }
}

// ── Command dispatch ──────────────────────────────────────────────
function vcOnCommand(name, phrase) {
  const ctx = vcCurrentContext();
  console.debug(`[voice] command '${name}' from "${phrase}" in '${ctx}'`);
  const handlers = VOICE_CONTEXT_HANDLERS[ctx];
  if (!handlers) return;
  const fn = handlers[name];
  if (typeof fn !== 'function') return;
  try { fn(); } catch (e) { console.warn('[voice] handler error:', e); }
}

function vcOnError(err) {
  console.warn('[voice] error:', err);
}

// ── Start / stop ──────────────────────────────────────────────────
// Returns true if the recognizer reached the 'listening' state, false
// otherwise. Callers in the visibility-regain path use this signal to
// decide whether silent recovery succeeded or whether to escalate to a
// nuke + Resume modal — see ui.js _onMaybeForegrounded. After a long
// background, iOS can zombie the AudioWorklet processor independently
// of the AudioContext rendering thread, in which case the audioCtx
// health probe passes but vc.start() throws DataCloneError on the
// port-transfer postMessage. Surfacing the boolean lets the orchestrator
// recover instead of leaving voice silently dead.
async function vcStart() {
  if (!vc || !settings.voiceCommands) return false;
  if (_vcSuppressedThisSession) return false;
  if (vc.state !== 'ready') return false;
  // ensureAudio + acquireMic both require a user-gesture context on iOS;
  // this may bail silently before the first tap. Callers retry on the next
  // gesture (Get Started → closeWelcome, Start Practice → _enterPhase,
  // visibility regain, settings toggle).
  await ensureAudio();
  // Defensive null re-check: vc may have been cleared by a concurrent
  // path (vcDestroy from the orchestrator's escalation, or a stale
  // pending vcStart from before iOS suspension). Each await is a
  // microtask boundary where ANY other code can run.
  if (!vc || vc.state !== 'ready') return false;
  if (!micStream) {
    const ok = await acquireMic();
    if (!ok) return false;
    if (!vc || vc.state !== 'ready') return false;
  }
  try {
    await vc.start(audioCtx, micStream);
    return !!vc && vc.state === 'listening';
  } catch (e) {
    console.warn('[voice] start failed:', e);
    return false;
  }
}

function vcStop() {
  if (!vc) return;
  if (vc.state === 'listening') vc.stop();
  // Hide the live transcript immediately
  const el = $('vc-transcript');
  if (el) el.classList.remove('visible');
}

// Tear down the voice-commands instance entirely, freeing the ~80MB
// Vosk WASM heap and detaching the worker. Used as a recovery escalation
// when vcStart fails post-background — discarding vc forces vcKickOffLoad
// to rebuild from scratch on the next attempt (model reads from /vosk
// IDB cache, ~0.6s, no network). Brief ~150MB peak during the heap
// swap; within iOS PWA budget. Idempotent.
function vcDestroy() {
  if (!vc) return;
  try { vc.destroy(); } catch (_) {}
  vc = null;
  _vcLastState = null;
  vcUpdateStatus('Idle');
}

// Heavy hammer: destroy vc, delete /vosk IDB, then re-init via
// vcKickOffLoad. Forces a fresh network download and full re-extract
// of the model — same code path as the manual "Wipe cache" diagnostic
// button. Used when a normal vcDestroy + vcKickOffLoad rebuild is
// suspected of carrying over corrupted worker state across iOS
// suspension. Falls back to a cache-only reload if the IDB delete
// fails (e.g., user is offline).
function vcWipeAndRebuild() {
  if (vc) {
    try { vc.destroy(); } catch (_) {}
    vc = null;
  }
  _vcLastState = null;
  vcUpdateStatus('Idle');
  const tryReload = (note) => {
    console.log('[voice] ' + note);
    if (settings.voiceCommands && !_vcSuppressedThisSession) vcKickOffLoad();
  };
  try {
    const req = indexedDB.deleteDatabase('/vosk');
    req.onsuccess = () => tryReload('wiped /vosk IDB (resume heavy rebuild)');
    req.onerror   = () => tryReload('wipe /vosk IDB failed, falling back to cache reload');
    req.onblocked = () => tryReload('wipe /vosk IDB blocked, falling back to cache reload');
  } catch (e) {
    tryReload('wipe /vosk IDB threw, falling back to cache reload');
  }
}

// ── Settings change handlers (called from ui.js) ──────────────────
function vcOnSettingChange(name) {
  if (name === 'vcKeepLastWord') {
    // No recognizer rebuild. If turning the toggle off and a final word
    // is currently held on-screen (no clear timer), schedule a normal
    // 2s clear so it fades out naturally.
    if (!settings.vcKeepLastWord && !_vcTranscriptClearTimer) {
      const el = $('vc-transcript');
      if (el && el.classList.contains('visible')) {
        _vcTranscriptClearTimer = setTimeout(() => {
          el.classList.remove('visible');
          _vcTranscriptClearTimer = null;
        }, 2000);
      }
    }
    return;
  }
  if (name === 'voiceCommands') {
    if (settings.voiceCommands) {
      // The explicit Settings toggle ON is the user's "yes, voice after
      // all" signal — clear any per-session suppression from a previous
      // "No thanks" choice on Welcome / Hello / Resume.
      _vcSuppressedThisSession = false;
      // If the model is already loaded (toggled-off-then-on), there's no
      // state change to drive vcOnStateChange's auto-start, so kick off
      // listening directly. The toggle click itself is a user gesture, so
      // ensureAudio + acquireMic inside vcStart will succeed on iOS.
      // Don't fold this into vcOnStateChange thinking it's redundant —
      // there's no state event when state stays 'ready'.
      if (vc && vc.state === 'ready') vcStart();
      else vcKickOffLoad();
    } else {
      if (vc) vcStop();
      // No cancel-mid-load: Vosk owns the load now and doesn't expose an
      // abort. The worst case is we loaded the model and the user never
      // listens — harmless on memory (Model is alive but idle); they can
      // toggle back on without re-loading.
    }
    return;
  }

  if (!vc) return;  // vrGood/vrBad/limitVrVocab only matter once vc exists

  if (name === 'limitVrVocab' || name === 'vrGood' || name === 'vrBad') {
    // Recognizer-only rebuild — keeps the Model (and its ~80 MB WASM heap)
    // alive across the toggle. Was the 150 MB transient cliff per change.
    vc.setCommands(vcBuildCommands(), !!settings.limitVrVocab);
  }
}

// ── Boot wiring (Diagnostics buttons) ─────────────────────────────
function vcWireUI() {
  // Hidden "Wipe voice cache" debug button: deletes Vosk's IDBFS database
  // outright, forcing a fresh ~40 MB download on the next vc.load(). For
  // debugging only — corrupt cache, model URL changed, or testing the
  // cold-launch path. Doesn't need to be discoverable.
  const wipeBtn = $('s-vc-wipe-cache');
  if (wipeBtn) {
    wipeBtn.addEventListener('click', () => {
      if (vc) {
        try { vc.destroy(); } catch (e) {}
        vc = null;
      }
      try {
        const req = indexedDB.deleteDatabase('/vosk');
        req.onsuccess = () => {
          console.log('[voice] wiped /vosk IDB');
          // Auto-reload once the wipe completes so the user isn't left
          // with voice in a dead state. The IDB delete resolves async, so
          // this lives inside onsuccess (not after the try block) — at the
          // earlier point the cache might not yet be gone, and a re-load
          // could race with the deletion. With voice toggled off, skip the
          // reload — the user wanted voice off; respect that.
          if (settings.voiceCommands) vcKickOffLoad();
        };
        req.onerror   = () => console.warn('[voice] wipe /vosk IDB failed:', req.error);
      } catch (e) {
        console.warn('[voice] wipe /vosk IDB threw:', e);
      }
      vcUpdateStatus('Idle');
    });
  }

  // Phase 2 experiment button removed — auto-unlink is now in vc.load() per
  // the 2026-05-08 desktop verification. The vc.unlinkExtracted() lib API
  // stays available for future debugging if a deploy ever ships an
  // unpatched vosk-browser.js.
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { vcInit(); vcWireUI(); });
} else {
  vcInit();
  vcWireUI();
}

// Visibility-driven start/stop is now orchestrated by ui.js, not here.
// ui.js's _onMaybeBackgrounded calls vcStop() on hidden, and
// _onMaybeForegrounded calls vcStart() on visible if AudioContext +
// mic are both probed healthy (or routes through Resume otherwise).
//
// The previous "first-gesture warm-up" (a global pointerdown listener
// that called acquireMic on any tap) was removed: mic acquisition now
// only happens through explicit user buttons — Welcome / Hello / Resume
// + the Settings "Listen for voice commands" toggle + Start Practice.
// That eliminates the random-touch mic-prompt surprise.

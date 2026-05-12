'use strict';

// =================================================
// REPETITION COUNTER
// State machine: hidden | collapsed | expanded
// - Visible only during 'work' phase (icon at bottom-center)
// - Successes persist across work phases within the same chunk
// - Successes reset at start of REST phase
// - Target persists across sessions (localStorage)
// - Panel-open state persists across work phases within the chunk;
//   panel is forced closed during phase transitions, but if it was
//   open in the previous work phase it auto-reopens at the next.
// =================================================

const RC_STORAGE_KEY = 'mb_rep_target';
const RC_TARGET_DEFAULT = 7;
const RC_TARGET_MIN = 1;
const RC_TARGET_MAX = 10;

let rcTarget    = RC_TARGET_DEFAULT;
let rcClaimed   = 0;       // number of green dots
let rcExpanded  = false;   // is the panel open right now
let rcWantOpen  = false;   // user's intent — re-applied when re-entering work
let rcCelebrating = false; // briefly true after final dot, before auto-collapse

(function loadTarget() {
  try {
    const raw = localStorage.getItem(RC_STORAGE_KEY);
    const n   = parseInt(raw, 10);
    if (!isNaN(n) && n >= RC_TARGET_MIN && n <= RC_TARGET_MAX) rcTarget = n;
  } catch(e) {}
})();
function rcSaveTarget() {
  try { localStorage.setItem(RC_STORAGE_KEY, String(rcTarget)); } catch(e) {}
}

// ── DOM glyphs (shared dome wrappers from _shared/design/glyph-disc.css;
//    glyph paths from _shared/design/icons/icon-glyph-{check,x}.svg) ──
const RC_DOT_GRAY =
  '<div class="prog-circle prog-empty"></div>';
const RC_DOT_GREEN =
  '<div class="prog-circle prog-correct">' +
  '<svg width="20" height="20" viewBox="0 0 28 28" fill="none">' +
  '<use href="#icon-glyph-check"/>' +
  '</svg>' +
  '</div>';

// ── Sounds ──
// chimeSuccess() lives in js/chime-success.js (shared from _shared/js/).
// Local guards (audioUnlocked, notifyVol) stay at the call site.

function rcPlayTick(freq) {
  // Brief, slightly dulled click. Default freq is the success-rep tick;
  // pass an explicit freq (e.g. an octave higher) for stepper feedback.
  if (!audioUnlocked) return;
  if ((parseFloat(settings.notifyVol) || 0) === 0) return;
  const ctx = audioCtx;
  const t   = ctx.currentTime;
  const dur = 0.045;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'triangle';
  o.frequency.setValueAtTime(freq || 720, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.08, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(masterGain || ctx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

function rcPlayWhimper() {
  // Sad two-syllable descending whine — short "uh" then longer "uhhh"
  // with vibrato. Triangle wave for a vocal quality without sounding harsh.
  if (!audioUnlocked) return;
  if ((parseFloat(settings.notifyVol) || 0) === 0) return;
  const ctx = audioCtx;
  const t0  = ctx.currentTime;

  function seg(startT, dur, fStart, fEnd, peakGain, vibDepth) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(fStart, startT);
    o.frequency.exponentialRampToValueAtTime(fEnd, startT + dur);
    g.gain.setValueAtTime(0, startT);
    g.gain.linearRampToValueAtTime(peakGain, startT + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, startT + dur);
    o.connect(g); g.connect(masterGain || ctx.destination);
    o.start(startT); o.stop(startT + dur + 0.02);

    if (vibDepth > 0) {
      const lfo  = ctx.createOscillator();
      const lfoG = ctx.createGain();
      lfo.frequency.value = 6.5;
      lfoG.gain.value     = vibDepth;
      lfo.connect(lfoG); lfoG.connect(o.frequency);
      lfo.start(startT); lfo.stop(startT + dur + 0.02);
    }
  }

  seg(t0, 0.55, 320, 160, 0.10, 8);  // single descending whine, ~E4 → E3 with vibrato
}

function rcPlaySwoosh(rising) {
  // Quiet filtered-noise burst, ~150 ms, sweeping up (open) or down (close).
  if (!audioUnlocked) return;
  if ((parseFloat(settings.notifyVol) || 0) === 0) return;
  const ctx = audioCtx;
  const t   = ctx.currentTime;
  const dur = 0.16;

  const len = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1);

  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = 'bandpass';
  filt.Q.value = 1.4;
  filt.frequency.setValueAtTime(rising ? 600 : 2400, t);
  filt.frequency.exponentialRampToValueAtTime(rising ? 2800 : 500, t + dur);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.10, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  src.connect(filt); filt.connect(g); g.connect(masterGain || ctx.destination);
  src.start(t); src.stop(t + dur + 0.02);
}

// ── Haptics (no-op on iOS Safari; works on Android/Chrome PWA) ──
function rcHaptic(pattern) {
  if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch(e) {} }
}

// ── DOM build / render ──
function rcBuildCircles() {
  const host = $('rc-circles');
  host.innerHTML = '';
  for (let i = 0; i < rcTarget; i++) {
    const b = document.createElement('button');
    b.className = 'rc-dot';
    b.type = 'button';
    b.dataset.i = i;
    b.setAttribute('aria-label', `Rep ${i + 1}`);
    b.innerHTML = RC_DOT_GRAY;
    host.appendChild(b);
  }
  rcRefreshDots();
}
function rcRefreshDots() {
  const host = $('rc-circles');
  if (!host) return;
  const dots = host.querySelectorAll('.rc-dot');
  dots.forEach((dot, i) => {
    const claimed = i < rcClaimed;
    const wasClaimed = dot.dataset.claimed === '1';
    if (claimed && !wasClaimed) {
      dot.innerHTML = RC_DOT_GREEN;
      dot.dataset.claimed = '1';
      dot.setAttribute('aria-label', `Rep ${i + 1} successful`);
    } else if (!claimed && wasClaimed) {
      dot.innerHTML = RC_DOT_GRAY;
      dot.dataset.claimed = '0';
      dot.setAttribute('aria-label', `Rep ${i + 1}`);
    }
  });
  $('rc-minus').disabled = rcTarget <= RC_TARGET_MIN;
  $('rc-plus').disabled  = rcTarget >= RC_TARGET_MAX;
}

// ── Visibility (called from render() and from overlay open/close) ──
function rcUpdateVisibility() {
  const inWork = (typeof phase !== 'undefined') && phase === 'work';
  const anyOverlay =
    $('info-overlay').classList.contains('open') ||
    $('settings-overlay').classList.contains('open') ||
    $('review-overlay').classList.contains('open') ||
    $('welcome-overlay').classList.contains('open');

  const showIcon = inWork && !anyOverlay;
  const btn = $('rc-toggle-btn');
  if (btn) btn.hidden = !showIcon;

  // Auto-collapse panel whenever we leave work (or an overlay opens),
  // but remember that user wanted it open so we can re-open next time.
  const panelShouldShow = inWork && !anyOverlay && rcExpanded;
  rcApplyPanelVisibility(panelShouldShow);

  // Toggle-btn color reflects the actual rendered panel state
  if (btn) btn.classList.toggle('expanded', panelShouldShow);

  // Congrats message piggy-backs on the panel — visible only while
  // celebrating *and* the panel itself is on-screen. Now position:fixed
  // (lives outside #app to escape mid-section's overflow:hidden); we anchor
  // it to the panel rect every time we show it.
  const congrats = $('rc-congrats');
  if (congrats) {
    const showCongrats = rcCelebrating && panelShouldShow;
    congrats.classList.toggle('visible', showCongrats);
    if (showCongrats) {
      const panel = $('rep-counter-panel');
      if (panel) {
        const r = panel.getBoundingClientRect();
        // Center horizontally on the panel, sit ~12px below it.
        congrats.style.left = `${r.left + r.width / 2}px`;
        congrats.style.top  = `${r.bottom + 12}px`;
        congrats.style.transform = 'translateX(-50%)';
      }
    }
  }

  // Voice listening is no longer tied to the rep-counter panel — it runs
  // continuously while voiceCommands is enabled and the model is ready.
  // Per-screen command routing happens in voice.js (vcCurrentContext +
  // VOICE_CONTEXT_HANDLERS).
}

function rcApplyPanelVisibility(show) {
  const panel = $('rep-counter-panel');
  if (!panel) return;
  if (show) {
    panel.hidden = false;
    // Force reflow so transition fires from the closed state
    void panel.offsetWidth;
    panel.classList.add('open');
  } else {
    panel.classList.remove('open');
    // Hide after transition so the layout collapses cleanly
    setTimeout(() => {
      const stillClosed = !panel.classList.contains('open');
      if (stillClosed) panel.hidden = true;
    }, 220);
  }
}

// ── User actions ──
function rcToggleExpand() {
  ensureAudio();
  rcExpanded = !rcExpanded;
  rcWantOpen = rcExpanded;
  rcPlaySwoosh(rcExpanded);
  rcUpdateVisibility();
}

function rcCelebrate() {
  if (rcCelebrating) return;
  rcCelebrating = true;
  ensureAudio();
  if (audioUnlocked && (parseFloat(settings.notifyVol) || 0) !== 0) {
    chimeSuccess(audioCtx, masterGain || audioCtx.destination);
  }
  rcUpdateVisibility(); // reveal "Congratulations!"
  // Hold the celebration long enough for the boxing-bell to mostly ring out
  // before the swoosh-collapse so the two cues don't step on each other.
  setTimeout(() => {
    rcClaimed = 0;
    rcCelebrating = false;
    rcRefreshDots();
    rcWantOpen = false; // celebration ends the open-intent regardless of how we got here
    if (rcExpanded) {
      rcExpanded = false;
      rcPlaySwoosh(false);
    }
    rcUpdateVisibility(); // hides congrats + panel together
  }, 2200);
}

function rcClaimNext() {
  if (rcCelebrating) return;
  if (rcClaimed >= rcTarget) return;
  rcClaimed++;
  rcRefreshDots();
  ensureAudio();
  rcPlayTick(1440); // higher tick celebrates each successful rep
  rcHaptic(15);
  if (rcClaimed >= rcTarget) rcCelebrate();
}

function rcClearAll() {
  if (rcCelebrating) return;
  if (rcClaimed === 0) return;
  rcClaimed = 0;
  rcRefreshDots();
  ensureAudio();
  rcPlayWhimper();
  rcHaptic([30, 40, 30]);
}

function rcAdjustTarget(delta) {
  if (rcCelebrating) return;
  const next = Math.max(RC_TARGET_MIN, Math.min(RC_TARGET_MAX, rcTarget + delta));
  if (next === rcTarget) return;
  rcTarget = next;
  rcSaveTarget();
  ensureAudio();
  rcPlayTick(720); // lower, less attention-getting tick for stepper changes
  // Shrinking the target to (or below) the current claimed count counts as
  // a completed set — celebrate just as if the user had tapped the last dot.
  if (rcClaimed > rcTarget) rcClaimed = rcTarget;
  rcBuildCircles();
  if (rcClaimed >= rcTarget) rcCelebrate();
}

// ── Phase-change hook (called from timer.js _enterPhase + render flow) ──
// Resets successes only at the *start* of REST. Re-applies user's open-intent
// when re-entering work.
function rcOnPhaseChange(newPhase) {
  if (newPhase === 'rest-count') {
    rcClaimed = 0;
    rcExpanded = false;
    rcRefreshDots();
  } else if (newPhase === 'work') {
    rcExpanded = rcWantOpen;
  } else {
    // ready / break — close the panel but remember intent
    rcExpanded = false;
  }
  rcUpdateVisibility();
}

// ── Wiring ──
// Click routing rule: green-claim hit area ends at the right edge of the
// gray-circles grid. Anything to the right of that — including panel padding,
// the X button, and the empty space between the panel and the screen edge —
// counts as a clear. Listener lives on #lower-zone so the X-clear hit area
// extends out to the edge of the lower zone, not just the panel.
function rcOnZoneClick(e) {
  if (!$('rep-counter-panel').classList.contains('open')) return;
  // Skip targets that already have their own handlers.
  if (e.target.closest('.rc-stepper, #rc-toggle-btn, #review-btn, #review-slot-lower, #rc-congrats, #message')) return;
  // The X has its own click handler — let it run, don't double-fire.
  if (e.target.closest('#rc-clear')) return;

  const circles = $('rc-circles');
  const panel   = $('rep-counter-panel');
  if (!circles || !panel) return;

  const cRect = circles.getBoundingClientRect();
  const pRect = panel.getBoundingClientRect();

  // Restrict to the panel's vertical band (small fuzz for fingers landing slightly above/below).
  if (e.clientY < pRect.top - 12 || e.clientY > pRect.bottom + 12) return;

  // Right of circles' right edge → clear (extends out to right edge of #lower-zone).
  if (e.clientX > cRect.right) { rcClearAll(); return; }
  // Within the panel up to circles' right edge → claim.
  if (e.clientX >= pRect.left) { rcClaimNext(); }
}

function rcInit() {
  rcBuildCircles();
  $('rc-toggle-btn').addEventListener('click', rcToggleExpand);
  $('rc-plus').addEventListener('click',  e => { rcAdjustTarget(+1); e.currentTarget.blur(); });
  $('rc-minus').addEventListener('click', e => { rcAdjustTarget(-1); e.currentTarget.blur(); });
  $('rc-clear').addEventListener('click', e => { rcClearAll();        e.currentTarget.blur(); });
  $('lower-zone').addEventListener('click', rcOnZoneClick);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', rcInit);
} else {
  rcInit();
}

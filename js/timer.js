'use strict';

// =================================================
// STATE MACHINE
// =================================================
let phase         = 'ready';
let isPaused      = false;
let phaseTimeLeft = 0;
// When autoAdvance is off and timer hits 0, we enter "waiting" state:
// the ring shows "ready" text, and play or skip both advance.
let waitingToAdvance = false;

let currentRound     = 0;
let practiceTime     = 0;   // seconds of active practice accumulated this chunk
let chunkStartTime   = null;

let lastPracticeTime = 0;   // saved at chunk end — for REST summary
let lastChunkElapsed = 0;   // wall-clock seconds at chunk end — for REST summary
let lastChunkDur     = 0;   // settings.chunkDur at chunk end — for REST summary

let cntFired        = {3:false, 2:false, 1:false};
let milestonesFired = {1:false, 2:false, 3:false};
let msgIndex   = 0;
let lastTickTime = null;
let rafId        = null;

function startChunk() {
  currentRound     = 0;
  practiceTime     = 0;
  chunkStartTime   = Date.now();
  waitingToAdvance = false;
  milestonesFired  = {1:false, 2:false, 3:false};
  _enterPhase('work');
}

function _enterPhase(p) {
  phase            = p;
  isPaused         = false;
  waitingToAdvance = false;
  cntFired         = {3:false, 2:false, 1:false};

  // Notify rep-counter so it can reset successes at REST or re-open at work
  if (typeof rcOnPhaseChange === 'function') rcOnPhaseChange(p);

  // Idempotent voice retry — bails if already listening or not enabled. By
  // the time _enterPhase runs, audio is unlocked and mic is acquired (Start
  // Practice took care of both), so a vcStart that failed earlier (during
  // welcome/ready, before any user gesture) can succeed now.
  if (typeof vcStart === 'function') vcStart();

  // Render immediately so background color changes without waiting for next RAF tick
  render();

  if (p === 'work') {
    phaseTimeLeft = settings.workDur;
    // Play the bell first, then start recording — recorder is deferred inside
    // startRecording() so the bell tail isn't captured. If mic isn't yet
    // acquired, the bell plays inside the acquireMic promise after ctx resumes.
    const _hadMic = !!micStream;
    if (audioUnlocked && _hadMic) playWorkStart();
    startRecording();
  } else if (p === 'break') {
    phaseTimeLeft = settings.breakDur;
    stopRecording();
    msgIndex = (msgIndex + 1) % Math.max(1, settings.messages.length);
    // playBreakStart() is called by _advance() before entering this phase
  } else if (p === 'rest-count') {
    // Break is the only phase where review-btn is reachable (render.js
    // gates it on `phase === 'break'`). Once we leave break — whether to
    // the next work round or to rest-count — the prior round's recording
    // is no longer reachable to the user, so free it now rather than let
    // it linger across the entire rest phase.
    if (typeof clearReviewBlob === 'function') clearReviewBlob();
    phaseTimeLeft = settings.restDur;
  } else if (p === 'ready') {
    phaseTimeLeft = 0;
    if (typeof clearReviewBlob === 'function') clearReviewBlob();
    recChunks = [];
  }

  lastTickTime = null;
  render();
}

function _advance(force) {
  // force=true: user manually skipped — always transition.
  // force=false: timer expired naturally — autoAdvance only applies to work phase.
  const workAuto = force || settings.autoAdvance;

  waitingToAdvance = false;

  if (phase === 'work') {
    if (!workAuto) {
      // Don't play chime yet — wait until user actually advances to break
      waitingToAdvance = true;
      if (practiceTime >= 3 * settings.chunkDur && audioUnlocked) playAsleepDing();
      render(); return;
    }
    if (audioUnlocked) playBreakStart();
    _enterPhase('break');
  } else if (phase === 'break') {
    if (practiceTime >= settings.chunkDur) {
      // Chunk budget reached — save summary stats before entering rest
      lastPracticeTime = practiceTime;
      lastChunkElapsed = chunkStartTime ? (Date.now() - chunkStartTime) / 1000 : 0;
      lastChunkDur     = settings.chunkDur;
      stopRecording();
      if (audioUnlocked) playFinalGong();
      lastTickTime = null;
      _enterPhase('rest-count');
    } else {
      if (!workAuto) {
        // Wait for user to tap before starting next round
        waitingToAdvance = true;
        render(); return;
      }
      // Keep going — start next round
      currentRound++;
      _enterPhase('work');
    }
  } else if (phase === 'rest-count') {
    if (audioUnlocked) playBackToWork();
    _enterPhase('ready');
  }
}

function togglePlayPause() {
  if (phase === 'ready') return;
  // If waiting for manual advance (autoAdvance=off, timer=0), advance now
  if (waitingToAdvance) { _advance(true); return; }
  isPaused = !isPaused;
  if (!isPaused) lastTickTime = null;
  render();
}

function restartPhase() {
  if (phase === 'ready') return;
  waitingToAdvance = false;
  if (phase === 'rest-count') {
    phaseTimeLeft = settings.restDur;
    cntFired = {3:false, 2:false, 1:false};
    isPaused = false; lastTickTime = null; render(); return;
  }
  const phaseDur = phase === 'work' ? settings.workDur : settings.breakDur;
  phaseTimeLeft = phaseDur;
  cntFired = {3:false, 2:false, 1:false};
  if (phase === 'work') { stopRecording(); startRecording(); }
  isPaused = false; lastTickTime = null; render();
}

function skipNext() {
  if (phase === 'ready') return;
  phaseTimeLeft = 0;
  isPaused = false;
  _advance(true);
}

// =================================================
// RAF TICK
// =================================================
const RING_R = 110;
const RING_C = +(2 * Math.PI * RING_R).toFixed(3); // 691.150

function tick(now) {
  rafId = requestAnimationFrame(tick);

  // Always re-render during a chunk so wall-clock elapsed time stays live
  // even while paused, in settings, or in review overlay
  if (phase === 'work' || phase === 'break') render();

  if (lastTickTime === null) { lastTickTime = now; return; }
  const dt = Math.min((now - lastTickTime) / 1000, 0.25);
  lastTickTime = now;

  if (isPaused || phase === 'ready') return;

  // practiceTime keeps accumulating even when waitingToAdvance — the user is
  // still playing; only the phase-transition timer is frozen.
  if (phase === 'work') {
    practiceTime += dt;
  } else if (phase === 'break' && settings.breaksCountAsPractice) {
    practiceTime += dt;
  }

  // Bell when bar fills to 100% at each chunkDur multiple
  if (phase === 'work' || (phase === 'break' && settings.breaksCountAsPractice)) {
    const C = settings.chunkDur;
    [1, 2, 3].forEach(n => {
      const tgt = n * C;
      if (!milestonesFired[n] && practiceTime >= tgt && practiceTime - dt < tgt) {
        milestonesFired[n] = true;
        if (audioUnlocked) playWorkStart();
      }
    });
  }

  if (waitingToAdvance) { render(); return; }

  [3, 2, 1].forEach(n => {
    if (!cntFired[n] && phaseTimeLeft > 0 && phaseTimeLeft - dt <= n && phaseTimeLeft > n - 0.05) {
      cntFired[n] = true;
      if (audioUnlocked) playCountdownBeep(n);
    }
  });

  phaseTimeLeft -= dt;

  if (phaseTimeLeft <= 0) { phaseTimeLeft = 0; _advance(false); }
  else render();
}

'use strict';

// =================================================
// DOM REFS & RENDER
// =================================================
const $ = id => document.getElementById(id);

const elApp          = $('app');
const elPhaseLabel   = $('phase-label');
const elProgressSec  = $('progress-section');
const elMacroBar     = $('macro-bar');
const elTimeProgress = $('time-progress');
const elRestQ        = $('rest-questions');
const elRestReport   = $('rest-report');
const elRoundCtr     = $('round-counter');
const elRingFg       = $('ring-fg');
const elTimeDisplay  = $('time-display');
const elReadyRing    = $('ready-ring-text');
const elMessage      = $('message');
const elControls     = $('controls');
const elStartBtn     = $('start-btn');
const elReviewBtn    = $('review-btn');
const elIconPlay     = $('pp-icon-play');
const elIconPause    = $('pp-icon-pause');

function fmt(sec) {
  const s = Math.max(0, Math.ceil(sec));
  return Math.floor(s/60) + ':' + (s%60).toString().padStart(2,'0');
}
function fmtF(sec) {
  const s = Math.max(0, Math.floor(sec));
  return Math.floor(s/60) + ':' + (s%60).toString().padStart(2,'0');
}

function render() {
  if (welcomeIsOpen) return;

  const isReady = phase === 'ready';
  const isRest  = phase === 'rest-count';
  const isWork  = phase === 'work';
  const isBreak = phase === 'break';
  const inChunk = isWork || isBreak;

  // Background — values mirror design tokens: --color-orange / --color-blue-break / --color-bg-surface
  //              edge: --color-orange-edge / --color-blue-break-dark / --color-bg-dark
  const bg     = isWork ? '#b83c08' : isBreak ? '#141560' : '#1e1e1e';
  const bgEdge = isWork ? '#4d1903' : isBreak ? '#080928' : '#0d0d0d';
  elApp.style.backgroundColor = bg;
  if (!$('review-overlay').classList.contains('open') && !$('settings-overlay').classList.contains('open')) {
    $('bg-fill').style.backgroundColor = bgEdge;
    document.body.style.backgroundColor = bgEdge;
    document.documentElement.style.backgroundColor = bgEdge;
    $('meta-theme').setAttribute('content', bgEdge);
  }

  // Phase label
  elPhaseLabel.textContent =
    isReady ? '' : isRest ? 'Rest' : isWork ? 'Practice' : 'Micro-break';

  // Progress bar
  elProgressSec.style.visibility = inChunk ? 'visible' : 'hidden';
  if (inChunk) {
    const C  = settings.chunkDur;
    const pt = practiceTime;

    // Layered single bar: white → black → yellow as overage grows
    const elOvBlack  = $('overage-bar-black');
    const elOvYellow = $('overage-bar-yellow');
    if (pt <= C) {
      elMacroBar.style.width  = (pt / C * 100).toFixed(1) + '%';
      elOvBlack.style.width   = '0%';
      elOvYellow.style.width  = '0%';
    } else if (pt <= 2 * C) {
      elMacroBar.style.width  = '100%';
      elOvBlack.style.width   = ((pt - C) / C * 100).toFixed(1) + '%';
      elOvYellow.style.width  = '0%';
    } else {
      elMacroBar.style.width  = '100%';
      elOvBlack.style.width   = '100%';
      elOvYellow.style.width  = Math.min(100, (pt - 2*C) / C * 100).toFixed(1) + '%';
    }

    // Text: practiceTime of chunkDur
    elTimeProgress.innerHTML = '<strong>' + fmtF(pt) + '</strong> of ' + fmt(C);
  }

  // Rest questions
  elRestQ.style.display = (isReady || isRest) ? 'flex' : 'none';
  if (isReady || isRest) {
    const ps = elRestQ.querySelectorAll('p');
    const q  = settings.restQ || ['', '', ''];
    for (let i = 0; i < 3; i++) {
      if (ps[i]) { ps[i].textContent = q[i] || ''; ps[i].style.display = q[i] ? '' : 'none'; }
    }
  }

  // Chunk summary (shown on ready screen after first chunk completes)
  const showSummary = isReady && lastChunkDur > 0;
  $('chunk-summary').style.display = showSummary ? 'block' : 'none';
  if (showSummary) {
    let html = 'Previous chunk: <strong>' + fmtF(lastPracticeTime) + '</strong> of ' + fmt(lastChunkDur);
    if (!settings.breaksCountAsPractice) {
      html += '<br>Elapsed time: ' + fmtF(lastChunkElapsed);
    }
    $('chunk-summary').innerHTML = html;
  }

  // Round counter
  elRoundCtr.innerHTML = inChunk ? 'Round<br>' + (currentRound + 1) : '';

  // Ring visibility
  const ringOpacity = isReady ? '0' : '1';
  $('ring-bg').style.opacity = ringOpacity;
  elRingFg.style.opacity     = ringOpacity;

  // Ring time display vs "ready" text
  // In waitingToAdvance state, show "ready" instead of time
  const showReady = isReady || waitingToAdvance;
  elTimeDisplay.style.display = (!showReady && (isWork || isBreak || isRest)) ? 'block' : 'none';
  elReadyRing.style.display   = showReady ? 'block' : 'none';
  elReadyRing.textContent     = waitingToAdvance
    ? (practiceTime >= 3 * settings.chunkDur ? 'Asleep?' : (phase === 'break' ? 'Ready?' : 'Done?'))
    : 'Ready?';
  // Also show the ring strokes when waitingToAdvance (they're hidden in isReady)
  if (waitingToAdvance) {
    $('ring-bg').style.opacity = '1';
    elRingFg.style.opacity     = '1';
  }

  if (!showReady && (isWork || isBreak || isRest)) {
    const total  = isWork ? settings.workDur : isBreak ? settings.breakDur : settings.restDur;
    const frac   = total > 0 ? phaseTimeLeft / total : 0;
    elRingFg.style.strokeDashoffset =
      (RING_C * (1 - Math.min(1, Math.max(0, frac)))).toFixed(3);
    elTimeDisplay.textContent = fmt(phaseTimeLeft);
  }
  if (waitingToAdvance) {
    // Ring fully depleted
    elRingFg.style.strokeDashoffset = RING_C.toFixed(3);
  }

  // Rest report (below ring, in review-slot area)
  const showReport = isRest && lastChunkDur > 0;
  elRestReport.style.display = showReport ? 'block' : 'none';
  if (showReport) {
    elRestReport.innerHTML =
      'Last chunk: ' + fmt(lastChunkDur) + '<br>' +
      fmtF(lastPracticeTime) + ' practice time<br>' +
      fmtF(lastChunkElapsed) + ' clock time';
  }

  // Message (break hints only)
  if (isBreak && settings.messages.length) {
    elMessage.textContent = settings.messages[msgIndex % settings.messages.length];
  } else {
    elMessage.textContent = '';
  }

  // Controls vs Start button
  if (isReady) {
    elControls.style.display = 'none';
    elStartBtn.style.display = 'flex';
  } else {
    elControls.style.display = 'flex';
    elStartBtn.style.display = 'none';
  }

  // Play/pause icon — show play when paused OR waiting to advance
  const showPlay = isPaused || isReady || waitingToAdvance;
  elIconPlay.style.display  = showPlay ? 'block' : 'none';
  elIconPause.style.display = showPlay ? 'none'  : 'block';

  // Review button
  elReviewBtn.style.display = (settings.recording && isBreak && reviewBlob) ? 'flex' : 'none';

  // Close / info buttons
  const hideClose = isReady || isRest;
  $('close-btn').style.opacity       = hideClose ? '0' : '1';
  $('close-btn').style.pointerEvents = hideClose ? 'none' : 'auto';
  const showInfo = isReady || isRest;
  $('info-btn').style.opacity       = showInfo ? '1' : '0';
  $('info-btn').style.pointerEvents = showInfo ? 'auto' : 'none';

  // Repetition counter visibility (work-phase only, hidden under overlays)
  if (typeof rcUpdateVisibility === 'function') rcUpdateVisibility();
}

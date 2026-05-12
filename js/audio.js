'use strict';

// =================================================
// AUDIO ENGINE — app-specific synth functions
// Depends on: audioCtx, audioUnlocked, masterGain (audio-ctx.js)
//             settings (settings.js)
// =================================================

function updateMasterGain() {
  if (masterGain) {
    // Global 0.8x attenuation — every sound is 20% quieter than the per-sound gains imply.
    masterGain.gain.value = ((parseFloat(settings.notifyVol) || 0.35) / 0.35) * 0.8;
  }
}

function beep(freq, dur, gain, type, delay) {
  if (!audioUnlocked) return;
  if ((parseFloat(settings.notifyVol) || 0) === 0) return;
  const ctx = audioCtx;
  const t = ctx.currentTime + (delay || 0);
  const g = ctx.createGain();
  const o = ctx.createOscillator();
  o.type = type || 'sine';
  o.frequency.value = freq;
  // Per-note gain envelope — masterGain handles overall volume scaling
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain || 0.32, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(masterGain || ctx.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

function playCountdownBeep(n) { beep(n === 1 ? 1047 : 880, 0.40, 0.28); } // 880=A5, 1047=C6

function playWorkStart() {
  // Boxing ring bell: A5 (880Hz), single strike, 2.5s decay
  const freq = 880; // A5 (boxing bell fundamental)
  const dur  = 2.5;
  const gain = 0.12; // fundamental gain
  const delay = 0;
  [1, 2.756, 5.404, 8.933].forEach((ratio, i) => {
    const t = audioCtx.currentTime + delay;
    const g = audioCtx.createGain();
    const o = audioCtx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq * ratio;
    const partialGain = gain * [1, 0.5, 0.25, 0.12][i];
    const partialDur  = dur  * [1, 0.7, 0.5,  0.3][i];
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(partialGain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + partialDur);
    o.connect(g); g.connect(masterGain || audioCtx.destination);
    o.start(t); o.stop(t + partialDur + 0.05);
  });
}

function playBreakStart() {
  // Single C3 tone, fading out over 3s
  beep(130.8, 3.0, 0.35, 'sine', 0.0); // C3
}

function playAsleepDing() {
  // Single quiet C5 ding — plays when autoAdvance=off and practice time exceeds chunk budget
  beep(523.3, 2.0, 0.25, 'sine', 0.0); // C5
}

function playFinalGong() {
  // Same as break chime (C3) but twice as long and 20% louder
  beep(130.8, 6.0, 0.42, 'sine', 0.0); // C3, 6s decay, gain 0.42
}

function playBackToWork() {
  // High chime: C4, 8.0s decay, gain 0.30
  beep(261.6, 3.0, 0.30, 'sine', 0.0); // C4
}

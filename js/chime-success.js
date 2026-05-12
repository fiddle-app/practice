'use strict';
// =================================================
// SHARED CHIME-SUCCESS SOUND
// Used by: ear-tuner, microbreaker
// =================================================
// Boxing-ring bell: A4 (440 Hz), single strike, 2.5s decay.
// Inharmonic partials simulate metal-bell resonance.
//
// Pure function — caller owns the AudioContext and any guards
// (audioUnlocked, settings.notifyVol, etc).
//
//   chimeSuccess(ctx)                            // → ctx.destination
//   chimeSuccess(ctx, masterGain)                // → custom destination node
//   chimeSuccess(ctx, masterGain, 0.08)          // → quieter base gain

function chimeSuccess(ctx, dest, baseGain) {
  if (dest === undefined) dest = ctx.destination;
  if (baseGain === undefined) baseGain = 0.10;
  const freq = 440, dur = 2.5;
  const partials = [
    [1.000, 1.00, 1.0],
    [2.756, 0.50, 0.7],
    [5.404, 0.25, 0.5],
    [8.933, 0.12, 0.3],
  ];
  partials.forEach(([ratio, gFrac, dFrac]) => {
    const t = ctx.currentTime;
    const g = ctx.createGain();
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq * ratio;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(baseGain * gFrac, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * dFrac);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur * dFrac + 0.05);
  });
}

'use strict';

// =================================================
// SETTINGS & STORAGE
// =================================================
// Release mic tracks between phases on Safari/iOS (so the mic indicator turns off).
// On Chrome, keep the stream alive to avoid re-prompting each work phase.
const BUILD_DATE = '2026-05-13 13:55';   // stamped automatically by deploy.sh — do not edit manually
const IS_SAFARI  = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

const DEFAULTS = {
  workDur:               45,
  breakDur:              15,
  chunkDur:              300,
  restDur:               90,
  // Maximum recording length per round, in seconds. Caps the MediaRecorder
  // so a forgotten/runaway recording can't accumulate unbounded memory.
  // Default 600 (10 min) preserves prior hardcoded behavior. The UI step
  // config (ui.js STEP_CFG) bounds this between 60s and 900s — see the
  // drawWaveform memory note there.
  maxRecDur:             600,
  breaksCountAsPractice: false,
  notifyVol:             0.35,
  reviewVol:             0.8,
  recording:             true,
  autoAdvance:           false,
  voiceCommands:         true,    // app-wide voice control when model is ready
  limitVrVocab:          true,    // strict grammar — recognizer constrained to command vocabulary
  vcKeepLastWord:        false,   // when on, last recognized word stays visible until next match
  messages:              ['Remember your goal','Flex your wrist','Audiate to intonate','Create emphasis'],
  restQ:                 ['What is your goal?', 'How will you achieve it?', ''],
  // The user's words for "correct" and "wrong". When non-empty these are
  // exactly what the recognizer matches against — there's no built-in
  // synonym list merged underneath. If the user clears one entirely,
  // voice.js falls back to ['correct'] / ['wrong'] so the rep counter
  // always has at least one trigger word.
  vrGood:                ['correct', 'good'],
  vrBad:                 ['wrong',   'restart', 'no']
};

let settings = (() => {
  try {
    // Migrate pt_v3 → pt_v4
    let stored = JSON.parse(localStorage.getItem('pt_v4') || 'null');
    if (!stored) {
      stored = JSON.parse(localStorage.getItem('pt_v3') || '{}');
      // Derive chunkDur from old rounds setting if present
      if (!stored.chunkDur) {
        const r = stored.rounds ?? 5;
        stored.chunkDur = r * ((stored.workDur ?? 45) + (stored.breakDur ?? 15));
      }
      delete stored.rounds;
      localStorage.removeItem('pt_v3');
    }
    // Migrate old 'muted' flag
    if (stored.muted !== undefined && stored.notify === undefined) {
      stored.notify = !stored.muted; delete stored.muted;
    }
    // Migrate old 'notify' boolean -> notifyVol=0 if notify was false
    if (stored.notify === false && stored.notifyVol === undefined) {
      stored.notifyVol = 0;
    }
    delete stored.notify;
    // Ensure notifyVol is numeric
    if (stored.notifyVol !== undefined) stored.notifyVol = parseFloat(stored.notifyVol);
    if (isNaN(stored.notifyVol)) stored.notifyVol = 0.35;
    if (stored.reviewVol !== undefined) stored.reviewVol = parseFloat(stored.reviewVol) || 0.8;
    return Object.assign({}, DEFAULTS, stored);
  } catch(e) { return {...DEFAULTS}; }
})();

function saveSettings() {
  localStorage.setItem('pt_v4', JSON.stringify({
    workDur: settings.workDur, breakDur: settings.breakDur,
    chunkDur: settings.chunkDur, restDur: settings.restDur,
    maxRecDur: settings.maxRecDur,
    breaksCountAsPractice: settings.breaksCountAsPractice,
    notifyVol: settings.notifyVol,
    reviewVol: settings.reviewVol,
    recording: settings.recording,
    autoAdvance: settings.autoAdvance,
    voiceCommands:  settings.voiceCommands,
    limitVrVocab:   settings.limitVrVocab,
    vcKeepLastWord: settings.vcKeepLastWord,
    messages: settings.messages, restQ: settings.restQ,
    vrGood: settings.vrGood, vrBad: settings.vrBad
  }));
}

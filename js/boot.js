'use strict';

// =================================================
// BOOT
// =================================================
phase            = 'ready';
isPaused         = false;
phaseTimeLeft    = 0;
waitingToAdvance = false;
practiceTime     = 0;
chunkStartTime   = null;
render();
rafId = requestAnimationFrame(tick);

// Resurrect the vcWipeAndRebuild debug banner if a wipe fired during a
// previous session and Casey didn't dismiss it.
if (typeof vcWipeBannerCheckOnBoot === 'function') vcWipeBannerCheckOnBoot();

// Init-complete marker — pair with the watchdog in index.html. If the app
// stays alive 2 seconds past initial render without crashing, we consider
// boot successful and write the clean-shutdown marker. This compensates
// for iOS force-kill (no pagehide fires), so a normal "use, kill via app
// switcher, relaunch" cycle isn't misclassified as a bad boot. Genuine
// boot-time crashes die well before 2s and never reach this timer, so the
// watchdog still sees them as bad boots.
setTimeout(function () {
  try {
    if (localStorage.getItem('mb-test-suppress-clean') !== '1') {
      localStorage.setItem('mb-clean-shutdown', '1');
    }
  } catch (e) {}
}, 2000);

// App icon (info + welcome overlays) is rendered statically from
// resources/app-icon-180.png via <img src=…> in index.html — no JS wiring
// needed. Do not re-introduce data: URL / canvas-generated icon code: it
// breaks iOS Add-to-Home-Screen. See research/pwa-home-screen-icon-plan.md.

// SW registration delegated to _shared/js/register-sw.js — Capacitor-aware,
// localhost-aware, and consistent across the family (ear-tuner adopts the
// same helper as a separate backlog item). The controllerchange→reload
// flow lives in the inline <head> script in index.html (with safe-phase
// deferral) — keep it there to avoid a race where a listener attached
// inside register().then() misses an early controllerchange.
registerSW();

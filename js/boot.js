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

if ('serviceWorker' in navigator) {
  // In dev, the cache key in sw.js is `microbreaker-static-%%BUILD_DATE%%`
  // — the placeholder is only stamped at deploy time, so the cache name
  // is stable across dev sessions and an old SW will happily serve
  // stale CSS/JS forever. Auto-unregister any existing SW when running
  // on localhost; only register a real SW in prod.
  //
  // To test SW behavior locally, deploy to a real origin (or flip the
  // isDev check below).
  const isDev = location.hostname === 'localhost' ||
                location.hostname === '127.0.0.1';
  if (isDev) {
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(r => r.unregister()));
  } else {
    // Register SW + push any new install through to activation.
    // The `controllerchange → reload` flow lives in the inline <head>
    // script (with safe-phase deferral). Attaching it there avoids the
    // race where a second listener inside register().then() would miss
    // the event if controllerchange fires before register resolves.
    navigator.serviceWorker.register('sw.js').then(reg => {
      reg.update().catch(() => {});
      reg.addEventListener('updatefound', () => {
        console.log('[sw] updatefound visible=' + (document.visibilityState === 'visible'));
        const newSW = reg.installing;
        if (!newSW) return;
        newSW.addEventListener('statechange', () => {
          console.log('[sw] new-worker statechange state=' + newSW.state);
          if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
            newSW.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    });
  }
}

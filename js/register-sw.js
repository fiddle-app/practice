'use strict';
// =================================================
// SHARED SERVICE WORKER REGISTRATION
// Used by: microbreaker, ear-tuner
// =================================================
// Capacitor-aware SW registration. Skips registration entirely under
// Capacitor (the app is bundled locally — a SW caching local files only
// adds cache-coherence complexity) and under dev localhost (where the
// %%BUILD_DATE%% placeholder isn't stamped, so the cache key is stable
// across dev sessions and would serve stale assets forever).
//
// Under non-localhost prod, registers the given SW path and wires up
// the update-found / SKIP_WAITING flow. The controllerchange→reload
// flow lives in the inline <head> script in each app's index.html.

/**
 * @param {string} [swPath='sw.js'] — path to the service worker script,
 *   relative to the page. Each app's sw.js sits at the deploy root, so
 *   'sw.js' is the convention.
 */
function registerSW(swPath) {
  if (!('serviceWorker' in navigator)) return;

  // Capacitor detection. Per the rollup audit (Cross-app Pattern #1) the
  // simple two-clause gate is sufficient: `window.Capacitor` is injected
  // by the Cap runtime before page scripts execute; `capacitor:` is the
  // iOS scheme. (Android uses `https://localhost` — caught by the
  // `window.Capacitor` clause, not the protocol clause.)
  if (window.Capacitor || location.protocol === 'capacitor:') return;

  // Dev: localhost cache keys never get a stamped BUILD_DATE, so any
  // registered SW serves stale dev assets indefinitely. Unregister
  // leftovers from a prior prod build that opened on localhost.
  const isDev = location.hostname === 'localhost' ||
                location.hostname === '127.0.0.1';
  if (isDev) {
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(r => r.unregister()));
    return;
  }

  // Prod: register + push any new install through to activation.
  navigator.serviceWorker.register(swPath || 'sw.js').then(reg => {
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

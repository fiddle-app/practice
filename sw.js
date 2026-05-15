'use strict';

// Service worker for Practice Buddy (microbreaker)
// 2026-05-15 15:14 is replaced by deploy.sh at deploy time — do NOT edit manually.

const CACHE_VER    = '2026-05-15 15:14';
const STATIC_CACHE = 'microbreaker-static-' + CACHE_VER;
const FONT_CACHE   = 'microbreaker-fonts';

// Paths are relative to this sw.js file. In prod (sw.js at /practice/sw.js)
// they resolve under /practice/; in dev (sw.js at /sw.js) they resolve under
// root. One set of strings works for both.
//
// PRECACHE is intentionally COMPREHENSIVE — every JS file the page loads via
// <script src> at parse time is in here. Reasoning: on activate the new SW
// deletes the old cache (`microbreaker-static-*` filter below), so all
// non-precached files have to come from runtime cache-on-fetch. If a user
// goes offline immediately after an update lands (downloaded in WiFi, then
// airplane mode), the next launch gets a fresh new-version cache populated
// ONLY with PRECACHE — anything missing has to network-fetch and will fail
// offline, leaving a half-loaded mixed-version page. Casey hit this exact
// failure mode in previous deploys ("mixing assets from different versions
// causing crashes"). Comprehensive PRECACHE trades one extra fetch on
// install for guaranteed offline coherence after the install completes.
//
// The tolerant install handler below makes single-file 404s survivable, so
// a comprehensive list is no longer the install-reliability liability it
// once was.
const PRECACHE = [
  './',
  'index.html',
  'style.css',
  'design-tokens.css',
  'design-tokens-app.css',
  'glyph-disc.css',
  'resume-modal.css',
  'fonts/fonts.css',
  'fonts/inconsolata-latin.woff2',
  'fonts/nunito-latin.woff2',
  'js/platform.js',
  'js/diag-log.js',
  'js/settings.js',
  'js/audio-ctx.js',
  'js/wakelock.js',
  'js/chime-success.js',
  'js/audio.js',
  'js/mic.js',
  'js/mic-recording.js',
  // vosk-browser.js intentionally omitted — voice.js lazy-loads it on first
  // opt-in. The fetch handler below will populate STATIC_CACHE on first use,
  // so subsequent launches still serve it offline.
  'js/voice-commands.js',
  'js/voice-commands-worklet.js',
  'js/voice.js',
  'js/timer.js',
  'js/render.js',
  'js/safe-area.js',
  'js/ui.js',
  'js/rep-counter.js',
  'js/register-sw.js',
  'js/boot.js',
  'resources/app-icon-180.png',
];

// Install: cache static assets, tolerantly. A single 404 used to doom the
// entire install (cache.addAll is atomic — one rejection rolls back all),
// leaving the user permanently stuck on the prior SW. Per-file try/catch
// localises the failure: missing files get logged and the install completes;
// the runtime fetch handler will network-fetch + cache them on first request.
//
// Catastrophic-failure guard: if EVERY entry failed (CDN outage during the
// install window, full server-side disaster), throw — that rejects the
// install, which preserves the prior working SW rather than replacing it
// with a corpse cache that activate would then promote into the gatekeeper
// for everything. One or several failures = log and continue; total
// failure = bail.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(async (cache) => {
      const failed = [];
      for (const url of PRECACHE) {
        try { await cache.add(url); }
        catch (e) { failed.push(url + ' (' + (e && e.message) + ')'); }
      }
      if (failed.length) console.warn('[sw] install: failed to precache:', failed);
      if (failed.length === PRECACHE.length) {
        throw new Error('SW install: every PRECACHE entry failed; aborting to keep prior SW in charge');
      }
      await self.skipWaiting();
    })
  );
});

// Allow the page to push a waiting SW into activation immediately
// (covers the case where a previous install is sitting in 'waiting').
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Activate: delete old static caches (keep font cache)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('microbreaker-static-') && k !== STATIC_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for in-scope same-origin requests.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // SW fetch events only fire for URLs within our registration scope, so
  // no explicit pathname guard is needed. Same-origin check is belt-and-
  // braces for any edge cases.
  if (url.origin !== self.location.origin) return;

  // Voice-model tarballs (~40 MB) are managed by Vosk's worker via its own
  // IDBFS cache, keyed by sanitized URL. Caching them in the SW too would
  // double-store the model on disk and never be read — Vosk short-circuits
  // both fetch and extraction on warm launch via the `extracted.ok` marker.
  // Offline still works: Vosk's IDBFS persists across sessions.
  if (url.pathname.includes('/voice-models/')) return;

  // Fonts get their own long-lived cache (never expire with version changes)
  const isFontReq = url.pathname.match(/\.(woff2?)$/i);
  const cacheName = isFontReq ? FONT_CACHE : STATIC_CACHE;

  event.respondWith(
    caches.open(cacheName).then(cache =>
      cache.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          if (response && response.status === 200) {
            cache.put(event.request, response.clone());
          }
          return response;
        });
      })
    )
  );
});

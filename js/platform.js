'use strict';
// =================================================
// PLATFORM CAPABILITY SHIM
// Used by: microbreaker, ear-tuner (and every future Cap wrap)
// =================================================
// Detects whether we're running inside a Capacitor wrap or as a web
// PWA / browser tab, so feature-level code can branch on capabilities
// without sprinkling `window.Capacitor` checks across every file.
//
// `window.Capacitor` is injected by the Cap runtime before any page
// script executes, so these functions are safe to call from any
// later-loaded script (ui.js, audio-ctx.js, etc.).
//
// Branch on `isNative()` (or its platform-specific variants) at the
// point where behavior must differ. Default code paths should remain
// the PWA-correct ones — Cap branches are the override, per the
// dual-surface rule in fiddle/CLAUDE.md.

function isNative() {
  return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function'
            && window.Capacitor.isNativePlatform());
}

function isCapIOS() {
  return isNative() && window.Capacitor.getPlatform() === 'ios';
}

function isCapAndroid() {
  return isNative() && window.Capacitor.getPlatform() === 'android';
}

function isPWA() {
  return !isNative();
}

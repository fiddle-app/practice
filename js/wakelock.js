'use strict';
// ============================================
// SCREEN WAKE LOCK — shared across fiddle apps
// ============================================
// Holds the screen on during active practice / tuning. Intent ("do we
// want a lock?") is independent of the sentinel ("do we currently hold
// one?") because iOS auto-releases on background and we re-request on
// regain.
//
// Acquire happens from explicit user gestures (Start tap, Hello/Welcome
// close, Resume tap). Activity signals (pointerdown, keydown, voice
// commands) reset a 30-minute idle timer and re-acquire if intent is
// still set but the sentinel was lost (e.g., after visibility regain).
// On idle timeout we release intent — the user must explicitly gesture
// again to re-engage.

const _WL_IDLE_TIMEOUT_MS = 30 * 60 * 1000;  // 30 minutes
let _wakeLock     = null;
let _wantWakeLock = false;
let _wlIdleTimer  = null;
let _wlAcquiring  = false;   // re-entrancy guard — see wlAcquire

async function wlAcquire(reason) {
  if (!('wakeLock' in navigator)) {
    console.log('[wakelock] not supported on this UA');
    return;
  }
  _wantWakeLock = true;
  _wlResetIdleTimer();
  // _wakeLock-only guard would let two concurrent callers (e.g. a
  // pointerdown racing with the Start click's .then) both pass and
  // issue two wakeLock.request()s — the second sentinel would orphan.
  if (_wakeLock || _wlAcquiring) return;
  _wlAcquiring = true;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    console.log('[wakelock] acquired reason=' + reason);
    _wakeLock.addEventListener('release', () => {
      console.log('[wakelock] sentinel-release (system or explicit)');
      _wakeLock = null;
    });
  } catch (e) {
    console.warn('[wakelock] request failed:', e);
  } finally {
    _wlAcquiring = false;
  }
}

function wlRelease(reason) {
  _wantWakeLock = false;
  if (_wlIdleTimer) { clearTimeout(_wlIdleTimer); _wlIdleTimer = null; }
  if (!_wakeLock) return;
  const w = _wakeLock; _wakeLock = null;
  w.release()
    .then(() => console.log('[wakelock] released reason=' + reason))
    .catch((e) => console.warn('[wakelock] release rejected reason=' + reason, e));
}

// Called on any user-activity signal. Resets idle timer. If we want a
// lock but don't hold one (e.g., post-background), attempt acquire. This
// must be invoked from inside a real user-gesture handler — see call
// sites in each app. Pure programmatic invocations won't be able to acquire.
function wlOnActivity(source) {
  if (!_wantWakeLock) return;
  _wlResetIdleTimer();
  if (!_wakeLock) wlAcquire('activity:' + source);
}

function _wlResetIdleTimer() {
  if (_wlIdleTimer) clearTimeout(_wlIdleTimer);
  _wlIdleTimer = setTimeout(() => {
    _wlIdleTimer = null;
    console.log('[wakelock] 30-min idle timeout — releasing');
    wlRelease('idle-timeout');
  }, _WL_IDLE_TIMEOUT_MS);
}

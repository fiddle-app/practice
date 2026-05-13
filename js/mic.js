'use strict';

// =================================================
// MIC — shared across fiddle apps
// -----------------------------------------------------------------
// Bare microphone-acquisition helpers. Owns the persistent-mute auto-
// release pattern that mitigates iOS's lock-screen beep storm; does
// NOT own MediaRecorder or any app-specific lifecycle (recording-blob
// assembly, memory snapshots, review playback). Apps that need those
// live in their own app-local module (e.g. microbreaker/js/mic-recording.js).
//
// EXPERIMENT (beep-storm mitigation): when iOS prepares for screen lock,
// it cycles the mic track mute → unmute → mute within ~1s, and each
// transition appears to fire an iOS microphone-indicator beep. The first
// mute event leads the cascade by ~700-900ms — that's our warning shot.
// On a sustained mute (no unmute within DEBOUNCE_MS), we voluntarily
// release the mic so iOS doesn't need to keep cycling a stream we still
// hold. If our hypothesis is right, this reduces 3 beeps to 0 or 1; if
// wrong, beep count is unchanged and we paid for a Resume modal on regain.
// Cost regardless: the next foreground requires a user gesture to
// re-acquire — i.e. the Resume modal fires every lock-and-return.
//
// Globals exposed: micStream, acquireMic, releaseMic, micStreamIsLive.
// Globals consumed: audioCtx, audioUnlocked (from audio-ctx.js).
// =================================================

let micStream     = null;
const _MIC_PERSISTENT_MUTE_MS = 300;
let _micPersistentMuteTimer   = null;
// In-flight getUserMedia promise — concurrent callers share this so we
// don't double-prompt on iOS or leak the first stream when two paths
// (e.g., a pointerdown warm-up + a click handler) both call acquireMic
// in the same gesture. Cleared after the call resolves.
let _micAcquireP  = null;

// Release listeners — apps that own auxiliary state tied to the stream
// (e.g. MediaRecorder in microbreaker/js/mic-recording.js) register a
// callback here. We fire each listener BEFORE we stop the tracks so
// the consumer has a chance to flush state cleanly. Listeners must be
// idempotent and cheap.
const _micReleaseListeners = [];
function onMicWillRelease(cb) { _micReleaseListeners.push(cb); }

async function acquireMic() {
  if (micStream) return true;  // reuse existing stream
  if (_micAcquireP) return _micAcquireP;
  _micAcquireP = (async () => {
    try {
      // Force 'play-and-record' before getUserMedia. iOS 18+ rejects
      // getUserMedia with InvalidStateError if the audio session is
      // currently 'playback'. ensureAudio's resolver may have set
      // 'playback' if appWantsMic was false at that moment (e.g., VR
      // toggled on AFTER ensureAudio ran); we override here because
      // by definition the caller wants mic right now.
      if (navigator.audioSession) {
        try { navigator.audioSession.type = 'play-and-record'; } catch(e){}
      }
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const tracks = micStream.getAudioTracks();
      console.log('[mic] acquired tracks=' + tracks.length +
                  ' visible=' + (document.visibilityState === 'visible'));
      // Listen to tracks[0] only, NOT forEach. Rationale: the persistent-mute
      // debounce timer (_micPersistentMuteTimer) is module-scoped — a multi-track
      // listener model would race against it (track A mute → timer armed; track B
      // unmute → timer cleared even though A is still muted). getUserMedia with
      // { audio: true } returns exactly one audio track, so single-track is
      // load-bearing. If we ever request constraints that could yield multiple
      // audio tracks, key the timer by track index instead.
      //
      // ended fires when iOS yanks the source mid-session; mute/unmute fire
      // when iOS suspends/resumes data flow (notably, the pre-lock cascade
      // that fires 3 iOS microphone-indicator beeps — see persistent-mute
      // auto-release below).
      const track = tracks[0];
      if (track) {
        track.addEventListener('ended', () => {
          console.log('[mic] track ended visible=' + (document.visibilityState === 'visible'));
        });
        track.addEventListener('mute', () => {
          console.log('[mic] track mute visible=' + (document.visibilityState === 'visible'));
          // Persistent-mute = pre-lock cascade. Arm release timer; cancel on unmute.
          if (_micPersistentMuteTimer) clearTimeout(_micPersistentMuteTimer);
          _micPersistentMuteTimer = setTimeout(() => {
            _micPersistentMuteTimer = null;
            console.log('[mic] auto-release on persistent mute (experiment)');
            releaseMic();
          }, _MIC_PERSISTENT_MUTE_MS);
        });
        track.addEventListener('unmute', () => {
          console.log('[mic] track unmute visible=' + (document.visibilityState === 'visible'));
          if (_micPersistentMuteTimer) {
            clearTimeout(_micPersistentMuteTimer);
            _micPersistentMuteTimer = null;
            console.log('[mic] persistent-mute timer cancelled by unmute');
          }
        });
      }
      // getUserMedia can suspend the AudioContext on iPad — resume it
      if (typeof audioCtx !== 'undefined' && audioCtx && audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      if (typeof audioUnlocked !== 'undefined') {
        audioUnlocked = true;
      }
      return true;
    } catch(e) {
      console.warn('getUserMedia failed:', e);
      micStream = null;
      return false;
    } finally {
      _micAcquireP = null;
    }
  })();
  return _micAcquireP;
}

// Forcefully release the mic stream. Apps that hold a MediaRecorder
// must stop and tear that down BEFORE calling this — this helper does
// not know about recorders.
function releaseMic() {
  // Notify auxiliary state owners (recorder, etc.) BEFORE we drop the
  // stream — they may need to flush or stop. Failures here are logged
  // and swallowed so a flaky listener doesn't strand the stream.
  for (const cb of _micReleaseListeners) {
    try { cb(); } catch (e) { console.warn('[mic] release listener threw:', e); }
  }
  if (_micPersistentMuteTimer) {
    clearTimeout(_micPersistentMuteTimer);
    _micPersistentMuteTimer = null;
  }
  if (micStream) {
    try { micStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    micStream = null;
  }
  // Re-evaluate the audio session category after release. If the app
  // no longer wants mic (e.g., VR toggled off, persistent-mute auto-
  // release with no other mic consumer), drop back to 'playback' so
  // output routes through Bluetooth A2DP / AirPlay / car stereo
  // instead of the device speaker. If something else still wants mic,
  // the resolver returns 'play-and-record' and the setter is a no-op.
  if (navigator.audioSession && typeof appWantsMic === 'function') {
    try {
      const t = appWantsMic() ? 'play-and-record' : 'playback';
      navigator.audioSession.type = t;
    } catch (e) {}
  }
}

// True if our cached micStream is still usable. iOS may end the
// underlying audio source during a long background — that transitions
// each track's readyState to 'ended'. Calling code (Resume) uses this
// as a pre-flight before trusting the cached stream; if false, drop
// and re-acquire inside the user-gesture frame.
function micStreamIsLive() {
  if (!micStream) return false;
  const tracks = micStream.getAudioTracks();
  if (tracks.length === 0) return false;
  return tracks.every(t => t.readyState === 'live');
}

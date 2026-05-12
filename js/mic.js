'use strict';

// =================================================
// RECORDING
// =================================================
let micStream     = null;
let mediaRecorder = null;
let recChunks     = [];
let reviewBlob    = null;
let recCapTimer   = null;
let recPendingTimer = null;

// Delay between the round-start bell firing and the MediaRecorder actually
// starting. The bell (playWorkStart) is A5 with a 2.5s exponential decay,
// but at 500 ms its amplitude is already well below typical fiddle mic
// input — the previous 2000 ms swallowed real opening notes Casey wanted
// captured. Bell tail still appears in recordings but as a low-level
// transient, which is acceptable.
const RECORD_START_DELAY_MS = 500;

// In-flight getUserMedia promise — concurrent callers share this so we
// don't double-prompt on iOS or leak the first stream when two paths
// (e.g., a pointerdown warm-up + a click handler) both call acquireMic
// in the same gesture. Cleared after the call resolves. Closes B5.
let _micAcquireP = null;

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
const _MIC_PERSISTENT_MUTE_MS = 300;
let _micPersistentMuteTimer = null;

async function acquireMic() {
  if (micStream) return true;  // reuse existing stream
  if (_micAcquireP) return _micAcquireP;
  _micAcquireP = (async () => {
    try {
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
      if (audioCtx && audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      audioUnlocked = true;
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

// Drop the current review blob. Call this at every transition where
// review is no longer reachable: the next round's startRecording (about
// to overwrite it), and break exit (review-btn is only shown during
// break, so once break ends the user can't reach it anyway). Idempotent
// and cheap; safe to call when there's no blob.
//
// Also logs a memory snapshot just BEFORE freeing — the moment immediately
// before release is the natural high-water-mark for the recording lifecycle.
// Captured via console.log so diag-log.js's wrapper persists it; visible
// later in Settings → Diagnostics → Error log. performance.memory is a
// Chrome-only API (Safari doesn't implement it), so on iPhone the entry
// reports the blob size but not heap — still useful as a "what was the
// peak recording size" signal across sessions.
//
// As of the Web Audio review refactor, there's no <audio> element / object
// URL to revoke here — review playback decodes through the AudioContext
// and the decoded buffer is freed by closeReview(). This helper now just
// nulls the blob.
function clearReviewBlob() {
  if (!reviewBlob) return;
  const blobMB = (reviewBlob.size / 1048576).toFixed(2);
  let heapInfo = 'heap=unavailable';
  if (typeof performance !== 'undefined' && performance.memory) {
    const m = performance.memory;
    heapInfo = 'heap=' + (m.usedJSHeapSize / 1048576).toFixed(1) +
               '/' + (m.totalJSHeapSize / 1048576).toFixed(1) +
               'MB (limit ' + (m.jsHeapSizeLimit / 1048576).toFixed(0) + 'MB)';
  }
  console.log('[mem] release recording: blob=' + blobMB + 'MB ' + heapInfo);
  reviewBlob = null;
}

function startRecording() {
  if (!settings.recording) return;
  recChunks = [];
  // Defensive — clearReviewBlob() runs at break exit too, so by the time
  // we get here reviewBlob should already be null. This catches the path
  // where startRecording is called WITHOUT going through break (e.g.,
  // restartPhase in timer.js calls stopRecording then startRecording for
  // the same work phase). The Web Audio review path's decoded buffer +
  // gain node are owned by ui.js's closeReview, not this module.
  clearReviewBlob();
  if (recPendingTimer) { clearTimeout(recPendingTimer); recPendingTimer = null; }
  if (!micStream) {
    acquireMic().then(ok => {
      if (!ok) return;
      // Play bell after mic acquired — AudioContext is resumed by acquireMic
      if (audioUnlocked && phase === 'work') playWorkStart();
      _scheduleBeginRec();
    });
    return;
  }
  // mic already acquired — caller plays the bell synchronously before this.
  _scheduleBeginRec();
}

function _scheduleBeginRec() {
  recPendingTimer = setTimeout(() => {
    recPendingTimer = null;
    // User may have toggled recording off, paused, or skipped past the
    // work phase during the bell delay — bail rather than capture stale audio.
    if (!settings.recording || phase !== 'work') return;
    _beginRec();
  }, RECORD_START_DELAY_MS);
}

function _beginRec() {
  if (!micStream) { console.warn('_beginRec: no micStream'); return; }
  try {
    // Pick a supported MIME type
    const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/ogg','']
      .find(m => m === '' || MediaRecorder.isTypeSupported(m)) || '';
    const mr = new MediaRecorder(micStream, mimeType ? { mimeType } : undefined);
    mediaRecorder = mr;
    mr.ondataavailable = e => { if (e.data?.size > 0) recChunks.push(e.data); };
    mr.onstop = () => {
      if (recChunks.length) {
        reviewBlob = new Blob(recChunks, { type: mr.mimeType || 'audio/webm' });
        // Drop chunk references the moment the assembled blob exists.
        // Engines may keep the source blobs alive until the new Blob
        // finalises — clearing the array lets the old chunks be GC'd
        // immediately rather than living until the next round resets.
        recChunks = [];
        render();
      }
    };
    mr.start(250);
    // Configurable cap (settings.maxRecDur, seconds). Fallback 600s
    // matches the prior hardcoded 10-minute behavior.
    const capSec = (settings.maxRecDur || 600);
    recCapTimer = setTimeout(() => stopRecording(), capSec * 1000);
  } catch(e) {
    console.warn('MediaRecorder start failed:', e);
  }
}

// Pause / resume the current MediaRecorder across visibility transitions.
// MediaRecorder.pause() suspends data collection without finalizing the
// blob; resume() picks back up and the assembled blob has a small skipped
// section (the duration the page was hidden) but no broken bytes. Caller
// is responsible for tracking whether a pause is "in flight" — these are
// thin wrappers; idempotent if the recorder is already in the target state.
function pauseRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    try { mediaRecorder.pause(); } catch (e) {}
  }
}
function resumeRecording() {
  if (mediaRecorder && mediaRecorder.state === 'paused') {
    try { mediaRecorder.resume(); } catch (e) {}
  }
}

function stopRecording() {
  if (recCapTimer) { clearTimeout(recCapTimer); recCapTimer = null; }
  if (recPendingTimer) { clearTimeout(recPendingTimer); recPendingTimer = null; }
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch(e) {}
  }
  mediaRecorder = null;
  // Keep micStream alive across phases on all browsers.
  // Previously we stopped tracks on Safari to clear the mic indicator, but
  // iOS can re-prompt for mic permission if the stream is released — even
  // within the same session, especially after long rest phases or the
  // 10-minute recording timeout. The mic indicator staying on is preferable
  // to interrupting the user with a permission dialog.
  // micStream intentionally NOT released here. See releaseMic() below for
  // the visibility-hidden teardown that DOES release the stream.
}

// Forcefully release the mic stream and any in-flight MediaRecorder.
// NOT called on visibility-hidden anymore — iOS plays its own
// "microphone stopped/started" indicator sounds when an app rapidly
// toggles getUserMedia state, which Casey heard as "two beeps that
// don't sound like the app." The mic stream survives backgrounding
// in most cases; we validate on Resume via micStreamIsLive().
//
// Still useful for explicit teardowns (Hard Reset, future "voice off"
// flows that genuinely want to release the hardware).
function releaseMic() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (e) {}
  }
  mediaRecorder = null;
  if (recPendingTimer) { clearTimeout(recPendingTimer); recPendingTimer = null; }
  if (recCapTimer)     { clearTimeout(recCapTimer);     recCapTimer     = null; }
  if (_micPersistentMuteTimer) { clearTimeout(_micPersistentMuteTimer); _micPersistentMuteTimer = null; }
  if (micStream) {
    try { micStream.getTracks().forEach(t => t.stop()); } catch (e) {}
    micStream = null;
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

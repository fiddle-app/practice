'use strict';

// =================================================
// MIC RECORDING — microbreaker
// -----------------------------------------------------------------
// MediaRecorder wiring on top of the shared mic stream (js/mic.js,
// synced from _shared/js/mic.js). Owns the recording-blob lifecycle:
// chunk accumulation, blob assembly, cap timer, memory snapshot at
// release.
//
// Globals consumed:
//   micStream, acquireMic, onMicWillRelease  (js/mic.js)
//   audioCtx, audioUnlocked                  (js/audio-ctx.js)
//   playWorkStart, phase, settings           (other modules)
//   render                                   (ui.js)
// Globals exposed:
//   mediaRecorder, reviewBlob
//   startRecording, stopRecording, pauseRecording, resumeRecording
//   clearReviewBlob
// =================================================

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

// When the shared mic module is about to release the stream (e.g., the
// persistent-mute auto-release fires), we need to stop the recorder and
// clear our timers so the assembled blob is finalised cleanly. The shared
// module fires this listener BEFORE the tracks stop.
if (typeof onMicWillRelease === 'function') {
  onMicWillRelease(() => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch (e) {}
    }
    mediaRecorder = null;
    if (recPendingTimer) { clearTimeout(recPendingTimer); recPendingTimer = null; }
    if (recCapTimer)     { clearTimeout(recCapTimer);     recCapTimer     = null; }
  });
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
  // micStream intentionally NOT released here. See releaseMic() in
  // js/mic.js for the visibility-hidden teardown that DOES release the stream.
}

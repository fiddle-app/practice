'use strict';

// =================================================
// BUTTON LISTENERS
// =================================================
$('btn-play-pause').addEventListener('click', () => { ensureAudio().then(() => togglePlayPause()); });
$('time-display').addEventListener('click', () => { ensureAudio().then(() => { if (waitingToAdvance) skipNext(); else togglePlayPause(); }); });
$('ready-ring-text').addEventListener('click', () => { ensureAudio().then(() => { if (waitingToAdvance) skipNext(); else togglePlayPause(); }); });
$('btn-prev').addEventListener('click',       () => { ensureAudio().then(() => restartPhase()); });
$('btn-next').addEventListener('click',       () => { ensureAudio().then(() => skipNext()); });
$('start-btn-inner').addEventListener('click', () => {
  // Kick off mic acquisition immediately within the user-gesture context.
  // iOS Safari closes the getUserMedia() permission window after the first
  // async boundary, so acquireMic() must be called here — not inside a .then().
  // Voice commands also need the mic, so acquire if either feature is on.
  const needMic = settings.recording || settings.voiceCommands;
  const micP = needMic ? acquireMic() : Promise.resolve();
  Promise.all([ensureAudio(), micP]).then(() => {
    wlAcquire('start-chunk');
    startChunk();
  });
});
$('review-btn').addEventListener('click', openReview);

document.addEventListener('keydown', e => {
  wlOnActivity('keydown');
  if ($('settings-overlay').classList.contains('open')) return;
  if ($('info-overlay').classList.contains('open')) return;
  if ($('review-overlay').classList.contains('open')) {
    if (e.code === 'Space') { e.preventDefault(); $('rev-playpause').click(); }
    if (e.code === 'Enter') { e.preventDefault(); closeReview(); }
    if (document.activeElement) document.activeElement.blur();
    return;
  }
  if (phase === 'ready') {
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); $('start-btn-inner').click(); }
    return;
  }
  if (e.code === 'Space') {
    e.preventDefault();
    // When waiting to advance (autoAdvance=off, timer=0), Space skips to next phase
    if (waitingToAdvance) { $('btn-next').click(); }
    else { $('btn-play-pause').click(); }
  }
  if (e.code === 'Enter') {
    e.preventDefault();
    // In break phase, Enter always opens review if available
    if (phase === 'break' && reviewBlob && settings.recording) {
      openReview();
    } else {
      $('btn-next').click();
    }
  }
  if (document.activeElement) document.activeElement.blur();
});

// Wake-lock activity hook: any tap anywhere is a "user is still here"
// signal. Resets the 30-min idle timer; re-acquires the lock if intent
// is still set but the sentinel was lost (e.g., after a visibility
// regain). Passive — doesn't interfere with any other handler.
document.addEventListener('pointerdown', () => { wlOnActivity('pointerdown'); }, { passive: true });

// Safari bfcache restore: page may be brought back with stale DOM state
// (transient overlays left open from last session). Force-close them on
// restore. NOTE: hello-overlay and welcome-overlay are deliberately NOT
// in this list — they are owned by openLaunchGate, which decides on every
// page load whether to show Hello (or Welcome). Including Hello here would
// race with openLaunchGate on a fresh load: Hello opens during
// DOMContentLoaded, then pageshow rips it back closed before the user sees it.
window.addEventListener('pageshow', () => {
  $('review-overlay').classList.remove('open');
  $('settings-overlay').classList.remove('open');
  $('info-overlay').classList.remove('open');
  $('reset-overlay').classList.remove('open');
  // Note: audio nuke on pageshow is handled by audio-ctx.js
});

// Lock to portrait on iPhone (not iPad) using Screen Orientation API
(function() {
  const isPhone = /iPhone/.test(navigator.userAgent);
  if (isPhone && screen.orientation && screen.orientation.lock) {
    screen.orientation.lock('portrait').catch(() => {});
  }
})();

// =================================================
// SETTINGS PANEL
// =================================================
function fmtDur(sec) {
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec/60), s = sec%60;
  return m + ':' + (s ? s.toString().padStart(2,'0') : '00');
}

const STEP_CFG = {
  chunkDur:  { min: 60,  max: 1800, step: 30, fmt: v => fmtDur(v), el: 'sv-chunk'  },
  workDur:   { min: 15,  max: 120,  step: 5,  fmt: v => v + 's',   el: 'sv-work'   },
  breakDur:  { min: 10,  max: 60,   step: 5,  fmt: v => v + 's',   el: 'sv-break'  },
  restDur:   { min: 30,  max: 600,  step: 15, fmt: v => fmtDur(v), el: 'sv-rest'   },
  // Upper bound 900s (15 min). Review playback now decodes through the
  // main AudioContext at the device's native rate (~48 kHz on iOS, 44.1
  // on desktop) so review can route through Web Audio rather than an
  // <audio> element — this dodges the per-element media-autoplay gate
  // that voice-triggered playback can't satisfy. The trade-off is that
  // the decoded review buffer is ~10–12 MB/min instead of ~1.9 MB. At
  // 15 min that's ~170 MB transient on iOS, alive only while the review
  // overlay is open. Past that we risk OOM under iOS PWA limits.
  maxRecDur: { min: 60,  max: 900,  step: 60, fmt: v => fmtDur(v), el: 'sv-maxrec' },
};

let _syncingUI = false;
function syncSettingsUI() {
  _syncingUI = true;
  refreshCalc();
  const _vol = settings.notifyVol !== undefined ? settings.notifyVol : 0.35;
  $('s-vol').value = _vol;
  const _muted = _vol === 0;
  $('s-vol-icon').style.opacity = _muted ? '0.25' : '1';
  const _mi = $('s-vol-muted');
  if (_mi) _mi.style.display = _muted ? 'flex' : 'none';
  $('s-record').checked      = settings.recording;
  $('s-voice').checked       = settings.voiceCommands !== false;
  $('s-limit-vr').checked    = settings.limitVrVocab  !== false;
  $('s-vc-keep').checked     = !!settings.vcKeepLastWord;
  $('s-auto').checked        = settings.autoAdvance !== false;
  $('s-breaks-count').checked = !!settings.breaksCountAsPractice;
  const rq = settings.restQ || ['', '', ''];
  $('s-restq1').value = rq[0] || '';
  $('s-restq2').value = rq[1] || '';
  $('s-restq3').value = rq[2] || '';
  const sbd = $('s-build-date');
  if (sbd) sbd.textContent = 'build ' + (typeof BUILD_DATE === 'string' ? BUILD_DATE : '(unknown)');
  _syncingUI = false;
}

function refreshCalc() {
  $('sv-chunk').textContent  = fmtDur(settings.chunkDur);
  $('sv-work').textContent   = settings.workDur + 's';
  $('sv-break').textContent  = settings.breakDur + 's';
  $('sv-rest').textContent   = fmtDur(settings.restDur);
  $('sv-maxrec').textContent = fmtDur(settings.maxRecDur || 600);
}

document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const field = btn.dataset.field, dir = parseInt(btn.dataset.dir);
    const cfg = STEP_CFG[field]; if (!cfg) return;
    settings[field] = Math.min(cfg.max, Math.max(cfg.min, settings[field] + dir * cfg.step));
    refreshCalc(); saveSettings();
  });
});

$('s-vol').addEventListener('input', e => {
  settings.notifyVol = parseFloat(e.target.value);
  updateMasterGain();
  saveSettings();
  const muted = settings.notifyVol === 0;
  $('s-vol-icon').style.opacity = muted ? '0.25' : '1';
  const mi = $('s-vol-muted');
  if (mi) mi.style.display = muted ? 'flex' : 'none';
});
$('s-auto').addEventListener('change',        e => { if (_syncingUI) return; settings.autoAdvance = e.target.checked; saveSettings(); });
$('s-breaks-count').addEventListener('change', e => { if (_syncingUI) return; settings.breaksCountAsPractice = e.target.checked; saveSettings(); });

$('s-record').addEventListener('change', async e => {
  if (_syncingUI) return;
  const wantOn = e.target.checked;
  // Guard against spurious duplicate events
  if (wantOn === settings.recording) return;
  settings.recording = wantOn;
  if (settings.recording) {
    // Ensure any prior stream is fully released before requesting a new one
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
      // Small delay so OS releases the hardware before we re-request
      await new Promise(r => setTimeout(r, 150));
    }
    const ok = await acquireMic();
    if (ok && phase === 'work') startRecording();
  } else {
    stopRecording(); // also releases mic tracks
    reviewBlob = null; recChunks = [];
  }
  saveSettings(); render();
});

$('s-voice').addEventListener('change', async e => {
  if (_syncingUI) return;
  const wantOn = e.target.checked;
  if (wantOn === settings.voiceCommands) return;
  settings.voiceCommands = wantOn;
  saveSettings();
  if (wantOn && !micStream) {
    // Acquire mic now (within the user-gesture chain on iOS) so voice can
    // start when the rep panel next expands.
    await acquireMic();
  }
  if (typeof vcOnSettingChange === 'function') vcOnSettingChange('voiceCommands');
});

$('s-limit-vr').addEventListener('change', e => {
  if (_syncingUI) return;
  const wantOn = e.target.checked;
  if (wantOn === settings.limitVrVocab) return;
  settings.limitVrVocab = wantOn;
  saveSettings();
  if (typeof vcOnSettingChange === 'function') vcOnSettingChange('limitVrVocab');
});

$('s-vc-keep').addEventListener('change', e => {
  if (_syncingUI) return;
  settings.vcKeepLastWord = e.target.checked;
  saveSettings();
  if (typeof vcOnSettingChange === 'function') vcOnSettingChange('vcKeepLastWord');
});

$('s-reset-btn').addEventListener('click', () => { $('reset-overlay').classList.add('open'); });

function doReset(clearMessages) {
  settings.workDur = DEFAULTS.workDur; settings.breakDur = DEFAULTS.breakDur;
  settings.chunkDur = DEFAULTS.chunkDur; settings.restDur = DEFAULTS.restDur;
  settings.maxRecDur = DEFAULTS.maxRecDur;
  settings.breaksCountAsPractice = DEFAULTS.breaksCountAsPractice;
  settings.notifyVol = DEFAULTS.notifyVol; settings.reviewVol = DEFAULTS.reviewVol; settings.recording = DEFAULTS.recording;
  settings.autoAdvance = DEFAULTS.autoAdvance; settings.restQ = [...DEFAULTS.restQ];
  settings.voiceCommands = DEFAULTS.voiceCommands;
  settings.limitVrVocab  = DEFAULTS.limitVrVocab;
  if (clearMessages) {
    settings.messages = [...DEFAULTS.messages];
    settings.vrGood   = [...DEFAULTS.vrGood];
    settings.vrBad    = [...DEFAULTS.vrBad];
  }
  saveSettings(); syncSettingsUI(); renderMsgList(); renderVrLists(); render();
  if (clearMessages && typeof vcOnSettingChange === 'function') {
    // Force the recognizer to pick up the restored defaults.
    vcOnSettingChange('vrGood');
  }
}
$('reset-yes').addEventListener('click',    () => { $('reset-overlay').classList.remove('open'); doReset(true);  });
$('reset-no').addEventListener('click',     () => { $('reset-overlay').classList.remove('open'); doReset(false); });
$('reset-cancel').addEventListener('click', () => { $('reset-overlay').classList.remove('open'); });

['s-restq1','s-restq2','s-restq3'].forEach((id, i) => {
  $(id).addEventListener('input', () => {
    if (!settings.restQ) settings.restQ = ['', '', ''];
    settings.restQ[i] = $(id).value; saveSettings(); render();
  });
});

function renderMsgList() {
  const list = $('msg-list'); list.innerHTML = '';
  settings.messages.forEach((m, i) => {
    const row = document.createElement('div'); row.className = 'msg-row';
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'msg-inp'; inp.value = m;
    inp.addEventListener('input', () => { settings.messages[i] = inp.value; saveSettings(); });
    const del = document.createElement('button');
    del.className = 'msg-del'; del.textContent = '\xd7';
    del.addEventListener('click', () => { settings.messages.splice(i,1); saveSettings(); renderMsgList(); });
    row.appendChild(inp); row.appendChild(del); list.appendChild(row);
  });
}

$('add-msg-btn').addEventListener('click', () => {
  settings.messages.push(''); saveSettings(); renderMsgList();
  const inp = $('msg-list').querySelectorAll('.msg-inp');
  if (inp.length) inp[inp.length-1].focus();
});

// Voice Recognition synonym lists. `field` is 'vrGood' or 'vrBad'; `listId` is
// the container element ID. Same edit/delete UX as renderMsgList — add via
// the section's add-button below, edit inline, delete via × button. Any change
// is persisted and re-armed in the recognizer via vcOnSettingChange.
function renderVrList(field, listId) {
  const list = $(listId); if (!list) return;
  list.innerHTML = '';
  const arr = Array.isArray(settings[field]) ? settings[field] : [];
  arr.forEach((word, i) => {
    const row = document.createElement('div'); row.className = 'msg-row';
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'msg-inp'; inp.value = word;
    inp.addEventListener('input', () => {
      settings[field][i] = inp.value;
      saveSettings();
    });
    inp.addEventListener('change', () => {
      // Commit on blur/enter — rebuild recognizer once the user is done typing
      // rather than on every keystroke.
      if (typeof vcOnSettingChange === 'function') vcOnSettingChange(field);
    });
    const del = document.createElement('button');
    del.className = 'msg-del'; del.textContent = '\xd7';
    del.addEventListener('click', () => {
      settings[field].splice(i, 1);
      saveSettings();
      renderVrList(field, listId);
      if (typeof vcOnSettingChange === 'function') vcOnSettingChange(field);
    });
    row.appendChild(inp); row.appendChild(del); list.appendChild(row);
  });
}

function renderVrLists() {
  renderVrList('vrGood', 'vr-good-list');
  renderVrList('vrBad',  'vr-bad-list');
}

['add-vr-good-btn', 'add-vr-bad-btn'].forEach(btnId => {
  const field  = btnId === 'add-vr-good-btn' ? 'vrGood'       : 'vrBad';
  const listId = btnId === 'add-vr-good-btn' ? 'vr-good-list' : 'vr-bad-list';
  $(btnId).addEventListener('click', () => {
    if (!Array.isArray(settings[field])) settings[field] = [];
    settings[field].push('');
    saveSettings();
    renderVrList(field, listId);
    const inputs = $(listId).querySelectorAll('.msg-inp');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
});

function renderDiagLog() {
  const el = $('diag-log-display');
  if (!el) return;
  if (typeof diagRead !== 'function') { el.textContent = '(log unavailable)'; return; }
  const entries = diagRead();
  if (entries.length === 0) { el.textContent = '(empty)'; return; }
  // Chronological — oldest at top, newest at bottom — so reading top to
  // bottom matches the order events happened. Capped at the last 30 to
  // keep the panel scrollable.
  el.textContent = entries.slice(-30).map((e) => {
    const t = new Date(e.t);
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    return `[${hh}:${mm}:${ss}] ${e.level}: ${e.msg}`;
  }).join('\n\n');
}

function renderBootStatus() {
  const el = $('s-boot-status');
  if (!el) return;
  el.textContent = (typeof diagBootStatus === 'function')
    ? diagBootStatus()
    : '(diag-log not loaded)';
}

// JS heap snapshot. performance.memory is Chrome-only — Safari (incl. iOS
// PWA) does not expose it. On Safari the line shows the blob size but a
// generic "heap unavailable" so the panel still gives some signal. On
// Chrome the live numbers are useful for desktop debugging of the
// recording-lifecycle leaks fixed earlier.
function renderMemStatus() {
  const el = $('s-mem-status');
  if (!el) return;
  const parts = [];
  if (typeof performance !== 'undefined' && performance.memory) {
    const m = performance.memory;
    parts.push(
      'JS heap: ' + (m.usedJSHeapSize / 1048576).toFixed(1) +
      ' / ' + (m.totalJSHeapSize / 1048576).toFixed(1) +
      ' MB (limit ' + (m.jsHeapSizeLimit / 1048576).toFixed(0) + ' MB)'
    );
  } else {
    parts.push('JS heap: not exposed by this browser (Chrome desktop only)');
  }
  if (typeof reviewBlob !== 'undefined' && reviewBlob) {
    parts.push('review blob: ' + (reviewBlob.size / 1048576).toFixed(2) + ' MB');
  }
  el.textContent = parts.join(' · ');
}

// SW + cache version visibility. Shows what's currently active vs. what
// would activate on next reload — useful when the bundled BUILD_DATE looks
// fine but the served code is stale (a stuck install pinned to an older SW
// won't see the new BUILD_DATE in the source it's serving). When active
// matches bundled, the line is informational; when they diverge, it's a
// nudge to hit Reload (or Hard reset, if Reload won't take).
async function renderSwStatus() {
  const el = $('s-sw-status');
  if (!el) return;
  if (!('serviceWorker' in navigator) || !window.caches) {
    el.textContent = 'service worker: unavailable';
    return;
  }
  try {
    const keys = await caches.keys();
    const staticKey = keys.find(k => k.startsWith('microbreaker-static-'));
    // Cache key is `microbreaker-static-<BUILD_DATE>` — strip the prefix.
    const activeVer = staticKey ? staticKey.replace('microbreaker-static-', '') : '(none)';
    const reg = await navigator.serviceWorker.getRegistration();
    const waiting = reg && (reg.waiting || reg.installing);
    let line = 'cache: ' + activeVer;
    if (activeVer !== BUILD_DATE) line += ' ⚠ mismatched';
    if (waiting) line += ' · update pending';
    // Add the inline-version-coherence-check state on a second line. The
    // inline boot script in index.html stores the last-seen build under
    // 'mb-last-build'; if that disagrees with BUILD_DATE here, the next
    // launch from a fresh fetch will trigger the upgrade modal.
    let lastSeen = null;
    try { lastSeen = localStorage.getItem('mb-last-build'); } catch (_) {}
    let metaBuild = null;
    const metaEl = document.querySelector('meta[name="microbreaker-build"]');
    if (metaEl) metaBuild = metaEl.content;
    line += '\nlast-seen: ' + (lastSeen || '(unset)') +
            ' · meta: ' + (metaBuild || '(missing)');
    // Show the inline-script's most recent boot decision so we can tell
    // whether it actually detected a mismatch (and triggered the modal)
    // or just seeded a baseline. Action values: mismatch / first-seen /
    // same / no-info.
    let decision = null;
    try { decision = JSON.parse(localStorage.getItem('mb-boot-decision') || 'null'); } catch (_) {}
    if (decision) {
      line += '\nboot decision: ' + decision.action +
              ' (last=' + (decision.last || 'null') +
              ' current=' + (decision.current || 'null') + ')';
    }
    el.textContent = line;
  } catch (e) {
    el.textContent = 'cache: (error)';
  }
}

async function hardReset() {
  // Order matters:
  //   1. SW unregister first — no in-flight fetches against caches we're
  //      about to delete.
  //   2. Caches second — clears every key, including fonts.
  //   3. localStorage third — boot watchdog state, settings, diag log all
  //      go (the user opted in to the full nuke).
  //   4. IndexedDB last — connections held by Vosk's worker etc. resolve
  //      best after the other state is gone.
  if (!confirm('Hard reset will delete ALL local data (settings, diag log, voice cache, service worker) and require internet on next launch. Continue?')) return;
  const btn = $('s-hard-reset-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Resetting…'; }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    try { localStorage.clear(); } catch (_) {}
    if (window.indexedDB) {
      try {
        if (indexedDB.databases) {
          const dbs = await indexedDB.databases();
          await Promise.all(dbs.map(({ name }) => name && new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = req.onerror = req.onblocked = () => resolve();
          })));
        } else {
          // Safari historically lacked indexedDB.databases() — known DB names.
          ['/vosk', 'voice-models'].forEach(n => { try { indexedDB.deleteDatabase(n); } catch (_) {} });
        }
      } catch (_) {}
    }
    // location.replace (not reload) — back-button history shouldn't return
    // here. Without the search/hash strip, a reset triggered from #debug
    // would pop the panel right back up.
    window.location.replace(window.location.pathname);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Hard reset'; }
    alert('Hard reset failed: ' + (e && e.message) + ' — try again, or remove the home-screen icon and re-add from Safari.');
  }
}

if ($('s-hard-reset-btn')) {
  $('s-hard-reset-btn').addEventListener('click', hardReset);
}

if ($('s-mem-refresh')) {
  $('s-mem-refresh').addEventListener('click', renderMemStatus);
}

if ($('s-sim-crash')) {
  $('s-sim-crash').addEventListener('click', () => {
    if (typeof diagSimulateCrashAndReload === 'function') diagSimulateCrashAndReload();
  });
}
if ($('s-reset-counter')) {
  $('s-reset-counter').addEventListener('click', () => {
    if (typeof diagResetBootCounter === 'function') diagResetBootCounter();
    renderBootStatus();
  });
}

if ($('s-sim-visibility')) {
  // Diagnostic: runs the same pause/resume cycle as a real visibility
  // transition, without actually backgrounding. If iOS chimes fire from
  // this on the iPhone PWA, the cause is somewhere in our pause logic
  // (muteMasterGain / pauseRecording / vcStop) rather than the iOS
  // visibility-driven AVAudioSession lifecycle.
  $('s-sim-visibility').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Backgrounding…';
    console.log('[sim-vis] simulating background');
    _onMaybeBackgrounded();
    await new Promise(r => setTimeout(r, 3000));
    btn.textContent = 'Foregrounding…';
    console.log('[sim-vis] simulating foreground');
    await _onMaybeForegrounded();
    btn.textContent = 'Done';
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
  });
}

if ($('diag-log-clear')) {
  $('diag-log-clear').addEventListener('click', () => {
    if (typeof diagClear === 'function') diagClear();
    renderDiagLog();
  });
}

if ($('diag-log-refresh')) {
  // The log display only re-renders when Settings opens. Backgrounding +
  // foregrounding fires events that get captured by diag-log.js but don't
  // show up here until Settings is closed and reopened. Refresh forces a
  // re-render of whatever's currently in the log buffer.
  $('diag-log-refresh').addEventListener('click', () => {
    renderDiagLog();
  });
}

if ($('diag-log-copy')) {
  $('diag-log-copy').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const text = $('diag-log-display').textContent || '';
    const orig = btn.textContent;
    try {
      // navigator.clipboard.writeText requires a secure context (HTTPS) and
      // a user-gesture stack — a button click satisfies both. iOS Safari
      // 13.4+ supports it.
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied!';
    } catch (e) {
      // Fallback: select + execCommand. Works on older iOS too. We use a
      // hidden textarea because <pre> selection is finicky inside an
      // overlay with pointer-events tricks.
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity  = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.textContent = 'Copied!';
      } catch (_) {
        btn.textContent = 'Copy failed';
      }
    }
    setTimeout(() => { btn.textContent = orig; }, 1400);
  });
}

let _wasPaused = false;
$('settings-btn').addEventListener('click', () => {
  _wasPaused = isPaused;
  if (!isPaused && phase !== 'ready') { isPaused = true; render(); }
  syncSettingsUI(); renderMsgList(); renderVrLists(); renderDiagLog(); renderBootStatus();
  renderSwStatus(); renderMemStatus();
  $('settings-overlay').classList.add('open');
  $('info-btn').style.visibility = 'hidden';
  $('settings-btn').style.visibility = 'hidden';
  // Match safe-area edges to settings background (--color-bg-panel)
  setBg('#1a1a1a');
});
$('s-done-btn').addEventListener('click', () => {
  // If a synonym input is focused, blur it first so its change handler fires
  // (the input handler persists each keystroke; only the change handler
  // triggers a recognizer rebuild). Then strip blank/whitespace-only entries
  // the user added but never filled in.
  const focused = document.activeElement;
  if (focused && focused.classList && focused.classList.contains('msg-inp') &&
      focused.closest && focused.closest('#vr-good-list, #vr-bad-list')) {
    focused.blur();
  }
  let vrChanged = false;
  for (const field of ['vrGood', 'vrBad']) {
    if (!Array.isArray(settings[field])) continue;
    const trimmed = settings[field].map(s => String(s || '').trim()).filter(Boolean);
    if (trimmed.length !== settings[field].length ||
        trimmed.some((v, i) => v !== settings[field][i])) {
      settings[field] = trimmed;
      vrChanged = true;
    }
  }
  if (vrChanged) {
    saveSettings();
    if (typeof vcOnSettingChange === 'function') vcOnSettingChange('vrGood');
  }

  $('settings-overlay').classList.remove('open');
  $('info-btn').style.visibility = '';
  $('settings-btn').style.visibility = '';
  if (!_wasPaused && phase !== 'ready') { isPaused = false; lastTickTime = null; }
  // Restore bg-fill and meta-theme to current phase color
  // values: --color-orange-edge / --color-blue-break-dark / --color-bg-dark
  const bgEdge = phase === 'work' ? '#4d1903' : phase === 'break' ? '#080928' : '#0d0d0d';
  setBg(bgEdge);
  render();
});

// =================================================
// REVIEW PLAYER (Web Audio)
// =================================================
// Review playback runs through the unlocked AudioContext, NOT an <audio>
// element. Reasons:
//
// 1. iOS Safari gates HTMLMediaElement.play() per element + per src — every
//    fresh blob URL re-arms the gate. Voice-command-triggered review (the
//    Vosk worker → postMessage → handler → synthesized .click() chain)
//    can't satisfy the gesture requirement and used to fail with
//    NotAllowedError. Web Audio playback is governed by the AudioContext
//    unlock instead, which is one-time per session — works from any code
//    path forever.
// 2. Single decoded buffer used for both playback and waveform display.
//    Previously we held the encoded blob (alive in URL store), an
//    HTML <audio> element doing its own internal decode, AND a separate
//    OfflineAudioContext decode for the waveform. Now: one buffer.
// 3. No more URL.createObjectURL / revokeObjectURL pairs to track.
//
// Trade-offs:
// - Scrub position is sample-accurate at start, but resuming after scrub
//   requires creating a new BufferSource (BufferSource is one-shot per
//   spec). This causes a ~10–50 ms gap on resume. Imperceptible for
//   review of practice rounds.
// - Decoded buffer at the device's native rate (~48 kHz on iOS, 44.1 on
//   desktop) is ~10–12 MB/min in memory while the review overlay is open.
//   Freed on closeReview. The maxRecDur upper bound is set to 15 min to
//   keep this transient under iOS PWA budget.
let revKnownDuration  = 0;
let revTrimStart      = 0;   // seconds into raw audio where content begins
let revTrimEnd        = 0;   // seconds into raw audio where content ends

let reviewBuffer       = null;  // decoded AudioBuffer; alive only during review
let reviewSource       = null;  // current AudioBufferSourceNode (recreated on play/seek)
let reviewGain         = null;  // GainNode for review volume
let reviewPlaying      = false;
let reviewSeekOffset   = 0;     // playback position (sec) when source was last started
let reviewStartCtxTime = 0;     // audioCtx.currentTime when current source started
let reviewRafId        = null;  // rAF id for the time-display tick loop
let reviewStartWall    = 0;     // Date.now() when review overlay opened

function _revCurTime() {
  if (!reviewBuffer) return 0;
  if (reviewPlaying && audioCtx) {
    return Math.min(reviewBuffer.duration,
                    reviewSeekOffset + (audioCtx.currentTime - reviewStartCtxTime));
  }
  return reviewSeekOffset;
}

function _revSetPlayingUI(playing) {
  $('rev-icon-play').style.display  = playing ? 'none' : 'block';
  $('rev-icon-pause').style.display = playing ? 'block' : 'none';
}

function _revStartTickLoop() {
  if (reviewRafId !== null) return;
  const tick = () => {
    if (!reviewBuffer) { reviewRafId = null; return; }
    _revUpdateUI();
    if (reviewPlaying) {
      reviewRafId = requestAnimationFrame(tick);
    } else {
      reviewRafId = null;
    }
  };
  reviewRafId = requestAnimationFrame(tick);
}

function _revStopTickLoop() {
  if (reviewRafId !== null) {
    cancelAnimationFrame(reviewRafId);
    reviewRafId = null;
  }
}

function _revStartFrom(offsetSec) {
  if (!reviewBuffer || !audioCtx || !reviewGain) return;
  // BufferSource is one-shot per spec — create a fresh node every play/seek.
  if (reviewSource) {
    try { reviewSource.onended = null; reviewSource.stop(); } catch (e) {}
    try { reviewSource.disconnect(); } catch (e) {}
    reviewSource = null;
  }
  const safeOffset = Math.max(0, Math.min(reviewBuffer.duration, offsetSec));
  reviewSource = audioCtx.createBufferSource();
  reviewSource.buffer = reviewBuffer;
  reviewSource.connect(reviewGain);
  reviewSource.onended = _revOnSourceEnded;
  reviewSource.start(0, safeOffset);
  reviewSeekOffset   = safeOffset;
  reviewStartCtxTime = audioCtx.currentTime;
  reviewPlaying      = true;
  _revSetPlayingUI(true);
  _revStartTickLoop();
}

function _revStop() {
  if (!reviewSource) {
    reviewPlaying = false;
    _revSetPlayingUI(false);
    _revStopTickLoop();
    return;
  }
  // Capture position before stop — _revCurTime() relies on reviewPlaying
  // being true to do the math, so read it first.
  const cur = _revCurTime();
  try { reviewSource.onended = null; reviewSource.stop(); } catch (e) {}
  try { reviewSource.disconnect(); } catch (e) {}
  reviewSource = null;
  reviewSeekOffset = cur;
  reviewPlaying = false;
  _revSetPlayingUI(false);
  _revStopTickLoop();
}

function _revOnSourceEnded() {
  // Fires when the source ends naturally (buffer fully consumed). We clear
  // .onended in _revStop and _revStartFrom before stopping the existing
  // source, so this only runs for natural end-of-buffer.
  if (!reviewPlaying) return;
  reviewPlaying = false;
  reviewSeekOffset = reviewBuffer ? reviewBuffer.duration : 0;
  _revSetPlayingUI(false);
  _revStopTickLoop();
}

function _revTogglePlayPause() {
  if (!reviewBuffer) return;
  if (reviewPlaying) {
    _revStop();
  } else {
    _revStartFrom(reviewSeekOffset);
  }
}

function _revSeekTo(timeSec) {
  if (!reviewBuffer) return;
  const t = Math.max(0, Math.min(reviewBuffer.duration, timeSec));
  if (reviewPlaying) {
    _revStartFrom(t);
  } else {
    reviewSeekOffset = t;
    _revUpdateUI();
  }
}

function _revUpdateUI() {
  if (!reviewBuffer) return;
  const cur     = _revCurTime();
  const trimEnd = revTrimEnd > 0 ? revTrimEnd : (revKnownDuration || 0);
  const trimDur = trimEnd - revTrimStart;

  // Auto-pause at trim end
  if (revTrimEnd > 0 && cur >= revTrimEnd && reviewPlaying) {
    _revStop();
    reviewSeekOffset = revTrimEnd;
    return;
  }

  const trimCur = Math.max(0, cur - revTrimStart);
  $('rev-cur').textContent = fmtF(trimCur);
  if (trimDur > 0) $('rev-prog').style.width = (100 * Math.min(1, trimCur / trimDur)) + '%';
}

// Trim-detect + waveform-render from the already-decoded reviewBuffer. The
// trim loop strides coarsely (10 ms steps) instead of sample-by-sample —
// 50 ms padding makes finer accuracy meaningless and saves ~480× iterations
// at 48 kHz native rate.
function _revCalcTrimAndDraw() {
  if (!reviewBuffer) return;
  const canvas = $('rev-canvas');
  const ctx2d  = canvas.getContext('2d');
  const rect   = canvas.getBoundingClientRect();
  const W = Math.floor(rect.width  * (window.devicePixelRatio || 1));
  const H = Math.floor(rect.height * (window.devicePixelRatio || 1));
  canvas.width = W; canvas.height = H;

  const data   = reviewBuffer.getChannelData(0);
  const sr     = reviewBuffer.sampleRate;
  const THRESH = 0.01;
  const PAD    = Math.floor(0.05 * sr); // 50 ms padding
  const stride = Math.max(1, Math.floor(0.010 * sr)); // 10 ms scan stride

  let tStart = 0, tEnd = data.length - 1;
  for (let i = 0; i < data.length; i += stride) {
    if (Math.abs(data[i]) > THRESH) { tStart = Math.max(0, i - PAD); break; }
  }
  for (let i = data.length - 1; i >= 0; i -= stride) {
    if (Math.abs(data[i]) > THRESH) { tEnd = Math.min(data.length - 1, i + PAD); break; }
  }
  revTrimStart = tStart / sr;
  revTrimEnd   = tEnd   / sr;

  $('rev-dur').textContent = fmtF(revTrimEnd - revTrimStart);

  // Per-pixel peak detection over trimmed range
  const trimLen = tEnd - tStart + 1;
  const step    = Math.max(1, Math.floor(trimLen / W));
  ctx2d.clearRect(0, 0, W, H);
  ctx2d.fillStyle = 'rgba(255,255,255,0.60)';
  for (let x = 0; x < W; x++) {
    let peak = 0;
    const base = tStart + x * step;
    for (let i = 0; i < step; i++) {
      const v = Math.abs(data[base + i] || 0);
      if (v > peak) peak = v;
    }
    const barH = Math.max(2, peak * H * 0.88);
    ctx2d.fillRect(x, (H - barH) / 2, 1, barH);
  }
}

async function openReview() {
  if (!reviewBlob) return;
  // ensureAudio() is async; openReview is called from a click handler so
  // the synchronous-resume rule is satisfied. Kick the unlock off (it's
  // idempotent if already unlocked) before any await.
  ensureAudio();

  const _wasAlreadyPaused = isPaused;
  if (!isPaused) { isPaused = true; render(); }
  openReview._wasAlreadyPaused = _wasAlreadyPaused;
  reviewStartWall = Date.now();

  // Set bg-fill to review green (--color-green-dark edge)
  setBg('#0b1910');

  // Reset state
  revKnownDuration   = 0;
  revTrimStart       = 0;
  revTrimEnd         = 0;
  reviewSeekOffset   = 0;
  reviewStartCtxTime = 0;
  reviewPlaying      = false;
  _revSetPlayingUI(false);

  // Stale buffer/source cleanup (defensive — close should have run)
  if (reviewSource) {
    try { reviewSource.onended = null; reviewSource.stop(); } catch (e) {}
    try { reviewSource.disconnect(); } catch (e) {}
    reviewSource = null;
  }
  reviewBuffer = null;

  // Show overlay immediately with placeholder values; decode follows
  $('rev-cur').textContent = '0:00';
  $('rev-dur').textContent = '...';
  $('rev-prog').style.width = '0%';
  $('rev-vol').value = parseFloat(settings.reviewVol) || 0.8;
  $('review-overlay').classList.add('open');

  try {
    const buf = await reviewBlob.arrayBuffer();
    if (!audioCtx) {
      console.warn('review: audioCtx unavailable after ensureAudio');
      return;
    }
    // Decode through the live AudioContext at its native sample rate.
    // The decoded buffer is reused for both playback and waveform.
    reviewBuffer = await audioCtx.decodeAudioData(buf.slice(0));
    revKnownDuration = reviewBuffer.duration;

    // Set up gain node (kept alive for the review session)
    if (reviewGain) {
      try { reviewGain.disconnect(); } catch (_) {}
    }
    reviewGain = audioCtx.createGain();
    reviewGain.gain.value = parseFloat(settings.reviewVol) || 0.8;
    reviewGain.connect(audioCtx.destination);

    _revCalcTrimAndDraw();

    // Auto-start at trim start. Voice-triggered or tap-triggered — both
    // work because the AudioContext is already unlocked.
    _revStartFrom(revTrimStart);
  } catch (err) {
    console.warn('review decode/start failed:', err);
    _revSetPlayingUI(false);
  }
}

$('rev-wave').addEventListener('click', e => {
  if (!reviewBuffer || !revKnownDuration) return;
  const rect    = $('rev-wave').getBoundingClientRect();
  const frac    = (e.clientX - rect.left) / rect.width;
  const trimEnd = revTrimEnd > 0 ? revTrimEnd : revKnownDuration;
  const trimDur = trimEnd - revTrimStart;
  const t       = revTrimStart + frac * trimDur;
  if (reviewPlaying) {
    _revStartFrom(t);
  } else {
    _revStartFrom(t); // wave-tap always starts playback from the new spot
  }
});

// Drag-to-scrub: slide anywhere on review overlay to move playhead
// proportionally to waveform display (1px drag = 1px on waveform timeline).
(function () {
  const overlay = $('review-overlay');
  let dragStartX     = null;
  let lastDragX      = null;
  let hasDragged     = false;
  let wasPlayingPre  = false;
  let dragDownTarget = null;

  overlay.addEventListener('pointerdown', e => {
    if (e.target.closest('button, input')) return;
    dragStartX     = e.clientX;
    lastDragX      = e.clientX;
    hasDragged     = false;
    wasPlayingPre  = false;
    dragDownTarget = e.target;
    overlay.setPointerCapture(e.pointerId);
  });

  overlay.addEventListener('pointermove', e => {
    if (dragStartX === null || !reviewBuffer || !revKnownDuration) return;
    const deltaX = e.clientX - lastDragX;
    if (Math.abs(e.clientX - dragStartX) > 6) {
      if (!hasDragged) {
        // Tap → drag transition. Pause if playing so scrub position is
        // stable; we'll resume on drag-end if needed.
        wasPlayingPre = reviewPlaying;
        if (reviewPlaying) _revStop();
        hasDragged = true;
      }
    }
    if (!hasDragged || deltaX === 0) return;
    const waveRect  = $('rev-wave').getBoundingClientRect();
    const trimEnd   = revTrimEnd > 0 ? revTrimEnd : revKnownDuration;
    const trimDur   = trimEnd - revTrimStart;
    const secsPerPx = trimDur / waveRect.width;
    reviewSeekOffset = Math.max(revTrimStart, Math.min(trimEnd,
      reviewSeekOffset + deltaX * secsPerPx));
    _revUpdateUI();
    lastDragX = e.clientX;
  });

  const endDrag = () => {
    if (hasDragged && wasPlayingPre && reviewBuffer) {
      _revStartFrom(reviewSeekOffset);
    } else if (!hasDragged && dragDownTarget && !dragDownTarget.closest('#rev-wave') && reviewBuffer) {
      _revTogglePlayPause();
    }
    dragStartX     = null;
    lastDragX      = null;
    dragDownTarget = null;
  };
  overlay.addEventListener('pointerup',     endDrag);
  overlay.addEventListener('pointercancel', endDrag);

  // Suppress the waveform tap-to-seek click when a drag just finished
  $('rev-wave').addEventListener('click', e => {
    if (hasDragged) { e.stopImmediatePropagation(); hasDragged = false; }
  }, true);
}());

function closeReview() {
  // Stop playback + free the decoded buffer.
  _revStop();
  reviewBuffer = null;
  if (reviewGain) {
    try { reviewGain.disconnect(); } catch (_) {}
    reviewGain = null;
  }

  $('review-overlay').classList.remove('open');
  // If breaks count as practice, credit the review time to practiceTime
  if (settings.breaksCountAsPractice && reviewStartWall > 0 && phase === 'break') {
    practiceTime += (Date.now() - reviewStartWall) / 1000;
  }
  reviewStartWall = 0;
  // Resume countdown if it was running before review opened
  if (!openReview._wasAlreadyPaused) {
    isPaused = false;
    lastTickTime = null;
  }
  // Restore bg-fill to current phase color
  const bgEdge = phase === 'work' ? '#4d1903' : phase === 'break' ? '#080928' : '#0d0d0d';
  setBg(bgEdge);
  // Play review-close sound
  ensureAudio();
  beep(392, 0.40, 0.28, 'sine', 0.0);   // G4
  beep(261.6, 0.80, 0.25, 'sine', 0.45); // C4
}

$('rev-restart').addEventListener('click', () => {
  if (reviewBuffer) _revStartFrom(revTrimStart);
});
$('rev-back5').addEventListener('click', () => {
  if (!reviewBuffer) return;
  _revSeekTo(Math.max(revTrimStart, _revCurTime() - 5));
});
$('rev-playpause').addEventListener('click', _revTogglePlayPause);
$('rev-fwd5').addEventListener('click', () => {
  if (!reviewBuffer) return;
  const trimEnd = revTrimEnd > 0 ? revTrimEnd : revKnownDuration;
  _revSeekTo(Math.min(trimEnd, _revCurTime() + 5));
});
$('rev-exit').addEventListener('click', closeReview);

$('rev-vol').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  settings.reviewVol = v;
  if (reviewGain) reviewGain.gain.value = v;
  saveSettings();
});

// =================================================
// INFO & CLOSE BUTTONS
// =================================================
$('info-btn').addEventListener('click', () => {
  const bd = $('build-date-display');
  if (bd) bd.textContent = 'build ' + (typeof BUILD_DATE === 'string' ? BUILD_DATE : '(unknown)');
  $('info-overlay').classList.add('open');
  $('info-btn').style.visibility = 'hidden';
  $('settings-btn').style.visibility = 'hidden';
  setBg('#c9c4bc'); /* muted parchment edge — app-specific */
});
$('info-close-btn').addEventListener('click', () => {
  $('info-overlay').classList.remove('open');
  $('info-btn').style.visibility = '';
  $('settings-btn').style.visibility = '';
  render();
});
$('info-close-btn-bottom').addEventListener('click', () => {
  $('info-overlay').classList.remove('open');
  $('info-btn').style.visibility = '';
  $('settings-btn').style.visibility = '';
  render();
});

$('close-btn').addEventListener('click', () => {
  ensureAudio();
  beep(196, 0.45, 0.30, 'sine', 0.0); // G3
  beep(131, 0.90, 0.28, 'sine', 0.5);  // C3
  stopRecording();
  reviewBlob = null;
  currentRound = 0;
  practiceTime = 0; chunkStartTime = null;
  setTimeout(() => {
    phase = 'ready'; isPaused = false; phaseTimeLeft = 0;
    waitingToAdvance = false;
    render();
  }, 1600);
});

// =================================================
// WELCOME / HELLO / LAUNCH GATE
// =================================================
//
// Two launch-gate overlays, mutually exclusive per page session:
//
// - Welcome: long onboarding doc; shown ONCE per install (or after Hard
//   Reset / Welcome-Reset). Casey's first-impression screen.
// - Hello: minimal session-start gate; shown on EVERY fresh page session
//   after Welcome has been seen, IF voice is enabled in settings. Each
//   page reload — whether the user chose to reload, iOS killed the app,
//   the phone rebooted, etc. — destroys the AudioContext, the mic stream,
//   and the Vosk recognizer. Re-establishing them needs a fresh user
//   gesture, and Hello provides it. So this is per-session, not per-day:
//   "session" = one continuous run of the JS module. (See the Resume
//   screen below for the visibility-restore equivalent within a session.)
//
// Both have the same two-button choice:
//   "Start with voice recognition" — voice + mic both armed for this session
//   "No thanks, I'll use the buttons" — voice suppressed, mic only if
//                                        recording feature is on
//
// Persistent settings (settings.voiceCommands, settings.recording) are NOT
// changed by these buttons — they're the user's day-to-day preference. The
// "No thanks" choice is per-session: voice stays loaded only via Settings
// toggle later in the session if the user changes their mind.
//
// CRITICAL iOS detail: ensureAudio() and acquireMic() must be *initiated*
// synchronously inside the click handler (no awaits before either call).
// iOS Safari requires getUserMedia() and AudioContext.resume() to start
// inside the user-gesture stack — once an `await` runs, we're in a
// microtask continuation and the gesture is gone. Both _onLaunchChoice
// invocations kick both promises off synchronously, then await via
// Promise.all.
let welcomeIsOpen = false;
let helloIsOpen   = false;

function openWelcome() {
  welcomeIsOpen = true;
  const wbd = $('welcome-build-date');
  if (wbd) wbd.textContent = 'build ' + (typeof BUILD_DATE === 'string' ? BUILD_DATE : '(unknown)');
  $('welcome-overlay').classList.add('open');
  $('app').style.visibility = 'hidden';
}

function openHello() {
  helloIsOpen = true;
  const hbd = $('hello-build-date');
  if (hbd) hbd.textContent = 'build ' + (typeof BUILD_DATE === 'string' ? BUILD_DATE : '(unknown)');
  $('hello-overlay').classList.add('open');
  $('app').style.visibility = 'hidden';
}

function closeWelcome(withVoice) {
  welcomeIsOpen = false;
  try { localStorage.setItem('mb-seen-welcome', '1'); } catch (e) {}
  $('welcome-overlay').classList.remove('open');
  $('app').style.visibility = '';
  _launchGateCleared = true;
  _onLaunchChoice(!!withVoice);
}

function closeHello(withVoice) {
  helloIsOpen = false;
  $('hello-overlay').classList.remove('open');
  $('app').style.visibility = '';
  _launchGateCleared = true;
  _onLaunchChoice(!!withVoice);
}

function _onLaunchChoice(withVoice) {
  // The user-gesture click that triggered this is still active. Kick off
  // ensureAudio() + acquireMic() synchronously before any await so iOS
  // accepts both calls inside the gesture stack.

  // Audio context unlock — needed regardless of voice/mic choices, because
  // chimes still play through it.
  const audioP = ensureAudio();

  // Mic acquisition decision:
  //   withVoice = true  → always acquire (voice needs it)
  //   withVoice = false → acquire only if recording is enabled in settings
  //   both off          → no mic acquisition (chimes don't need mic)
  const wantMic = withVoice || settings.recording;
  const micP    = (wantMic && !micStream) ? acquireMic() : Promise.resolve(true);

  // Per-session voice suppression. Persistent settings.voiceCommands is
  // unchanged; this flag is in-memory and gates vcKickOffLoad / vcStart.
  // Setting Settings → "Listen for voice commands" back ON later in the
  // session clears this via vcOnSettingChange.
  if (typeof setVoiceSessionSuppressed === 'function') {
    setVoiceSessionSuppressed(!withVoice);
  }

  if (withVoice && settings.voiceCommands) {
    // Kick off Vosk load (deferred from boot to avoid iOS PWA memory
    // pressure on cold launch).
    if (typeof vcKickOffLoad === 'function') vcKickOffLoad();
    Promise.all([audioP, micP]).then(() => {
      wlAcquire('launch');
      if (typeof vcStart === 'function') vcStart();
    }).catch((e) => {
      console.warn('[ui] launch-choice audio init failed:', e);
    });
  } else {
    Promise.all([audioP, micP]).then(() => {
      wlAcquire('launch');
    }).catch((e) => {
      console.warn('[ui] launch-choice audio init failed:', e);
    });
  }

  // If a voice model load is already in flight, surface the loader.
  if (typeof vc !== 'undefined' && vc && vc.state === 'loading') {
    const el = $('vc-loader');
    if (el) el.hidden = false;
  }
}

function resetWelcome() {
  // Clear Welcome-seen so next launch shows Welcome instead of Hello.
  try { localStorage.removeItem('mb-seen-welcome'); } catch (e) {}
  const btn = $('welcome-reset-btn');
  if (!btn) return;
  btn.textContent = 'Done!';
  btn.disabled = true;
  setTimeout(() => { btn.textContent = 'Reset'; btn.disabled = false; }, 1500);
}

async function reloadFromServer() {
  // Bulletproof "I want the latest" — unregister all SWs and delete every
  // cache (including fonts) so the reload hits raw network. One slow load,
  // but the user explicitly asked for the latest.
  //
  // Critical safety check: if the user is offline at this moment, the
  // wipe-then-reload path has nothing to fall back on — no SW, no cache,
  // no network → the app is unrecoverable until they reconnect. Probe the
  // origin BEFORE wiping. We use a cache-busting query so the SW's
  // cache-first match misses and the request actually hits the network.
  // navigator.onLine is unreliable on iOS (can be true behind a captive
  // portal or DNS-only WiFi), so we use a real fetch.
  try {
    const probe = await fetch('sw.js?reload-probe=' + Date.now(), { cache: 'no-store' });
    if (!probe.ok) throw new Error('probe non-ok: ' + probe.status);
  } catch (_) {
    alert('Cannot reach the server right now. Reload aborted — reconnect to the internet and try again.');
    return;
  }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (e) { /* ignore — reload anyway */ }
  window.location.replace(window.location.pathname);
}

// ── Launch gate decision ─────────────────────────────────────────────
// On every page load, decide which (if any) launch overlay to show:
//   1. Never seen Welcome → show Welcome (covers first install,
//      Hard Reset, or explicit Welcome-Reset)
//   2. Voice enabled in settings → show Hello (every fresh session
//      needs a user-gesture moment to (re)acquire mic and (re)load the
//      Vosk recognizer; iOS-killed sessions, phone reboots, manual
//      reloads all trigger this — it's per-session, not per-day)
//   3. Voice disabled — no gate (recording-only path acquires mic on
//      Start Practice tap; chimes-only path needs nothing)
let _launchGateCleared = false;

function openLaunchGate() {
  // If the upgrade modal from index.html's inline boot script is showing,
  // hold off on Welcome / Hello entirely — letting them open creates a
  // visible race where the user sees the upgrade modal "flash" and then
  // get visually replaced by the launch gate even though z-index keeps
  // the modal layered above. The OK button on the modal does a full
  // reload, so this function will run again on the post-reload page.
  const upgrade = $('upgrade-overlay');
  if (upgrade && upgrade.classList.contains('open')) {
    console.log('[gate] launch deferred — upgrade modal open');
    return;
  }
  let seenWelcome = false;
  try {
    seenWelcome = localStorage.getItem('mb-seen-welcome') === '1';
  } catch (e) {}

  // Diagnostic — captured by diag-log.js so we can later see why a given
  // launch chose Welcome / Hello / no-gate. Casey reported "Hello never
  // shows" without log access; this line lets us triangulate next time
  // logs are available.
  console.log('[gate] launch — seenWelcome=' + seenWelcome +
              ' voice=' + !!settings.voiceCommands +
              ' recording=' + !!settings.recording);

  if (!seenWelcome) {
    openWelcome();
  } else if (settings.voiceCommands) {
    openHello();
  } else {
    // No gate. App boots straight to Ready. First user interaction
    // (e.g. Start Practice tap) acquires the mic if recording is on
    // and unlocks the AudioContext for chimes.
    _launchGateCleared = true;
  }
}
document.addEventListener('DOMContentLoaded', openLaunchGate);
if (document.readyState !== 'loading') openLaunchGate();

// ── Resume screen (visibility-restore gate) ──────────────────────────
//
// iOS tears down the AudioContext (and may invalidate the mic stream)
// when the app backgrounds. Re-establishing both requires a fresh user
// gesture per Apple's policy. Without an explicit prompt, the user can
// try a voice command on return and have nothing happen — confusing and
// frustrating. The Resume screen makes the requirement honest: a small
// modal floating over whatever screen they were on, single Resume
// button, plain explanation.
//
// Only fires if (a) launch gate has already cleared (so it doesn't
// stack on top of Welcome/Hello during initial load) and (b) at least
// one mic-using feature is enabled in settings. If both are off, the
// chimes-only path doesn't need a fresh gesture for anything special;
// the implicit pointerdown unlock is sufficient.

// Tracks why showResume() was invoked, so closeResume() can pick the
// right rebuild strategy. 'vc-failure' is the heaviest case — the audio
// + mic looked healthy but vcStart blew up on the worklet, suggesting
// some persistent corruption that survives a normal vcKickOffLoad
// rebuild. In that case we wipe /vosk IDB to force a full network
// re-download (same path as the manual "Wipe cache" diagnostic).
let _resumeReason = null;

function showResume(reason) {
  if (welcomeIsOpen || helloIsOpen) return;
  if (!(settings.voiceCommands || settings.recording)) return;
  _resumeReason = reason || 'unknown';
  $('resume-overlay').classList.add('open');
}

function closeResume() {
  $('resume-overlay').classList.remove('open');
  const reason = _resumeReason;
  _resumeReason = null;
  _performResumeRebuild(reason);
}

// Body of the rebuild work, callable WITHOUT showing the overlay.
// On PWA, only closeResume() invokes this (after the user taps the
// Resume button, which provides the gesture frame iOS requires for
// getUserMedia). On Cap, _onMaybeForegrounded invokes it directly,
// bypassing the modal — native permission grant means getUserMedia
// outside a gesture is permitted.
function _performResumeRebuild(reason) {
  // Pre-flight: validate the cached mic stream BEFORE deciding whether
  // to re-acquire. iOS may end the underlying audio source during a
  // long background — that turns each track's readyState to 'ended'.
  // If our stream is dead, drop it now so the acquireMic() below
  // re-acquires fresh. On PWA the call site is the Resume button,
  // which provides the gesture frame Safari requires for getUserMedia.
  // On Cap the call site is _onMaybeForegrounded — no gesture, but
  // native permission grant makes getUserMedia outside a gesture
  // permitted there. If the cached stream is still live, reuse it —
  // re-acquiring needlessly would trigger iOS's own mic-toggle
  // indicator sounds.
  if (micStream && typeof micStreamIsLive === 'function' && !micStreamIsLive()) {
    console.log('[gate] resume: mic stream invalidated by iOS, re-acquiring');
    try { micStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    micStream = null;
  }

  // Always nukeAudioCtx + ensureAudio inside the gesture frame.
  // isAudioContextHealthy() has been observed to return false positives
  // (state='running', currentTime advances slightly, no audio heard) —
  // a zombie-after-Resume failure ear-tuner hit and microbreaker is
  // structurally identical to. The user already paid the gesture cost on
  // the Resume tap, so a fresh AudioContext is cheap insurance. See
  // _shared/js/visibility-recovery.md Phase 3.
  if (typeof nukeAudioCtx === 'function') nukeAudioCtx('resume-rebuild');
  const audioP  = ensureAudio();
  const wantMic = settings.voiceCommands || settings.recording;
  const micP    = (wantMic && !micStream) ? acquireMic() : Promise.resolve(true);

  // Honor the per-session voice-suppress flag from launch — if user
  // chose "No thanks, I'll use the buttons" on Hello/Welcome, don't
  // resume voice unless they've toggled it back on in Settings since.
  const voiceArmed = !!settings.voiceCommands &&
    (typeof _vcSuppressedThisSession === 'undefined' || !_vcSuppressedThisSession);

  console.log('[gate] resume rebuild — reason=' + reason + ' voiceArmed=' + voiceArmed);

  if (voiceArmed) {
    // 'vc-failure' takes the heavy path: wipe /vosk IDB and re-download.
    // Other reasons (audio/mic broken at probe time) only need the
    // standard rebuild — vc itself was fine, just the audio plumbing.
    if (reason === 'vc-failure' && typeof vcWipeAndRebuild === 'function') {
      vcWipeAndRebuild('resume');
    } else if (typeof vcKickOffLoad === 'function') {
      vcKickOffLoad();
    }
    Promise.all([audioP, micP]).then(() => {
      wlAcquire('resume');
      // Three vc states are possible at this point:
      //   'ready'       — vc survived (most regains land here): explicit
      //                   vcStart needed; auto-start won't fire because
      //                   no loading→ready transition happens.
      //   'loading'     — vc was destroyed + recreated by vcKickOffLoad
      //                   or vcWipeAndRebuild; the loading→ready
      //                   auto-start in vcOnStateChange will pick it up.
      //   'listening'   — defensive; vcStart is a no-op in that state.
      if (typeof vc !== 'undefined' && vc && vc.state === 'ready'
          && typeof vcStart === 'function') {
        vcStart();
      }
    }).catch((e) => console.warn('[ui] resume failed:', e));
  } else {
    Promise.all([audioP, micP]).then(() => {
      wlAcquire('resume');
    }).catch((e) => console.warn('[ui] resume failed:', e));
  }
}

// Multi-event background/foreground detection. iOS Safari does NOT
// reliably fire `visibilitychange` on quick away-and-back swipes — the
// app can be invisible for a second or two without the event firing.
// We OR `visibilitychange` with `pagehide`/`pageshow` so at least one
// fires for every real away-and-back. A `_wasBackgrounded` latch
// prevents double-firing when multiple events fire for the same
// transition.
//
// NOTE: `blur`/`focus` are NOT used. They fire for ANY focus loss,
// including iOS system overlays (mic permission prompt, Notification
// Center pulldown, Control Center, share sheet) — none of which are
// real backgroundings. Using them caused the Resume modal to appear
// immediately after the user accepted the mic permission prompt, because
// the prompt itself triggered blur → _wasBackgrounded=true, and the
// user's "Allow" tap returned focus → showResume() fired.
let _wasBackgrounded = false;

function _onMaybeBackgrounded() {
  if (_wasBackgrounded) return;
  _wasBackgrounded = true;
  console.log('[gate] backgrounded');
  // Mute master gain so any in-flight oscillators don't bleed across the
  // boundary. (audio-ctx.js's own visibilitychange handler also mutes —
  // belt-and-suspenders since visibilitychange is sometimes flaky on iOS.)
  if (typeof muteMasterGain === 'function') muteMasterGain();
  // Explicitly pause active mic consumers so we're not pretending to
  // record / process voice while the page is hidden. iOS may suspend JS
  // anyway, but being explicit lets us resume cleanly without leaving
  // half-finished state to discover later.
  if (typeof pauseRecording === 'function') pauseRecording();
  if (typeof vcStop === 'function') vcStop();
  // Mic stream and AudioContext stay alive — the foreground handler will
  // probe their health and route through Resume only if they're broken.
}

async function _onMaybeForegrounded() {
  if (!_wasBackgrounded) return;
  _wasBackgrounded = false;
  if (!_launchGateCleared) {
    console.log('[gate] foregrounded — launchCleared=false');
    return;
  }

  // ── Visibility-regain recovery model ─────────────────────────────
  //
  // Of the operations needed to restore audio + voice after iOS
  // backgrounded us, exactly ONE genuinely requires a user-gesture
  // frame: getUserMedia(). Everything else (new AudioContext, resume,
  // vc.load, vcStart, AudioWorkletNode) empirically works outside a
  // gesture once the session has had at least one earlier gesture.
  //
  // So the only case where we MUST show the Resume modal is when iOS
  // has invalidated the mic stream (micOk=false) — re-acquiring needs
  // a fresh user tap. Everything else can be rebuilt silently.
  //
  // Branches below, in order:
  //   1. micOk=false  → Resume modal (the one case needing a gesture).
  //   2. audioOk=false micOk=true  → silent audio rebuild.
  //   3. audioOk=true  micOk=true  → silent voice resume; if vcStart
  //                                  fails (worklet zombie), silent
  //                                  vc rebuild.
  //   4. Any silent rebuild that's still unhealthy after retry falls
  //      back to Resume modal as a true last resort.

  const audioOk = (typeof isAudioContextHealthy === 'function')
    ? await isAudioContextHealthy()
    : false;
  const wantMic = !!(settings.voiceCommands || settings.recording);
  const micOk   = !wantMic || (typeof micStreamIsLive === 'function' && micStreamIsLive());
  console.log('[gate] foregrounded — audioOk=' + audioOk + ' micOk=' + micOk);

  // ── Branch 1: mic invalidated → Resume modal (gesture needed) ────
  // On Cap, the gesture requirement doesn't apply (mic permission is
  // granted natively, so getUserMedia outside a gesture works), so we
  // skip the modal entirely and silently rebuild. PWA still needs the
  // modal because Safari standalone enforces the gesture rule.
  if (!micOk) {
    if (typeof micStream !== 'undefined' && micStream) {
      try { micStream.getTracks().forEach(t => t.stop()); } catch (_) {}
      micStream = null;
    }
    if (!audioOk && typeof nukeAudioCtx === 'function') {
      nukeAudioCtx('regain-unhealthy');
    }
    const reason = audioOk ? 'mic-stale' : 'audio-and-mic';
    if (typeof isNative === 'function' && isNative()) {
      console.log('[gate] silent resume on Cap — mic invalidated, re-acquiring without modal');
      _performResumeRebuild(reason);
    } else {
      showResume(reason);
    }
    return;
  }

  // ── Branch 2: audio unhealthy, mic alive → silent audio rebuild ──
  if (!audioOk) {
    console.log('[gate] silent rebuild — audio unhealthy');
    if (typeof nukeAudioCtx === 'function') nukeAudioCtx('regain-unhealthy');
    await ensureAudio();
    // Verify the new context actually woke up. AudioContext.resume()
    // outside a gesture *usually* works once the session has been
    // established, but is not 100% reliable per WebKit bug 263627.
    // If the rebuild didn't take, fall back to Resume.
    const audioOk2 = (typeof isAudioContextHealthy === 'function')
      ? await isAudioContextHealthy()
      : true;
    if (!audioOk2) {
      if (typeof isNative === 'function' && isNative()) {
        console.log('[gate] silent audio rebuild failed on Cap — full rebuild without modal');
        _performResumeRebuild('audio-unhealthy');
      } else {
        console.log('[gate] silent audio rebuild failed — escalating to Resume');
        showResume('audio-unhealthy');
      }
      return;
    }
  }

  // From here on, audio + mic are both healthy (either survived bg or
  // were silently rebuilt). Restore output gain and recording state.
  if (typeof unmuteMasterGain === 'function') unmuteMasterGain();
  if (typeof resumeRecording === 'function') resumeRecording();

  // Reacquire the screen wake lock if intent is still set. iOS auto-
  // releases the sentinel on background; this call is "best effort"
  // because visibility-regain is not a gesture in iOS's view. If the
  // request gets denied, the next real pointerdown will recover.
  if (typeof wlOnActivity === 'function') wlOnActivity('visibility-regain');

  const voiceArmed = !!settings.voiceCommands &&
    (typeof _vcSuppressedThisSession === 'undefined' || !_vcSuppressedThisSession);
  if (!voiceArmed) return;

  // ── Branch 3: voice resume ───────────────────────────────────────
  if (typeof vcStart === 'function') {
    const vrOk = await vcStart();
    if (vrOk) return;

    // ── SILENT FULL VOICE-MODEL RELOAD (no modal) ─────────────────
    //
    // vc.start() failed — typically DataCloneError on the worklet
    // port transfer at voice-commands.js:309. The AudioWorklet
    // processor was zombied independently of the AudioContext
    // rendering thread (iOS suspends them separately). The vc
    // instance is left with half-built state and won't recover on
    // simple retry, so we tear it down and rebuild from scratch:
    //
    //   1. vcDestroy() — frees the ~80MB Vosk WASM heap, vc=null.
    //   2. nukeAudioCtx + ensureAudio — fresh AudioContext so the
    //      new vc gets a fresh AudioWorklet processor.
    //   3. vcKickOffLoad() — creates a new vc and calls vc.load(),
    //      which reads the model from the /vosk IDB cache (~0.6s,
    //      no network). vc transitions idle→loading→ready.
    //   4. The loading→ready auto-start in vcOnStateChange fires
    //      vcStart() and the recognizer reaches 'listening'. VR is
    //      fully reloaded.
    //
    // None of those steps need a user gesture — that's why this
    // path can be silent. If the rebuild itself can't bring the
    // audio back to healthy (rare), we fall through to Resume,
    // and Resume's reason='vc-failure' branch escalates further to
    // vcWipeAndRebuild (which forces a network re-download of the
    // model — defense-in-depth for the case where the cached model
    // itself is corrupted).
    console.log('[gate] silent rebuild — vc failed (worklet zombie)');
    if (typeof vcDestroy === 'function') vcDestroy();
    if (typeof nukeAudioCtx === 'function') nukeAudioCtx('vcStart-failed-silent');
    await ensureAudio();
    const audioOk3 = (typeof isAudioContextHealthy === 'function')
      ? await isAudioContextHealthy()
      : true;
    if (!audioOk3) {
      if (typeof isNative === 'function' && isNative()) {
        console.log('[gate] silent vc rebuild — audioCtx unhealthy on Cap, full rebuild without modal');
        _performResumeRebuild('vc-failure');
      } else {
        console.log('[gate] silent vc rebuild — fresh audioCtx still unhealthy, escalating to Resume');
        showResume('vc-failure');
      }
      return;
    }
    if (typeof vcKickOffLoad === 'function') vcKickOffLoad();
    // Auto-start in vcOnStateChange fires vcStart on loading→ready.
    // No further action here.
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden')      _onMaybeBackgrounded();
  else if (document.visibilityState === 'visible') _onMaybeForegrounded();
});
window.addEventListener('pagehide', _onMaybeBackgrounded);
window.addEventListener('pageshow', _onMaybeForegrounded);

// Email obfuscation
(function(){
  var u='microbreaktimer', d='gmail.com';
  var a=document.getElementById('contact-link');
  if(a){ a.href='mailto:'+u+'@'+d; }
})();

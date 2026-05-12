'use strict';

// =================================================================
// VOICE COMMANDS — shared library
// -----------------------------------------------------------------
// Wraps vosk-browser to give apps a small command-and-control API:
//   - load model (delegated to Vosk's worker; it owns fetch + extract +
//     IDBFS caching internally)
//   - listen on a caller-provided MediaStream
//   - emit live transcript (partials + finals) for UI echo
//   - match finals against caller-defined command buckets
//   - rebuild ONLY the KaldiRecognizer when grammar/vocab changes,
//     keeping the Model (and its ~80 MB WASM heap) alive
//
// Depends on the vendored UMD vosk-browser at js/vosk-browser.js, which
// callers must load (lazily or eagerly) before constructing this. Exposes
// `Vosk` globally.
//
// Cache-key invariant
//   The model URL is the cache key in two places:
//     1. Vosk's internal IDBFS (`/vosk/<sanitized-url>/...`), keyed by
//        url.replace(/[\W]/g,'_')
//     2. The host app's "Wipe voice cache" diagnostic button (if present),
//        which deletes the entire `/vosk` IDB (URL-agnostic, so it survives
//        URL changes)
//   Any change to the model URL invalidates Vosk's cache for every existing
//   install and forces a fresh ~40 MB download. Bump deliberately.
//
// Memory note (2026-05-07 Phase 1 refactor)
//   We used to maintain our own IndexedDB cache of the tar.gz on top of
//   Vosk's IDBFS. That double-stored the model on disk and added an ~86 MB
//   main-thread peak per cold launch (chunks → concat → Blob → Blob URL).
//   We now hand Vosk the original network URL directly; its worker streams
//   straight to MEMFS and persists to its own IDBFS. See
//   research/voice-memory-efficiency.md for the full investigation.
//
// Usage:
//   const vc = createVoiceCommands({
//     modelUrl, workletUrl, commands, strictGrammar,
//     onCommand, onTranscript, onStateChange, onError,
//   });
//
//   await vc.load();
//   await vc.start(audioCtx, mediaStream);
//   ...
//   vc.setCommands(newCommands, newStrict);  // recognizer-only rebuild
//   vc.stop();
//   vc.destroy();
// =================================================================

function createVoiceCommands(opts) {
  const {
    modelUrl,
    workletUrl,
    commands       = {},
    strictGrammar: initialStrict = true,
    onCommand      = () => {},
    onTranscript   = () => {},
    onStateChange  = () => {},
    onError        = () => {},
  } = opts || {};

  // ---- Feature detection ---------------------------------------
  const supported = !!(
    typeof window !== 'undefined' &&
    window.Vosk &&
    window.AudioWorkletNode &&
    window.MessageChannel &&
    typeof WebAssembly !== 'undefined'
  );

  // ---- State ---------------------------------------------------
  let strictGrammar = !!initialStrict;
  let state = 'idle';   // 'idle' | 'loading' | 'ready' | 'listening' | 'error'
  let model = null;
  let recognizer = null;
  let recognizerChannel = null;
  let workletNode = null;
  let sourceNode = null;
  let audioCtx = null;
  let mediaStream = null;     // cached so setCommands can rebuild the recognizer
  let lastFinalText = '';     // for de-duping a quick repeated final event
  let lastFinalAt   = 0;
  const DUP_WINDOW_MS = 400;  // window in which an identical final is treated as a Vosk re-emit

  function setState(next) {
    if (state === next) return;
    state = next;
    try { onStateChange(state); } catch (e) {}
  }

  // ---- Command lookup table ------------------------------------
  // Flatten { claim:[...], reject:[...] } → [{ key:'good', name:'claim' }, ...]
  // Sort by descending key length so multi-word entries match before substrings.
  const cmdEntries = [];
  function rebuildCmdEntries(newCommands) {
    cmdEntries.length = 0;
    for (const name of Object.keys(newCommands || {})) {
      for (const phrase of (newCommands[name] || [])) {
        const key = String(phrase).toLowerCase().trim();
        if (key) cmdEntries.push({ key, name });
      }
    }
    cmdEntries.sort((a, b) => b.key.length - a.key.length);
  }
  rebuildCmdEntries(commands);

  function matchCommand(text) {
    const lower = (text || '').toLowerCase();
    if (!lower) return null;
    for (const { key, name } of cmdEntries) {
      // word-boundary check so "yes" doesn't match "yesterday"
      const re = new RegExp(`(^|\\s)${escapeRe(key)}(\\s|$)`);
      if (re.test(lower)) return { name, key };
    }
    return null;
  }

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // Build the grammar JSON string Vosk expects when strictGrammar is on.
  // Must include '[unk]' to give the recognizer a "none of the above" path.
  function buildGrammar() {
    const phrases = cmdEntries.map(e => e.key);
    return JSON.stringify(['[unk]', ...phrases]);
  }

  // ---- Model load (delegate to Vosk's worker) ------------------
  async function load() {
    if (state === 'loading' || state === 'ready' || state === 'listening') return;
    if (!supported) {
      onError(new Error('voice-commands: feature not supported in this browser'));
      setState('error');
      return;
    }
    setState('loading');

    const t0 = performance.now();
    try {
      // Construct Model directly (rather than calling Vosk.createModel) so we
      // can attach a worker-message listener BEFORE the load handshake — that
      // way every message the Vosk worker emits during fetch/extract surfaces
      // as a console log we can inspect when designing the progress UI. We
      // mirror Vosk.createModel's own resolution logic (await 'load', resolve
      // if message.result is truthy).
      const m = new window.Vosk.Model(modelUrl);
      try {
        m.worker.addEventListener('message', (e) => {
          const d = e.data;
          // Skip the high-frequency recognizer events; only load/extract chatter.
          if (!d || d.event === 'partialresult' || d.event === 'result') return;
          console.log('[vosk-worker]', d);
        });
      } catch (_) { /* worker handle missing — best-effort logging only */ }

      model = await new Promise((resolve, reject) => {
        m.on('load', (msg) => {
          if (msg && msg.result) resolve(m);
          else reject(new Error('Vosk model load failed'));
        });
        m.on('error', (msg) => reject(new Error((msg && msg.error) || 'Vosk error')));
      });
    } catch (e) {
      onError(e);
      setState('error');
      return;
    }
    const ms = Math.round(performance.now() - t0);
    // Diag-log auto-captures this since console.log/console.warn are wrapped.
    console.log(`[voice] model load: ${(ms / 1000).toFixed(1)}s`);

    setState('ready');

    // Phase 2: Free the ~78 MB MEMFS-resident extracted-model files now that
    // Kaldi has copied everything into WASM heap. Verified safe end-to-end
    // (recognizer rebuild + per-utterance recognition + post-unlink rebuild
    // with new vocab) on desktop 2026-05-08. The IDBFS persisted copy AND
    // the 'extracted.ok' marker are preserved, so warm-launch short-circuit
    // still fires next session. Best-effort — if vosk-browser.js is missing
    // the PHASE2-UNLINK-PATCH (e.g., re-vendored without re-running the
    // patch script), unlinkExtracted resolves with {error: 'unsupported'}
    // and we log + continue.
    unlinkExtracted().then((r) => {
      console.log('[voice] post-load MEMFS unlink:', JSON.stringify(r));
    });
  }

  // ---- Phase 2 experiment: post-load MEMFS unlink ----
  // Asks the (patched) Vosk worker to FS.unlink the extracted model files
  // in MEMFS while preserving the IDBFS persisted copy and the cache marker.
  // Resolves with {unlinked, errors, modelPath} or {error, reason} on failure.
  // Requires the PHASE2-UNLINK-PATCH applied to vosk-browser.js (the patch
  // is committed to _shared/js/vosk-browser.js; see the patch-script artifact
  // checked in alongside it for the re-patch recipe if vosk-browser is ever
  // re-vendored). Returns {error: 'unsupported'} if the worker doesn't
  // recognize the action — that's the signal we're running on an unpatched
  // build.
  async function unlinkExtracted() {
    if (!model || !model.worker) {
      return { error: 'no model loaded' };
    }
    return new Promise((resolve) => {
      let done = false;
      const handler = (e) => {
        const d = e.data;
        if (!d) return;
        if (d.event === 'unlinkResult') {
          if (done) return;
          done = true;
          model.worker.removeEventListener('message', handler);
          resolve(d);
        } else if (d.event === 'error' && typeof d.error === 'string' && d.error.indexOf('Unknown message') === 0) {
          // Unpatched worker — surfaced as the generic "Unknown message" path.
          if (done) return;
          done = true;
          model.worker.removeEventListener('message', handler);
          resolve({ error: 'unsupported', reason: 'worker did not recognize unlinkExtracted action — vosk-browser.js may be unpatched' });
        }
      };
      model.worker.addEventListener('message', handler);
      try {
        model.postMessage({ action: 'unlinkExtracted', modelUrl });
      } catch (e) {
        done = true;
        model.worker.removeEventListener('message', handler);
        resolve({ error: 'postMessage threw: ' + (e && e.message) });
        return;
      }
      setTimeout(() => {
        if (done) return;
        done = true;
        model.worker.removeEventListener('message', handler);
        resolve({ error: 'timeout (5s) waiting for unlinkResult' });
      }, 5000);
    });
  }

  // setCommands updates vocabulary/grammar AND, if currently listening,
  // rebuilds the KaldiRecognizer with the new grammar. The Model (and its
  // ~80 MB WASM heap) is preserved — only the recognizer (cheap, hundreds
  // of KB) is rebuilt. Phase-1 fix for the 150 MB transient cliff that
  // vc.destroy() + recreate used to inflict on every settings toggle.
  async function setCommands(newCommands, newStrict) {
    rebuildCmdEntries(newCommands);
    strictGrammar = !!newStrict;
    if (state === 'listening' && audioCtx && mediaStream) {
      const ctx = audioCtx;
      const ms = mediaStream;
      stop();
      await start(ctx, ms);
    }
  }

  // ---- Start / stop listening ---------------------------------
  // Caller passes their AudioContext + a MediaStream. We attach a worklet
  // node that pumps audio into the recognizer's worker via MessagePort.
  async function start(ctx, ms) {
    if (state === 'listening') return;
    if (state !== 'ready') {
      throw new Error(`voice-commands: cannot start in state '${state}'`);
    }

    audioCtx    = ctx;
    mediaStream = ms;
    const sr    = audioCtx.sampleRate;

    // Wire results BEFORE creating the recognizer so we don't miss early events.
    recognizer = new model.KaldiRecognizer(sr, strictGrammar ? buildGrammar() : undefined);

    recognizer.on('partialresult', (msg) => {
      const partial = (msg.result && msg.result.partial) || '';
      try { onTranscript(partial, false); } catch (e) {}
    });
    recognizer.on('result', (msg) => {
      const text = (msg.result && msg.result.text) || '';
      if (!text) return;
      // Vosk sometimes re-emits the same final on phrase boundary (within a
      // few ms). Bound the de-dup by time so a deliberate repeat — say,
      // "yes" ... "yes" — isn't squashed.
      const now = Date.now();
      if (text === lastFinalText && (now - lastFinalAt) < DUP_WINDOW_MS) return;
      lastFinalText = text;
      lastFinalAt   = now;
      try { onTranscript(text, true); } catch (e) {}
      const m = matchCommand(text);
      if (m) {
        try { onCommand(m.name, text); } catch (e) {}
      }
    });
    recognizer.on('error', (msg) => {
      const err = new Error(msg.error || 'recognizer error');
      onError(err);
    });

    // Hand the recognizer's worker port off to the worklet so audio chunks
    // skip the main thread entirely.
    recognizerChannel = new MessageChannel();
    model.registerPort(recognizerChannel.port1);

    // Add the worklet module (idempotent — addModule resolves immediately on
    // a re-register but throws if a *different* processor name was registered).
    await audioCtx.audioWorklet.addModule(workletUrl);

    workletNode = new AudioWorkletNode(audioCtx, 'voice-commands-processor', {
      channelCount:    1,
      numberOfInputs:  1,
      numberOfOutputs: 1,
    });
    workletNode.port.postMessage(
      { action: 'init', recognizerId: recognizer.id },
      [recognizerChannel.port2]
    );

    sourceNode = audioCtx.createMediaStreamSource(mediaStream);
    sourceNode.connect(workletNode);
    // Connect to destination so Chrome doesn't garbage-collect the worklet.
    // Outputs are silent (process() never writes to outputs[0]) so this is inaudible.
    workletNode.connect(audioCtx.destination);

    setState('listening');
  }

  function stop() {
    if (state !== 'listening') return;
    try { sourceNode && sourceNode.disconnect(); } catch (e) {}
    try { workletNode && workletNode.disconnect(); } catch (e) {}
    if (workletNode) {
      try { workletNode.port.postMessage({ action: 'shutdown' }); } catch (e) {}
    }
    sourceNode = null;
    workletNode = null;
    if (recognizer) {
      try { recognizer.remove(); } catch (e) {}
      recognizer = null;
    }
    if (recognizerChannel) {
      try { recognizerChannel.port1.close(); } catch (e) {}
      try { recognizerChannel.port2.close(); } catch (e) {}
      recognizerChannel = null;
    }
    lastFinalText = '';
    lastFinalAt   = 0;
    setState(model ? 'ready' : 'idle');
  }

  function destroy() {
    stop();
    if (model) {
      try { model.terminate(); } catch (e) {}
      model = null;
    }
    audioCtx    = null;
    mediaStream = null;
    setState('idle');
  }

  return {
    get supported() { return supported; },
    get state()     { return state; },
    load,
    start,
    stop,
    destroy,
    setCommands,
    unlinkExtracted,  // Phase 2 experiment; no-op on unpatched workers
  };
}

if (typeof window !== 'undefined') {
  window.createVoiceCommands = createVoiceCommands;
}

'use strict';

// AudioWorklet processor that bridges a MediaStreamSource to a vosk-browser
// KaldiRecognizer's worker via a transferred MessagePort.
//
// Pattern follows the vosk-browser "modern-vanilla" example. The processor is
// a bucket brigade: it scales each Float32 input frame to the int16 range that
// Kaldi expects (still represented as Float32, the recognizer worker handles
// the conversion) and posts it to the recognizer's worker over the message
// port that was transferred during init.
//
// AudioWorkletGlobalScope provides `sampleRate` (the rendering sample rate of
// the AudioContext that hosts this node). We pass it along on every chunk so
// the recognizer can resample if needed.

class VoiceCommandsProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this._recognizerId = null;
    this._recognizerPort = null;
    // Reusable scaled buffer. Pre-allocated to the standard 128-frame render
    // quantum and re-sized on the rare occasion a host serves a different
    // length. Allocating in the audio-render thread on every process() call
    // costs ~10 MB/min of GC churn during listening — and GC pauses on this
    // thread can audibly glitch. Hand the receiver a structured-clone copy
    // (no `transfer:` option) so our buffer survives postMessage.
    this._scaled = new Float32Array(128);
    this.port.onmessage = (event) => {
      if (event.data && event.data.action === 'init') {
        this._recognizerId   = event.data.recognizerId;
        this._recognizerPort = event.ports[0];
      } else if (event.data && event.data.action === 'shutdown') {
        if (this._recognizerPort) {
          try { this._recognizerPort.close(); } catch (e) {}
        }
        this._recognizerPort = null;
        this._recognizerId   = null;
      }
    };
  }

  process(inputs) {
    const channelData = inputs[0] && inputs[0][0];
    if (this._recognizerPort && channelData && channelData.length) {
      const n = channelData.length;
      if (this._scaled.length !== n) {
        this._scaled = new Float32Array(n);
      }
      const scaled = this._scaled;
      // Scale Float32 [-1.0, 1.0] to int16 numeric range, but keep Float32 type —
      // the vosk-browser worker's audioChunk handler expects Float32Array.
      for (let i = 0; i < n; i++) {
        scaled[i] = channelData[i] * 0x8000;
      }
      this._recognizerPort.postMessage({
        action:        'audioChunk',
        data:          scaled,
        recognizerId:  this._recognizerId,
        sampleRate:    sampleRate,
      });
    }
    return true;
  }
}

registerProcessor('voice-commands-processor', VoiceCommandsProcessor);

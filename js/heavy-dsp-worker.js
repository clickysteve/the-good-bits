// heavy-dsp-worker.js
//
// Offloads the CPU-heavy part of turning already-decoded, already-sliced audio into finished
// export blobs - WSOLA time-stretch, the lo-fi processing chain, fades, and WAV encoding - onto a
// background thread, so a big batch (or a single long file) doesn't block the page's main thread
// while it runs. Deliberately narrow: this worker only ever sees plain Float32Array channel data
// and settings objects, never the DOM, File System Access handles, or essentia - those all stay on
// the main thread (app.js), which slices the source audio and writes the results this worker hands
// back. See runHeavyDsp() in app.js for the calling side, including the same-thread fallback used
// if a worker can't be created at all (very old browsers, or a `file://` load).
import { stretchChannels } from "./timestretch.js";
import { applyLofiChain } from "./outputstage.js";
import { applyFades } from "./dsp.js";
import { encodeWav } from "./audio-codec.js";

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type !== "processRegions") return;
  const { requestId, sampleRate, bitDepth, fadeInSamples, fadeOutSamples, stretchRatio, character, macroValues, seed, lofi, regions } = msg;

  try {
    const results = regions.map(({ channels }) => {
      let sliced = channels;
      if (stretchRatio && stretchRatio !== 1) {
        sliced = stretchChannels(sliced, sampleRate, stretchRatio, character, { macroValues, seed });
      }
      sliced = applyLofiChain(sliced, sampleRate, lofi);
      applyFades(sliced, fadeInSamples || 0, fadeOutSamples || 0);
      const blob = encodeWav(sliced, sampleRate, bitDepth);
      return { blob, seconds: sliced[0].length / sampleRate };
    });
    self.postMessage({ type: "processRegionsResult", requestId, results });
  } catch (err) {
    self.postMessage({ type: "processRegionsError", requestId, message: (err && err.message) || String(err) });
  }
};

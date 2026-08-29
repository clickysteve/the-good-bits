// essentia-bridge.js
//
// Thin wrapper around essentia.js (loaded as two <script> tags in index.html,
// https://github.com/MTG/essentia.js) for key and tempo detection. Everything
// here degrades gracefully: if the CDN is unreachable or the WASM module
// fails to load, key/tempo detection is simply reported unavailable and the
// rest of the app (chopping itself) keeps working - key/tempo are enrichment,
// not a dependency of the core pipeline.
//
// Note on licensing: essentia.js is distributed under AGPL-3.0. That's a
// network-copyleft license - if you deploy this app publicly (e.g. GitHub
// Pages) its corresponding source must be available to anyone who uses it
// over the network. A public GitHub Pages repo already satisfies that, but
// it's worth knowing if you ever want to keep this app or a fork of it
// closed-source. See README.md for a permissive-license alternative if that
// ever matters to you.

const ESSENTIA_ANALYSIS_RATE = 44100; // KeyExtractor / rhythm algorithms assume this

let essentiaPromise = null;

function loadEssentia() {
  if (essentiaPromise) return essentiaPromise;
  essentiaPromise = new Promise((resolve) => {
    if (typeof window === "undefined" || typeof window.EssentiaWASM === "undefined" || typeof window.Essentia === "undefined") {
      resolve(null);
      return;
    }
    window
      .EssentiaWASM()
      .then((wasmModule) => {
        try {
          resolve(new window.Essentia(wasmModule));
        } catch (err) {
          console.warn("essentia.js failed to initialize:", err);
          resolve(null);
        }
      })
      .catch((err) => {
        console.warn("essentia.js WASM module failed to load:", err);
        resolve(null);
      });
  });
  return essentiaPromise;
}

/** True once we know whether essentia is usable (after the first await). */
export async function essentiaAvailable() {
  return (await loadEssentia()) !== null;
}

/**
 * Analyze a mono Float32Array (at any sample rate) for key and tempo.
 * Resamples internally to essentia's expected 44.1kHz analysis rate.
 * Returns null fields for anything that couldn't be computed.
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {{key:boolean, tempo:boolean}} want
 */
export async function analyzeKeyAndTempo(mono, sampleRate, want = { key: true, tempo: true }) {
  const essentia = await loadEssentia();
  const result = { key: null, scale: null, keyStrength: null, bpm: null, available: essentia !== null };
  if (!essentia) return result;

  const { resampleLinear } = await import("./dsp.js");
  const analysisMono = sampleRate === ESSENTIA_ANALYSIS_RATE ? mono : resampleLinear(mono, sampleRate, ESSENTIA_ANALYSIS_RATE);

  let vector = null;
  try {
    vector = essentia.arrayToVector(analysisMono);

    if (want.key) {
      try {
        const keyOut = essentia.KeyExtractor(vector);
        result.key = keyOut.key;
        result.scale = keyOut.scale;
        result.keyStrength = keyOut.strength;
      } catch (err) {
        console.warn("Key detection failed:", err);
      }
    }

    if (want.tempo) {
      try {
        const bpmOut = essentia.PercivalBpmEstimator(vector);
        const bpm = bpmOut.bpm;
        // Sanity-check: reject implausible results rather than trusting them blindly.
        result.bpm = bpm > 40 && bpm < 220 ? bpm : null;
      } catch (err) {
        console.warn("Tempo detection failed:", err);
      }
    }
  } finally {
    if (vector && typeof vector.delete === "function") {
      try {
        vector.delete();
      } catch (_) {
        /* ignore */
      }
    }
  }

  return result;
}

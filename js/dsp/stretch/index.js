// index.js
//
// The dispatcher between "UI character" and "DSP engine + parameters" the
// rest of the app talks to - see js/timestretch.js for the thin
// backwards-compatible facade app.js and heavy-dsp-worker.js actually
// import. Everything character-specific (which engine, what parameters,
// which macro sliders apply) lives in characters.js as data; this file just
// resolves a character to a params object and routes to the right engine
// function.
import { resolveCharacter, resolveCharacterParams } from "./characters.js";
import { stretchWsola } from "./wsola.js";
import { stretchPhaseVocoder } from "./phase-vocoder.js";
import { stretchGranular } from "./granular.js";
import { stretchRepeat } from "./repeat.js";
import { stretchSpectralFreeze } from "./spectral-freeze.js";
import { stretchPaulstretch } from "./paulstretch.js";
import { stretchVarispeed } from "./varispeed.js";

export * from "./characters.js";

const ENGINE_FNS = {
  wsola: (channels, sr, ratio, params) => stretchWsola(channels, sr, ratio, params),
  phaseVocoder: (channels, sr, ratio, params, seed) => stretchPhaseVocoder(channels, sr, ratio, params, seed),
  granular: (channels, sr, ratio, params, seed) => stretchGranular(channels, sr, ratio, params, seed),
  repeat: (channels, sr, ratio, params, seed) => stretchRepeat(channels, sr, ratio, params, seed),
  spectralFreeze: (channels, sr, ratio, params) => stretchSpectralFreeze(channels, sr, ratio, params),
  paulstretch: (channels, sr, ratio, params, seed) => stretchPaulstretch(channels, sr, ratio, params, seed),
  varispeed: (channels, sr, ratio) => stretchVarispeed(channels, ratio),
};

const DEFAULT_MAX_RATIO = 8;
const MIN_RATIO = 0.05;

/**
 * Time-stretch every channel using the named character. `ratio` = output length / input length.
 * `options`: { macroValues: {texture, variation, smear, roughness}, seed }. Unrecognised character
 * ids (an old id this version dropped, a typo, a corrupt saved setting) fall back to "clean" rather
 * than throwing, per resolveCharacter().
 */
export function stretchChannels(channels, sampleRate, ratio, characterKey, options = {}) {
  const character = resolveCharacter(characterKey);
  const maxRatio = character.maxRatio || DEFAULT_MAX_RATIO;
  const clamped = Math.max(MIN_RATIO, Math.min(maxRatio, ratio || 1));
  if (Math.abs(clamped - 1) < 1e-6) return channels.map((ch) => Float32Array.from(ch));

  const params = resolveCharacterParams(character, options.macroValues);
  const seed = options.seed ?? 1;
  const engineFn = ENGINE_FNS[character.engine] || ENGINE_FNS.wsola;
  const result = engineFn(channels, sampleRate, clamped, params, seed);

  // Belt-and-braces: scrub any non-finite sample and hard-clip runaway gain from a pathological
  // parameter combination, so a bad export can never contain NaN/Infinity or blow speakers - every
  // engine already tries hard not to produce these, this is just the last line of defence before
  // audio leaves the DSP layer.
  for (const ch of result) {
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      if (!Number.isFinite(v)) ch[i] = 0;
      else if (v > 4) ch[i] = 4;
      else if (v < -4) ch[i] = -4;
    }
  }
  return result;
}

/** ratio to feed stretchChannels so a recording detected at `detectedBpm` plays back at `targetBpm`. */
export function ratioForTargetTempo(detectedBpm, targetBpm) {
  if (!detectedBpm || !targetBpm) return 1;
  return detectedBpm / targetBpm;
}

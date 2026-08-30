// timestretch.js
//
// Thin, backwards-compatible facade over the real time-stretch system in
// js/dsp/stretch/ (dispatcher + engines + the character registry). This file
// used to contain the entire WSOLA implementation directly; it now just
// re-exports the pieces app.js and heavy-dsp-worker.js need, so neither of
// those files (nor anything importing from here) had to change its import
// paths when the palette grew from one engine/five characters to seven
// engines/dozens of characters. See js/dsp/stretch/index.js for the
// dispatcher and js/dsp/stretch/characters.js for the character registry.
export { stretchChannels, ratioForTargetTempo, resolveCharacter, resolveCharacterParams, characterGroups, CHARACTERS, GROUPS, MACROS } from "./dsp/stretch/index.js";

import { stretchWsola } from "./dsp/stretch/wsola.js";
import { resolveCharacter as resolveCharacterFor } from "./dsp/stretch/characters.js";

/**
 * Kept for any direct WSOLA caller from before the multi-engine palette existed. `character` may be
 * either a raw WSOLA params object ({windowMs, searchMs, hopFraction, bitDepth}) or - for source
 * compatibility with the original signature - a character id string, resolved through the current
 * registry (falls back to "clean" like every other lookup here if the id isn't a WSOLA character).
 */
export function wsolaStretchChannels(channels, sampleRate, ratio, character) {
  const params = typeof character === "string" ? resolveCharacterFor(character).params : character;
  return stretchWsola(channels, sampleRate, Math.max(0.1, Math.min(8, ratio || 1)), params);
}

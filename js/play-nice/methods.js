// methods.js
//
// PLAY NICE's stretch METHOD list - a thin view over the app's EXISTING character
// registry (js/dsp/stretch/characters.js), not a second catalogue.
//
// THE SPLIT THIS FILE EXISTS TO PROTECT:
//
//   FIT     decides WHAT has to change   -> conform.js, from detected vs. target BPM/key
//   METHOD  decides HOW it is changed    -> here, and it is purely a creative choice
//
// The two never talk to each other. The stretch ratio for 100 BPM -> 128 BPM is 0.781
// whether it is rendered with Clean, Glitch, Grain or Spectral; changing the method never
// changes the ratio, and correcting a detected BPM never changes the method. That
// independence is what makes "conform these twelve loops to 128, but this one through
// Shred because it sounds better" a one-click decision.
//
// Every entry here IS a character id the existing dispatcher already understands, so
// PLAY NICE adds no DSP of its own for tempo conforming - stretchChannels() does the
// work, exactly as STRETCH does. Adding a new stretch method to Good Bits therefore
// means adding a character to the registry; it appears in PLAY NICE automatically.
//
// READY FOR "TRY ALL": because the method is a parameter of the plan rather than
// something the conforming logic picks for itself, running one loop through every method
// is a loop over methodKeys() building one plan each - see conform.js's planConform(),
// whose `method` argument is explicit for exactly this reason. Nothing about that needs
// new DSP or a new pipeline.
import { CHARACTERS, characterGroups, resolveCharacter } from "../dsp/stretch/characters.js";

/**
 * The default for a fresh session.
 *
 * "Transient", not "Clean", and the reason is measured rather than aesthetic. Both are
 * perfectly good stretches of a single loop, but PLAY NICE's job is loops that sit tightly
 * against each other, and on a percussive loop stretched to a new tempo the two behave very
 * differently: the phase-locked, transient-reset vocoder holds every hit to well under a
 * millisecond of its ideal grid position, while WSOLA's similarity search moves splice
 * points around by several milliseconds a grain and visibly softens some attacks entirely.
 * On its own that is a texture. Against a reference loop it is a flam.
 *
 * "Clean" remains the default in the STRETCH task, where a single file's texture is the
 * whole point and there is nothing for it to be tight against, and is one click away here.
 */
export const DEFAULT_METHOD = "transient";

/**
 * Sentinel for "use whatever the session default is". Stored per loop so that changing
 * the global method afterwards still moves every loop that hadn't been given an opinion
 * of its own, while loops that WERE deliberately overridden keep their setting.
 */
export const METHOD_INHERIT = "__inherit__";

/** Every available method, grouped exactly as the character browser groups them. */
export function methodGroups() {
  return characterGroups();
}

/** Flat list of method ids, in registry order. The list a future TRY ALL iterates. */
export function methodKeys() {
  return Object.keys(CHARACTERS);
}

/**
 * Resolve a per-loop method setting against the session default.
 * @param {string|null|undefined} loopMethod  a per-loop override, or METHOD_INHERIT/null
 * @param {string} sessionMethod              the session-wide default
 */
export function resolveMethodKey(loopMethod, sessionMethod) {
  const fallback = CHARACTERS[sessionMethod] ? sessionMethod : DEFAULT_METHOD;
  if (!loopMethod || loopMethod === METHOD_INHERIT) return fallback;
  return CHARACTERS[loopMethod] ? loopMethod : fallback;
}

/**
 * A method id plus the facts the conforming pipeline needs about it. `preservesPitch`
 * is the one that genuinely matters: the registry's varispeed-backed "Tape" character
 * moves pitch WITH speed by design (that is the whole sound), so conforming tempo
 * through it also transposes the audio. conform.js reads this flag and accounts for the
 * drift rather than pretending it isn't there - see planConform().
 */
export function describeMethod(methodKey) {
  const character = resolveCharacter(methodKey);
  const key = CHARACTERS[methodKey] ? methodKey : DEFAULT_METHOD;
  return {
    key,
    label: character.label,
    group: character.group,
    description: character.description,
    preservesPitch: character.preservesPitch !== false,
    maxRatio: character.maxRatio || 8,
    macros: character.macros || [],
  };
}

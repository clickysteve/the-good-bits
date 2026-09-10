// roles.js
//
// What KIND of thing a piece of audio is inside PLAY NICE, as data rather than as an
// assumption baked into the pipeline.
//
// PLAY NICE has three distinct roles for audio, and they are not interchangeable:
//
//   reference - defines the target. Analysed, never conformed, never exported.
//   loop      - rhythmic material with a tempo of its own. Conformed to the target's
//               tempo and key. This is the workflow implemented today.
//   one-shot  - a single hit or note with no meaningful tempo (a synth stab, a Rhodes
//               note, a vocal hit). Has pitch but not BPM. FUTURE: rather than being
//               tempo-conformed, one-shots become the raw material a generator arranges
//               into a phrase at the target tempo and in the target key.
//
// The point of this file existing NOW, before the one-shot workflow does, is that the
// alternative is worse: without it, "every input has a source BPM and gets stretched to
// the target" quietly becomes an assumption spread across the conform planner, the
// analysis step, the renderer and the UI, and adding one-shots later means finding and
// unpicking every place that assumption landed. A capability lookup costs almost nothing
// today and keeps that assumption from ever being made.
//
// So: nothing in PLAY NICE asks "is this a loop?". It asks the role what it supports.
// The one-shot generator itself (pattern length, density, rhythm character, seed,
// regenerate, MIDI export) is NOT implemented here - only the fact that a one-shot is a
// legitimate kind of input whose tempo is not something to stretch.

/**
 * @typedef {object} RoleCapabilities
 * @property {boolean} analyzeTempo   is a source BPM a meaningful thing to detect?
 * @property {boolean} analyzeKey     is a source key a meaningful thing to detect?
 * @property {boolean} fitTempo       can this be time-stretched onto the target tempo?
 * @property {boolean} fitPitch       can this be transposed onto the target key?
 * @property {boolean} definesTarget  does this FILL IN the target rather than conform to it?
 * @property {boolean} exportable     does conforming this produce a file the user exports?
 * @property {boolean} generative     is this arranged into new material rather than transformed in place?
 */

/** @type {Record<string, {key:string, label:string, description:string} & RoleCapabilities>} */
export const ROLES = {
  reference: {
    key: "reference",
    label: "Reference",
    description: "Defines the target. Analysed, never conformed.",
    analyzeTempo: true,
    analyzeKey: true,
    fitTempo: false,
    fitPitch: false,
    definesTarget: true,
    exportable: false,
    generative: false,
  },
  loop: {
    key: "loop",
    label: "Loop",
    description: "Rhythmic material with a tempo of its own. Conformed to the target tempo and key.",
    analyzeTempo: true,
    analyzeKey: true,
    fitTempo: true,
    fitPitch: true,
    definesTarget: false,
    exportable: true,
    generative: false,
  },
  // Declared, analysed and conformed-in-pitch today; the generator that turns a pile of
  // these into a phrase at the target tempo is the next piece of work, and lands as a
  // consumer of this role rather than as a change to it.
  oneShot: {
    key: "oneShot",
    label: "One-shot",
    description: "A single hit or note. No tempo of its own - pitch is the part that conforms.",
    analyzeTempo: false,
    analyzeKey: true,
    fitTempo: false,
    fitPitch: true,
    definesTarget: false,
    exportable: true,
    generative: true,
  },
};

export const DEFAULT_ROLE = "loop";

/** Look up a role, falling back to "loop" for anything unrecognised (an older saved session, a typo). */
export function resolveRole(key) {
  return ROLES[key] || ROLES[DEFAULT_ROLE];
}

/** Does `role` support `capability`? The question every part of PLAY NICE asks instead of naming a role directly. */
export function roleSupports(roleKey, capability) {
  return !!resolveRole(roleKey)[capability];
}

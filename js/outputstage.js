// outputstage.js
//
// Optional lo-fi coloration applied at export time: a bank of "output stage" character presets
// (tape/vinyl/radio-style coloration), a saturation "drive" stage, and a crunch (bitcrush /
// sample-rate reduction) stage, applied in that order.
//
// The DSP lives in Slop Factory Core (https://github.com/clickysteve/slopfactory-core), the
// shared audio foundation of the Slop Factory instruments, where these three stages became its
// first output engines: goodbits.output-stage, goodbits.drive and goodbits.crunch. They are the
// same algorithms that used to be written out in this file (originally ported from the author's
// Loop Saboteur plugin, Source/OutputStage.h), moved without change: test/outputstage-core.test.mjs
// checks the outputs against hashes recorded from this file's last standalone version.
//
// Core is vendored as one pinned file (js/vendor/slopfactory-core/, see scripts/vendor-core.mjs).
// This module keeps The Good Bits' own API and semantics on top of it - the catalogues, the
// argument defaults, "clean"/zero-amount no-ops, the seed fallback and per-region seeds - so
// app.js, heavy-dsp-worker.js and stretch-fx/render.js are unchanged. Pure functions over
// Float32Array channel data, no DOM/Web Audio, so it runs in Node tests and in the worker.

import {
  coreEngines,
  renderChain,
  GOOD_BITS_ENGINE_IDS,
  OUTPUT_STAGE_ENGINE,
  DRIVE_ENGINE,
  CRUNCH_ENGINE,
} from "./vendor/slopfactory-core/engines.js";

/** The Good Bits' engines (its original three stages), for building controls from their metadata. */
export const GOOD_BITS_ENGINES = coreEngines(GOOD_BITS_ENGINE_IDS);

const param = (engine, id) => engine.params.find((p) => p.id === id);
const MODE_PARAM = param(OUTPUT_STAGE_ENGINE, "mode");
const DRIVE_TYPE_PARAM = param(DRIVE_ENGINE, "type");

/** Output stage character presets - order matches the UI select. "clean" is the off/bypass state. */
export const OUTPUT_STAGES = [
  { key: "clean", label: "Clean", description: "no coloration" },
  ...MODE_PARAM.options.map((o) => ({ key: o.value, label: o.label, description: o.description })),
];

/** Saturation drive types - order matches the UI select. */
export const DRIVE_TYPES = DRIVE_TYPE_PARAM.options.map((o) => ({ key: o.value, label: o.label, description: o.description }));

const MODE_KEYS = new Set(MODE_PARAM.options.map((o) => o.value));

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

const copy = (channels) => channels.map((ch) => Float32Array.from(ch));

/** Seed used when a caller passes none: derived from the region length, as it always was here. */
const fallbackSeed = (channels) => (0xc0ffee ^ Math.imul(channels[0].length + 1, 2654435761)) >>> 0;

/**
 * Derives a distinct, deterministic seed for the Nth region of a batch export from the batch's own
 * seed (timestretchSettings.seed - reused here even when time-stretch itself is off, since it's
 * already the one per-export "randomness" knob the UI exposes). Needed because applyOutputStage's
 * own seed fallback is derived only from the region's sample length: every one-shot/chop of the
 * same length in a batch would otherwise get byte-identical wow/hiss/click noise, an audible
 * "twin" artifact across a folder of same-length hits.
 */
export function deriveRegionSeed(baseSeed, index) {
  const base = (baseSeed ?? 1) >>> 0;
  return (base ^ Math.imul(index + 1, 2654435761)) >>> 0;
}

// -----------------------------------------------------------------------------
// The Good Bits settings -> Core chain stages. Each returns null where The Good Bits treats the
// stage as a no-op (clean/unknown mode, zero mix, zero drive, no reduction).
// -----------------------------------------------------------------------------

function outputStageStage(modeKey, mixPct, intensityPct) {
  const mix = clamp01((mixPct ?? 100) / 100);
  if (!modeKey || modeKey === "clean" || mix <= 0.0001 || !MODE_KEYS.has(modeKey)) return null;
  return { engine: OUTPUT_STAGE_ENGINE.id, params: { mode: modeKey, mixPct: mixPct ?? 100, intensityPct: intensityPct ?? 50 } };
}

function driveStage(driveKey, amountPct) {
  const d = clamp01((amountPct ?? 0) / 100);
  if (d <= 0.0001) return null;
  // an unknown type is Tape, as before (the engine falls back to its default, Tape)
  return { engine: DRIVE_ENGINE.id, params: { type: driveKey, amountPct: amountPct ?? 0 } };
}

function crunchStage(bits, rateDivide) {
  const b = Math.max(1, Math.min(16, Math.round(bits ?? 16)));
  const r = Math.max(1, Math.min(32, Math.round(rateDivide ?? 1)));
  if (b >= 16 && r <= 1) return null;
  return { engine: CRUNCH_ENGINE.id, params: { bits: b, rateDivide: r } };
}

/** A Core chain configuration (plain JSON) from a list of stages, nulls skipped. */
function chainOf(stages) {
  return {
    version: 1,
    bypass: false,
    stages: stages.filter(Boolean).map((s, i) => ({ id: `s${i + 1}`, engine: s.engine, enabled: true, params: s.params })),
  };
}

/**
 * The Good Bits lo-fi settings ({outputStage, drive, crunch}, each with its own `enabled` flag)
 * as a Core output-chain configuration, in The Good Bits' fixed order.
 */
export function lofiChainConfig(settings = {}) {
  const { outputStage, drive, crunch } = settings;
  return chainOf([
    outputStage && outputStage.enabled ? outputStageStage(outputStage.mode, outputStage.mixPct, outputStage.intensityPct) : null,
    drive && drive.enabled ? driveStage(drive.type, drive.amountPct) : null,
    crunch && crunch.enabled ? crunchStage(crunch.bits, crunch.rateDivide) : null,
  ]);
}

function run(channels, sampleRate, config, seed) {
  if (!config.stages.length) return copy(channels);
  return renderChain(channels, sampleRate, config, seed, { engines: GOOD_BITS_ENGINES });
}

/**
 * Applies an output-stage character preset to every channel in lockstep (stereo L/R if present,
 * otherwise the single channel is treated as both). `mixPct`/`intensityPct` are 0-100: intensity
 * scales how strongly the mode's own processing differs from the dry signal, mix is the final
 * wet/dry blend - so "a little bit of a lot of character" and "all of a little character" are
 * both reachable. mode "clean" (or mix 0) is a no-op copy.
 */
export function applyOutputStage(channels, sampleRate, modeKey, mixPct = 100, intensityPct = 50, seed) {
  return run(channels, sampleRate, chainOf([outputStageStage(modeKey, mixPct, intensityPct)]), seed ?? fallbackSeed(channels));
}

/** amountPct 0-100. 0 is a no-op copy. (Drive is memoryless: the sample rate does not matter.) */
export function applyDrive(channels, driveKey, amountPct = 0) {
  return run(channels, 44100, chainOf([driveStage(driveKey, amountPct)]), 1);
}

/** bits: 1-16 (16 = no reduction). rateDivide: 1-32 (1 = no reduction). Both are no-ops at their max. */
export function applyCrunch(channels, { bits = 16, rateDivide = 1 } = {}) {
  return run(channels, 44100, chainOf([crunchStage(bits, rateDivide)]), 1);
}

/**
 * Runs the full lo-fi chain - output-stage character, then drive, then crunch - each stage a
 * no-op unless its `enabled` flag is set. `settings` is a plain, structured-cloneable object
 * ({outputStage, drive, crunch}, each matching the shape of the app's *Settings objects), so this
 * same function runs identically on the main thread (app.js) and inside heavy-dsp-worker.js.
 * `seed`, if given, is passed straight through to the output-stage's own RNG (see
 * applyOutputStage/deriveRegionSeed above) - callers processing more than one region per export
 * should pass a distinct seed per region rather than leaving it undefined for every call, or every
 * same-length region gets identical "random" noise/wow.
 */
export function applyLofiChain(channels, sampleRate, settings = {}, seed) {
  return run(channels, sampleRate, lofiChainConfig(settings), seed ?? fallbackSeed(channels));
}

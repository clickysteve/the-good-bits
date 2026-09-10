// conform.js
//
// The heart of PLAY NICE, and deliberately the most boring file in it: given what a
// piece of audio IS and what the target IS, work out what has to change. Pure
// arithmetic - no DOM, no audio, no DSP, no async. Everything here is unit-tested in
// test/play-nice-conform.test.mjs.
//
// Three separations are load-bearing:
//
//   1. TARGET SOURCE. planConform() takes a TargetContext and never asks whether it came
//      from Defined mode or a Reference Loop. See target-context.js.
//
//   2. FIT vs. METHOD. The stretch RATIO comes from the tempos. The stretch METHOD comes
//      from the user's taste. Neither is derived from the other, and the method arrives
//      as an explicit argument rather than being chosen in here - which is also what
//      makes a future TRY ALL (same plan, every method) a loop over planConform() rather
//      than a rewrite. See methods.js.
//
//   3. ROLE. Nothing here assumes its input is a loop with a tempo. Capabilities come
//      from roles.js, so a one-shot - which has pitch but no meaningful BPM - already
//      plans correctly today (pitch fitted, tempo not touched) even though the generator
//      that will arrange one-shots into phrases doesn't exist yet.
//
// The output is a PLAN, not audio. Plans are cheap, comparable and printable, so the UI
// can show a loop's stretch ratio and semitone shift the instant a detection is
// corrected, long before anything is rendered. render.js turns a plan into audio.
import { ratioForTargetTempo } from "../dsp/stretch/index.js";
import { ratioToSemitones, MAX_PITCH_SEMITONES } from "../dsp/pitch-shift.js";
import { resolveTransposition, DEFAULT_TRANSPOSE_STRATEGY } from "./key-matching.js";
import { targetKeyForMatching } from "./target-context.js";
import { describeMethod, resolveMethodKey } from "./methods.js";
import { roleSupports } from "./roles.js";
import { effectiveTargetBpm, resolveTimeFeel } from "./time-feel.js";

/**
 * A stretch this far from 1 is worth mentioning on its own, regardless of why.
 */
export const EXTREME_RATIO_LOW = 0.5;
export const EXTREME_RATIO_HIGH = 2;

/**
 * The largest tempo correction bar-snapping is allowed to make on its own. Snapping exists
 * to remove a fraction of a percent of detection error, not to overrule the user's
 * interpreted tempo - anything bigger than this is a disagreement about what the tempo IS,
 * which is the half/double buttons' job, not this.
 */
const MAX_SNAP_TEMPO_DRIFT = 0.025;

/**
 * Re-derive a loop's tempo from its own LENGTH rather than from detection.
 *
 * Why this exists: detection reports 99.86 BPM for a loop that is obviously exactly 100.
 * Conforming from 99.86 produces an output 0.19% away from a whole number of bars - about
 * 15ms on a four-bar loop. Auditioned once that is inaudible; in a mix of loops playing
 * round and round, it accumulates every cycle until the batch is visibly flamming. The
 * whole promise of PLAY NICE is loops that stay together, so "close enough" isn't.
 *
 * A loop's DURATION is exact - it is a sample count. Its detected tempo is an estimate. So
 * if the duration is within a hair of a whole number of beats at the estimated tempo, the
 * whole-beat reading is almost certainly the truth, and the tempo it implies is exact.
 *
 * Returns the implied exact BPM, or null when the material doesn't look like a clean loop
 * (or when honouring it would move the tempo more than MAX_SNAP_TEMPO_DRIFT).
 */
/**
 * Beat counts a loop is actually likely to be, most likely first.
 *
 * Rounding to the nearest whole beat is not enough. A sixteen-bar arpeggio measured at
 * 64.6 beats rounds to SIXTY-FIVE, which is not a length any loop has ever been, and
 * conforming from it puts the loop a beat-and-a-bit wrong by the end. Sixty-four is the
 * obvious truth, and it is obvious because of what loops are: powers of two bars first,
 * then any whole number of bars, then anything even, then - only if nothing musical fits -
 * an arbitrary count.
 *
 * Each tier is tried in order and the first candidate within the tempo tolerance wins, so
 * an honest 12-beat (three-bar) loop still lands on 12 rather than being forced to 8 or 16.
 */
function musicalBeatCandidates(beats) {
  const tiers = [];
  // Powers of two beats: 4, 8, 16, 32, 64... plus the sub-bar lengths short loops use.
  const powers = [];
  for (let n = 1; n <= 1024; n *= 2) powers.push(n);
  tiers.push(powers);
  // Any whole number of bars in 4/4.
  tiers.push([4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 256]);
  // Anything even, then anything at all.
  const near = Math.round(beats);
  tiers.push([near % 2 === 0 ? near : near - 1, near % 2 === 0 ? near : near + 1].filter((n) => n >= 1));
  tiers.push([near]);
  return tiers;
}

export function snapTempoToLoopLength(durationSec, bpm) {
  if (!(durationSec > 0) || !(bpm > 0)) return null;
  const beats = (durationSec * bpm) / 60;
  if (!(beats >= 0.5)) return null;

  for (const tier of musicalBeatCandidates(beats)) {
    // Nearest candidate in this tier, not every candidate - a loop is one length.
    let best = null;
    for (const candidate of tier) {
      if (candidate < 1) continue;
      if (best === null || Math.abs(candidate - beats) < Math.abs(best - beats)) best = candidate;
    }
    if (best === null) continue;
    const snapped = (best * 60) / durationSec;
    if (Math.abs(snapped / bpm - 1) <= MAX_SNAP_TEMPO_DRIFT) return { bpm: snapped, beats: best };
  }
  return null;
}

/**
 * Would interpreting the source tempo at half or double speed fit the target better?
 *
 * Octave errors are by far the most common tempo-detection failure, and a fixed "is the
 * ratio extreme?" threshold is the wrong test for them: a 70 BPM reading of a 140 BPM loop
 * conformed to 120 gives a ratio of 0.58, which no reasonable extremeness threshold would
 * flag, yet it is unmistakably a half-time error. The right question is not "is this
 * stretch big?" but "is there an octave of this tempo that needs much less stretching?" -
 * which is exactly the question the half/double buttons answer.
 *
 * Returns the better BPM, or null if the detected reading is already the closest fit.
 */
export function betterOctaveInterpretation(sourceBpm, targetBpm) {
  if (!(sourceBpm > 0) || !(targetBpm > 0)) return null;
  // Distance from a 1:1 relationship, measured in octaves so half and double are
  // symmetrical - 0.5x and 2x are equally far from "no stretch needed".
  const distance = (bpm) => Math.abs(Math.log2(bpm / targetBpm));
  const current = distance(sourceBpm);
  let best = null;
  let bestDistance = current;
  for (const candidate of [sourceBpm / 2, sourceBpm * 2]) {
    const d = distance(candidate);
    // A meaningful margin, not a rounding difference: at exactly 1.5x the target the two
    // readings are almost equally plausible and guessing would be noise.
    if (d < bestDistance - 0.15) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Work out what has to change for one piece of audio to fit the target.
 *
 * @param {object} args
 * @param {string} args.role                     input role key - see roles.js
 * @param {{bpm:number|null, key:string|null, mode:string|null}} args.source  EFFECTIVE source analysis (manual corrections already applied)
 * @param {object} args.target                   a TargetContext
 * @param {boolean} args.tempoFit                the loop's TEMPO Fit/Off switch
 * @param {boolean} args.pitchFit                the loop's PITCH Fit/Off switch
 * @param {string} args.method                   stretch method (character id), or METHOD_INHERIT
 * @param {string} args.sessionMethod            session-default stretch method
 * @param {string} [args.strategy]               key-matching strategy - see key-matching.js
 * @param {boolean} [args.snapToLoop]            derive the source tempo from the loop's own length
 * @param {boolean} [args.autoOctave]            silently resolve half/double detection errors against the target
 * @param {boolean} [args.alignDownbeat]         rotate the loop so its first onset sits on the grid
 * @param {string} [args.timeFeel]               conform to a multiple of the target tempo - see time-feel.js
 * @returns {object} a conform plan
 */
export function planConform({
  role,
  source,
  target,
  tempoFit,
  pitchFit,
  method,
  sessionMethod,
  strategy = DEFAULT_TRANSPOSE_STRATEGY,
  snapToLoop = true,
  autoOctave = true,
  alignDownbeat = true,
  timeFeel = "normal",
}) {
  const methodKey = resolveMethodKey(method, sessionMethod);
  const methodInfo = describeMethod(methodKey);

  const tempo = planTempo({ role, source, target, tempoFit, methodInfo, snapToLoop, autoOctave, timeFeel });
  const pitch = planPitch({ role, source, target, pitchFit, strategy, tempo, methodInfo });

  return {
    method: methodInfo,
    tempo,
    pitch,
    // Rhythmic alignment: which grid the audio is squared up to before stretching, and
    // which it is squared up to afterwards. Carried on the plan rather than decided inside
    // the renderer so it is inspectable, testable and reportable like everything else here.
    align: {
      enabled: !!alignDownbeat && roleSupports(role, "fitTempo"),
      sourceBpm: tempo.sourceBpm,
      // After conforming, the audio lives at the target tempo (or its own, if tempo fitting
      // is off), so that is the grid any residual engine latency has to be measured against.
      outputBpm: tempo.applied ? tempo.targetBpm : tempo.sourceBpm,
    },
    // "Would rendering this actually do anything?" - a plan where both stages are
    // inactive is a straight copy of the source audio, which the UI says out loud rather
    // than pretending work happened.
    changesAudio: tempo.applied || pitch.applied,
    warnings: [...tempo.warnings, ...pitch.warnings],
  };
}

/** The tempo half: ratio from the two tempos, gated by role capability and the Fit switch. */
function planTempo({ role, source, target, tempoFit, methodInfo, snapToLoop, autoOctave, timeFeel }) {
  const rawSourceBpm = Number.isFinite(source.bpm) && source.bpm > 0 ? source.bpm : null;
  // Half-time and friends are not a rendering mode - they are a different tempo to conform
  // TO, so everything downstream (ratio, snapping, alignment grid) follows for free.
  const feel = resolveTimeFeel(timeFeel);
  const rawTargetBpm = Number.isFinite(target.bpm) && target.bpm > 0 ? target.bpm : null;
  const targetBpm = rawTargetBpm != null ? effectiveTargetBpm(rawTargetBpm, timeFeel) : null;

  // Half/double errors are the most common detection failure and, with a target in hand,
  // the most easily resolved: whichever octave of the detected tempo sits closest to the
  // target is almost always the right reading. Resolving it automatically is the difference
  // between "drop twenty loops in and they work" and "drop twenty loops in and then go
  // hunting for the three that came out at half speed".
  //
  // Never applied to a tempo the user typed or clicked. A manual correction is a statement
  // of fact about the audio, and silently doubling it would be the tool overruling the
  // person - see ANALYSIS PROPOSES, USER OVERRIDES in js/tempo-override.js.
  // Aimed at the SESSION target, deliberately not the feel-adjusted one.
  //
  // Auto-octave exists to fix DETECTION errors - "this reads as 68, it is really 136". The
  // time feel is a musical instruction on top of a correct reading. Pointing auto-octave at
  // the halved target makes it choose whichever octave needs least stretching from there,
  // which is precisely the stretch the user just asked for: a 136 BPM break set to
  // half-time against a 120 target came back reinterpreted as 68 BPM and conformed to the
  // same length it would have had at normal time. The feel cancelled itself out.
  const octaveFix = autoOctave && !source.bpmIsManual && rawSourceBpm != null ? betterOctaveInterpretation(rawSourceBpm, rawTargetBpm) : null;
  const interpretedBpm = octaveFix != null ? octaveFix : rawSourceBpm;

  // Snapping refines the interpretation; it never replaces it. A correction of 62 -> 124
  // still means 124, just possibly 124.03 if that is what a whole number of beats at this
  // length actually implies.
  const snap = snapToLoop && interpretedBpm != null ? snapTempoToLoopLength(source.durationSec, interpretedBpm) : null;
  const sourceBpm = snap ? snap.bpm : interpretedBpm;

  const base = {
    fit: !!tempoFit,
    sourceBpm,
    detectedSourceBpm: rawSourceBpm,
    interpretedBpm,
    autoOctave: octaveFix != null,
    targetBpm,
    // The user-facing target, before the feel multiplier - so the UI can say "120 BPM,
    // conformed at half-time to 60" rather than just showing 60 and confusing everyone.
    sessionTargetBpm: rawTargetBpm,
    timeFeel: feel.key,
    timeFeelLength: feel.length,
    ratio: 1,
    applied: false,
    reason: null,
    extreme: false,
    snapped: !!snap,
    snappedBeats: snap ? snap.beats : null,
    warnings: [],
  };

  if (!roleSupports(role, "fitTempo")) {
    // Not a failure - a one-shot has no tempo to conform, by definition.
    return { ...base, reason: "not applicable to this input type" };
  }
  if (!tempoFit) return { ...base, reason: "tempo fitting off" };
  if (sourceBpm == null) return { ...base, reason: "no source BPM" };
  if (targetBpm == null) return { ...base, reason: "no target BPM" };

  const raw = ratioForTargetTempo(sourceBpm, targetBpm);
  // Every engine clamps internally too, but clamping HERE means the ratio the UI displays
  // is the ratio that will actually be rendered, rather than a number the DSP silently
  // disagrees with.
  const ratio = Math.max(0.05, Math.min(methodInfo.maxRatio, raw));
  const clampedByMethod = Math.abs(ratio - raw) > 1e-6;
  const extreme = raw < EXTREME_RATIO_LOW || raw > EXTREME_RATIO_HIGH;

  const warnings = [];
  // Recomputed against the tempo actually in force, so an octave error that was already
  // resolved above doesn't get reported as though it were still outstanding.
  const suggestion = betterOctaveInterpretation(sourceBpm, targetBpm);
  if (suggestion) {
    // The single most valuable thing this feature can tell a user, and the one the batch
    // workflow depends on: which of twenty loops needs its detection corrected.
    warnings.push({
      code: "octave-suggestion",
      text: `Reading this as ${Math.round(suggestion)} BPM instead of ${Math.round(sourceBpm)} would need far less stretching - detection often lands an octave out.`,
      suggestedBpm: Math.round(suggestion),
    });
  } else if (extreme) {
    warnings.push({
      code: "extreme-stretch",
      text: `${sourceBpm.toFixed(0)} to ${targetBpm.toFixed(0)} BPM is a ${formatRatio(raw)} stretch - check the source BPM is right.`,
    });
  }
  if (clampedByMethod) {
    warnings.push({ code: "ratio-clamped", text: `${methodInfo.label} caps its stretch at ${methodInfo.maxRatio}x, so this was limited.` });
  }

  return {
    ...base,
    ratio,
    requestedRatio: raw,
    applied: Math.abs(ratio - 1) > 1e-6,
    reason: Math.abs(ratio - 1) > 1e-6 ? null : "already at the target tempo",
    extreme,
    clampedByMethod,
    warnings,
  };
}

/**
 * The pitch half. Two things it has to get right that a naive version wouldn't:
 *
 *   - METHOD-INDUCED PITCH DRIFT. Most stretch methods preserve pitch; the registry's
 *     varispeed-backed "Tape" deliberately doesn't (pitch follows speed, like a sampler
 *     played at the wrong rate). When tempo conforming runs through a method like that,
 *     the audio arrives at the pitch stage ALREADY transposed. If pitch fitting is on we
 *     subtract that drift so the result still lands on the target key; if it's off we
 *     leave the drift alone - it's the sound the user asked for - but report it so the
 *     output's key is never a mystery.
 *
 *   - "NO CHANGE" vs. "COULDN'T". Zero semitones because the loop is already in the
 *     target key is a success. Zero semitones because the key detector had nothing
 *     confident to say is not, and the UI shows them differently.
 */
function planPitch({ role, source, target, pitchFit, strategy, tempo, methodInfo }) {
  // Pitch drift the tempo stage will introduce, in semitones. A non-pitch-preserving
  // engine plays the material back at 1/ratio speed, which multiplies frequency by the
  // same amount.
  const drift = !methodInfo.preservesPitch && tempo.applied ? ratioToSemitones(1 / tempo.ratio) : 0;
  const base = {
    fit: !!pitchFit,
    semitones: 0,
    methodDrift: drift,
    resultingShift: drift,
    applied: false,
    reason: null,
    modeMismatch: false,
    relativeUsed: false,
    resultKey: null,
    resultMode: null,
    sourceKey: source.key || null,
    sourceMode: source.mode || null,
    warnings: [],
  };

  const driftWarning =
    Math.abs(drift) > 0.01
      ? {
          code: "method-pitch-drift",
          text: `${methodInfo.label} moves pitch with speed, so conforming the tempo also transposes this by ${drift > 0 ? "+" : ""}${drift.toFixed(2)} semitones.`,
        }
      : null;

  if (!roleSupports(role, "fitPitch")) return { ...base, reason: "not applicable to this input type", warnings: driftWarning ? [driftWarning] : [] };
  if (!pitchFit) {
    // Pitch fitting off means the pitch stage does nothing - but any drift the tempo
    // method introduced is still in the audio, so it's still reported.
    return { ...base, reason: "pitch fitting off", warnings: driftWarning ? [driftWarning] : [] };
  }

  const targetKey = targetKeyForMatching(target);
  const transposition = resolveTransposition({ key: source.key, mode: source.mode }, targetKey, strategy);
  if (!transposition.ok) {
    return { ...base, reason: transposition.reason, warnings: driftWarning ? [driftWarning] : [] };
  }

  // The pitch stage has to undo whatever the tempo method already did before adding the
  // musical transposition, so the two together land exactly on the target.
  const wanted = transposition.semitones;
  const stageSemitones = clampSemitones(wanted - drift);

  const warnings = [];
  if (transposition.modeMismatch) {
    // Only "Match root" can reach here: it puts the source's own mode against a differing
    // target mode, which is a real clash rather than a cosmetic mismatch.
    warnings.push({
      code: "mode-mismatch",
      text: `Source is ${source.mode}, target is ${target.keyMode} - moving the root can't change that. Try Match scale, correct the source key, or switch pitch fitting off for this one.`,
    });
  }
  if (Math.abs(wanted - drift) > MAX_PITCH_SEMITONES) {
    warnings.push({ code: "pitch-clamped", text: `Shift limited to ${MAX_PITCH_SEMITONES} semitones.` });
  }

  return {
    ...base,
    semitones: stageSemitones,
    resultingShift: stageSemitones + drift, // what the listener actually hears, = `wanted` when nothing clamped
    targetSemitones: wanted,
    applied: Math.abs(stageSemitones) > 1e-6,
    // "already in the target key" is only true if the MODE agrees too. A C minor loop
    // against a C major target needs no transposition and is still not in the target key -
    // saying it was would present the clash as a success.
    reason:
      Math.abs(wanted) > 1e-6 || Math.abs(stageSemitones) > 1e-6
        ? null
        : transposition.modeMismatch
          ? `same root, but ${source.mode} against a ${target.keyMode} target`
          : "already in the target key",
    modeMismatch: transposition.modeMismatch,
    // "Match scale" can land the audio somewhere other than the target key (the target's
    // relative), which is the correct answer but must never be a silent one.
    relativeUsed: transposition.relativeUsed,
    resultKey: transposition.resultKey,
    resultMode: transposition.resultMode,
    strategy: transposition.strategy,
    warnings,
  };
}

function clampSemitones(st) {
  return Math.max(-MAX_PITCH_SEMITONES, Math.min(MAX_PITCH_SEMITONES, st));
}

/** "0.78x" / "1.25x" - a stretch ratio as compact display text. */
export function formatRatio(ratio) {
  if (!Number.isFinite(ratio)) return "-";
  return `${ratio.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}x`;
}

/** "+9.3% faster" style tempo-change text, the other way people read a stretch ratio. */
export function formatTempoChange(ratio) {
  if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 1e-6) return "no change";
  // ratio is output length / input length, so a ratio below 1 means the result is shorter
  // and therefore faster.
  const pct = (1 / ratio - 1) * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}% ${pct > 0 ? "faster" : "slower"}`;
}

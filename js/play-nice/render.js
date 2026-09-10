// render.js
//
// Plan in, audio out. The only part of PLAY NICE that touches samples, and it is
// deliberately tiny, because everything it needs already exists:
//
//   tempo stage  -> stretchChannels()      (js/dsp/stretch, the same engines STRETCH uses)
//   pitch stage  -> pitchShiftChannels()   (js/dsp/pitch-shift.js, built from those same engines)
//
// PLAY NICE contributes no stretch DSP of its own. Adding a stretch character to the
// registry makes it a PLAY NICE method with no change here.
//
// ORDER: tempo first, then pitch. Not arbitrary - the pitch stage's drift compensation
// (see planPitch() in conform.js) is calculated against the tempo stage's ratio, so the
// tempo transformation has to be the one that already happened. Doing it the other way
// would mean a non-pitch-preserving method re-transposing audio that had just been put
// in the right key.
//
// INDEPENDENCE, concretely: the tempo stage changes length and not pitch (except for the
// methods that advertise otherwise, which the plan accounts for); the pitch stage changes
// pitch and not length (pitchShiftChannels pins its output length exactly). Neither
// reads the other's settings.
//
// No DOM and no imports outside the DSP layer, so this runs unchanged on the main thread
// or inside js/heavy-dsp-worker.js - which is where a batch actually renders, so
// conforming twenty loops doesn't freeze the page.
import { stretchChannels, MIN_RATIO } from "../dsp/stretch/index.js";
import { pitchShiftChannels, semitonesToRatio, DEFAULT_PITCH_CHARACTER } from "../dsp/pitch-shift.js";
import { resampleLinear } from "../dsp.js";
import { alignToDownbeat } from "./downbeat.js";

/**
 * Render one conform plan.
 *
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {object} plan                 from planConform()
 * @param {object} [options]
 * @param {object} [options.macroValues]      macro values for the tempo method
 * @param {number} [options.seed]             for the methods with a random element
 * @param {string} [options.pitchCharacter]   which character renders the PITCH stage
 * @returns {Float32Array[]}
 */
export function renderConform(channels, sampleRate, plan, options = {}) {
  const seed = options.seed ?? 1;
  let out = channels;
  const alignment = { source: null, output: null };
  const align = plan.align || { enabled: false };

  // ---- 1. Square the SOURCE up before touching it ------------------------
  //
  // A loop that begins a few milliseconds after its own first transient stays that way
  // through conforming - the offset is scaled by the stretch ratio, not removed - and lands
  // a few milliseconds late against everything else. Correcting it here, in the source's own
  // time base, means the stretch operates on a loop that actually starts where it claims to.
  if (align.enabled && align.sourceBpm) {
    const result = alignToDownbeat(out, sampleRate, align.sourceBpm);
    out = result.channels;
    alignment.source = result;
  }

  // ---- 2 & 3. Tempo and pitch, in ONE stretch pass wherever possible ------
  //
  // Done naively, conforming both tempo and key runs the audio through the stretch engine
  // TWICE: once to reach the target tempo, and again inside the pitch shifter (which is
  // itself a stretch followed by a resample). Every pass smears transients a little, and
  // two passes on a drum loop measurably doubles and blurs its attacks - which is precisely
  // the damage that makes a conformed loop sit loosely against the reference.
  //
  // It is also unnecessary. Stretching by (tempoRatio x pitchFactor) and then resampling by
  // 1/pitchFactor lands on exactly the same duration and exactly the same pitch as doing
  // the two separately - the algebra cancels - but the audio only goes through the engine
  // once. Same result, half the smearing.
  //
  //   stretch by R = tempoRatio * pitchFactor  ->  duration * R,           pitch unchanged
  //   resample by 1/pitchFactor                ->  duration * tempoRatio,  pitch * pitchFactor
  //
  // The exception is a method that moves pitch with speed (varispeed/"Tape"), where the
  // stretch stage is itself a resample and the two operations no longer commute the same
  // way. Those keep the separate path, which is also where the plan's drift compensation
  // was worked out - see planPitch() in conform.js.
  const pitchFactor = plan.pitch.applied ? semitonesToRatio(plan.pitch.semitones) : 1;
  const combinedRatio = plan.tempo.ratio * pitchFactor;
  // Combining is only valid if the engine can actually PERFORM the combined ratio. It
  // clamps anything outside its own bounds, and because the combined path then forces the
  // result back to the tempo-only length, a clamp would be papered over with silence -
  // the same "right length, missing audio" failure this file's fitToLength exists to
  // prevent, arriving through the front door instead.
  //
  // Reachable means within [MIN_RATIO, the character's maxRatio]. The two-stage path is
  // always safe by comparison: planTempo has already clamped the tempo ratio to the
  // character's cap, and pitchShiftChannels pins its own output length, so neither stage
  // can come up short.
  const combinedIsReachable = combinedRatio >= MIN_RATIO && combinedRatio <= plan.method.maxRatio;
  const canCombine = plan.method.preservesPitch && plan.tempo.applied && plan.pitch.applied && combinedIsReachable;

  if (canCombine) {
    const targetLength = Math.round((channels[0] ? channels[0].length : 0) * plan.tempo.ratio);
    out = stretchChannels(out, sampleRate, combinedRatio, plan.method.key, {
      macroValues: options.macroValues,
      seed,
    });
    out = out.map((ch) => fitToLength(resampleLinear(ch, 1, 1 / pitchFactor), targetLength));
  } else {
    if (plan.tempo.applied) {
      out = stretchChannels(out, sampleRate, plan.tempo.ratio, plan.method.key, {
        macroValues: options.macroValues,
        seed,
      });
    }
    if (plan.pitch.applied) {
      // The pitch stage stays transparent by default even when the tempo METHOD is wild:
      // the creative choice the user made was about the tempo transformation, and letting
      // it bleed into pitch fitting would make key conforming unpredictable. It is still
      // an explicit parameter rather than a constant, so a future "pitch method" control
      // has somewhere to plug in.
      out = pitchShiftChannels(out, sampleRate, plan.pitch.semitones, {
        character: options.pitchCharacter || DEFAULT_PITCH_CHARACTER,
        seed,
      });
    }
  }

  // ---- 4. Square the RESULT up too ---------------------------------------
  //
  // Stretch engines are not all latency-free: measured against a click on sample zero,
  // WSOLA characters come out at 0ms but the transient-preserving phase vocoders land
  // 1-6ms late, and the extreme spectral engines far later still. That is a property of the
  // METHOD, not of the source, so no amount of tidying the input fixes it - and 6ms is
  // exactly the size of error that reads as "not quite tight".
  //
  // Re-measuring the finished audio catches it whatever the engine did, without this file
  // needing a table of per-engine latencies that would rot the moment one is retuned. The
  // half-a-sixteenth cap inside alignToDownbeat() is what stops it "correcting" a
  // deliberately smeared PaulStretch render, whose first onset is meaningless.
  if (align.enabled && align.outputBpm) {
    const result = alignToDownbeat(out, sampleRate, align.outputBpm);
    out = result.channels;
    alignment.output = result;
  }

  // Nothing to do (every stage inactive) still returns copies, so callers can always
  // treat the result as theirs to modify - same contract stretchChannels() has.
  if (out === channels) out = channels.map((ch) => Float32Array.from(ch));
  // Non-enumerable so the returned value stays a plain array of channels to every existing
  // caller, while the alignment report is still there for anyone who wants to show it.
  Object.defineProperty(out, "alignment", { value: alignment, enumerable: false });
  return out;
}

/** Length in seconds a plan will produce from a source of `sourceSeconds`. Cheap enough to show live, before any rendering. */
export function predictedDuration(sourceSeconds, plan) {
  if (!Number.isFinite(sourceSeconds)) return null;
  // The pitch stage preserves duration by construction, so only the tempo ratio matters.
  return sourceSeconds * (plan.tempo.applied ? plan.tempo.ratio : 1);
}

/** Trim or zero-pad to exactly `length` samples - two independent roundings can't be trusted to agree. */
function fitToLength(arr, length) {
  if (arr.length === length) return arr;
  const out = new Float32Array(length);
  out.set(arr.subarray(0, Math.min(arr.length, length)));
  return out;
}

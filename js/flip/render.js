// render.js
//
// FLIP stage 3: RECIPE -> AUDIO.
//
// Pure, synchronous, no DOM, no Web Audio. Given a recipe (js/flip/recipe.js), the slice map it was
// generated against and the source channels, this writes one output buffer per channel. It is the
// only file in FLIP that touches samples, and it makes exactly two promises:
//
// SAME LENGTH, ALWAYS. The output is allocated at map.totalSamples before anything is written, and
// every step writes into its own pre-computed [bounds[i], bounds[i+1]) window. There is no path
// through this function that can produce a longer or shorter file, whatever a repeat or a stutter
// asked for - a stutter with eight fragments fills its slot eight times faster, it does not take
// eight slots. Drag the result into Logic and it occupies the same bars as the source.
//
// NO CLICKS, WITHOUT SOFTENING TRANSIENTS. The naive fix - a fade in and out on every slice - dips
// the level at every single boundary and blunts every attack that happens to land on one, which is
// exactly what makes chopped-up audio sound chopped up. Instead, only boundaries that are actually
// EDITS get treated, and they get a real crossfade rather than a fade to zero:
//
//   * A boundary is "natural" when the incoming audio continues the outgoing audio in the source,
//     forwards, sample for sample. Those are left completely alone - untouched stretches of the
//     original come out bit-identical to the original, including an untouched loop seam.
//   * An edit boundary is crossfaded using PRE-ROLL: the handful of source samples that naturally
//     PRECEDE the incoming audio. The outgoing tail fades out against genuine incoming material
//     rather than against silence, and - crucially - the crossfade finishes at the boundary, so the
//     incoming slice's own attack is at full level and completely unprocessed.
//   * Boundaries are counted at READ level, not slot level. A stutter is several hard splices
//     INSIDE one slot, and they click exactly as loudly as the ones between slots - handling only
//     slot boundaries is the version of this that sounds broken on precisely the settings people
//     reach for FLIP to get.
//   * Silence from Sparse is written zeros, crossfaded in and out like anything else. It's a
//     deliberate drop-out, not a hole where the renderer forgot to write something.
//   * Pre-roll that falls off either end of the file wraps around, because the source is a loop -
//     what precedes sample 0 is the loop's own tail. Reading silence there instead would put a
//     click on exactly the edits most likely to want one removed (a reversed final slice, anything
//     jumping to the very start).
//   * The loop seam (last slot back to first) is treated as one more boundary, so a variation still
//     loops cleanly when the last slot is no longer the source's last slice.
//
// Provenance tracking (readStart/readEnd below) is what makes "is this boundary natural?" answerable
// for reversed and stuttered slots too, rather than only for plain ones.
import { toMono } from "../dsp.js";

/** Default crossfade length. Long enough to bridge a splice, short enough to sit inside one cycle
 *  of anything above ~700Hz - i.e. audible as continuity, not as a fade. */
export const DEFAULT_CROSSFADE_MS = 1.5;

/**
 * One contiguous read out of the source: `count` samples from logical position `from`, forwards
 * (rev=false) or backwards (rev=true, meaning out[k] = src[from + count - 1 - k]).
 *
 * A slot's audio is always a list of these, which is what lets the same code render a plain slice,
 * a reversed slice, an eight-fragment stutter and a stutter-that-starts-halfway-through without
 * special cases, and lets the boundary logic ask "where did this slot's first/last sample come from?"
 */
function buildReads(step, map, slotLen) {
  if (step.silent) return [];
  const slice = map.slices[step.src];
  if (!slice) return [];
  const sliceStart = slice.startSample;
  const sliceLen = slice.length;

  let reads;
  if (!step.stutter || step.stutter < 2) {
    reads = [{ from: sliceStart, count: slotLen, rev: false }];
  } else {
    const headLen = Math.max(0, Math.min(slotLen, Math.round(slotLen * (step.keepHead || 0))));
    const bodyLen = slotLen - headLen;
    reads = [];
    if (headLen > 0) reads.push({ from: sliceStart, count: headLen, rev: false });
    const n = step.stutter;
    // Fragment boundaries from exact positions rather than accumulated, so the fragments tile the
    // stuttered portion with no leftover sample - the same rule the slice map itself follows.
    const fragSource = sliceStart + Math.round((step.fragFrom || 0) * sliceLen);
    for (let j = 0; j < n; j++) {
      const a = Math.round((j * bodyLen) / n);
      const b = Math.round(((j + 1) * bodyLen) / n);
      const count = b - a;
      if (count > 0) reads.push({ from: fragSource, count, rev: false });
    }
  }

  // Reversing the whole slot reverses the concatenation, which is the reads in the opposite order
  // with each one itself reversed. Doing only one of those two is the usual bug: flipping just the
  // order turns a reverse into a shuffle, flipping just the reads turns it into backwards stuttering.
  if (step.reverse) {
    reads = reads.reverse().map((r) => ({ ...r, rev: !r.rev }));
  }
  return reads;
}

/** Source sample index (and direction) that this read's FIRST output sample came from. */
function readStart(read) {
  if (!read) return null;
  return read.rev ? { at: read.from + read.count - 1, forward: false } : { at: read.from, forward: true };
}

/** Source sample index (and direction) that this read's LAST output sample came from. */
function readEnd(read) {
  if (!read) return null;
  return read.rev ? { at: read.from, forward: false } : { at: read.from + read.count - 1, forward: true };
}

/**
 * Does `cur` carry straight on from `prev` in the source? Only then is the boundary between them
 * left completely untouched. Both must be audible, both must be running forwards, and the sample
 * indices must actually be adjacent.
 */
function isNaturalJoin(prev, cur) {
  const end = readEnd(prev);
  const start = readStart(cur);
  if (!end || !start) return false;
  if (!end.forward || !start.forward) return false;
  return start.at === end.at + 1;
}

/**
 * The loop seam is a different question from an internal join: nothing in the source follows the
 * last sample, so "adjacent" can't apply. What matters is whether the variation REPRODUCES the
 * source's own seam - last sample of the file running into the first. When it does, the seam is
 * left exactly as the original had it, clicky or not; that's the user's loop, not ours to fix.
 */
function isNaturalSeam(lastRead, firstRead, total) {
  const end = readEnd(lastRead);
  const start = readStart(firstRead);
  if (!end || !start) return false;
  return end.forward && start.forward && end.at === total - 1 && start.at === 0;
}

/** The read that would supply `count` samples immediately BEFORE this read's first output sample. */
function leadRead(read, count) {
  const start = readStart(read);
  if (!start || count <= 0) return null;
  return start.forward ? { from: start.at - count, count, rev: false } : { from: start.at + 1, count, rev: true };
}

/**
 * Copy one read into `dest` at `destOffset`.
 *
 * `wrap` decides what happens off the ends of the source, and the two callers genuinely want
 * different things. A BODY read out of range means something is wrong (a step pointing at a slice
 * that no longer exists), and silence is the safe answer. A LEAD-IN read out of range is completely
 * normal - the pre-roll for a slot starting at sample 0 lies before the file, and the pre-roll for a
 * REVERSED last slice lies after it - and silence is the wrong answer there: the crossfade would
 * fade the outgoing tail down to nothing and then jump straight up to the incoming slice's first
 * sample, which is the exact click the crossfade exists to remove. For a loop, the sample after the
 * last one IS the first one, so wrapping gives the pre-roll real, correct, continuous audio.
 */
function copyRead(dest, destOffset, src, read, wrap = false) {
  const total = src.length;
  const at = (idx) => {
    if (idx >= 0 && idx < total) return src[idx];
    if (!wrap || total <= 0) return 0;
    return src[((idx % total) + total) % total];
  };
  if (read.rev) {
    const base = read.from + read.count - 1;
    for (let k = 0; k < read.count; k++) dest[destOffset + k] = at(base - k);
  } else {
    for (let k = 0; k < read.count; k++) dest[destOffset + k] = at(read.from + k);
  }
}

/**
 * Crossfade `count` samples of incoming material (read from the source, or silence when `read` is
 * null) over whatever is already sitting in out[at..at+count), which is the outgoing tail.
 *
 * LINEAR, not constant-power. The usual argument for constant-power - that a linear crossfade of
 * two unrelated signals dips ~3dB in the middle - is the wrong trade here, for two reasons. FLIP's
 * two sides are very often the SAME material (a repeated fragment crossfading into another copy of
 * itself), where constant-power overshoots by up to +3dB and clips the export outright; and at
 * 1.5ms the dip on the genuinely unrelated joins is far too short to read as a level change. Linear
 * also has the useful property that it can never exceed max(|a|,|b|), so a crossfade can't push a
 * hot loop into clipping no matter what it joins to what.
 */
function crossfadeInto(out, src, at, count, read, scratch) {
  if (count <= 0) return;
  // wrap: true - this is pre-roll, and the source is a loop. See copyRead().
  if (read) copyRead(scratch, 0, src, read, true);
  else scratch.fill(0, 0, count);
  for (let k = 0; k < count; k++) {
    const w = (k + 0.5) / count;
    out[at + k] = out[at + k] * (1 - w) + scratch[k] * w;
  }
}

/**
 * Render a recipe.
 *
 * @param {object} opts
 * @param {object} opts.recipe
 * @param {object} opts.map                  the slice map the recipe was generated against
 * @param {Float32Array[]} opts.channels     source audio, any channel count
 * @param {number} [opts.crossfadeMs]
 * @returns {{channels: Float32Array[], length: number}}
 */
export function renderRecipe({ recipe, map, channels, crossfadeMs = DEFAULT_CROSSFADE_MS }) {
  const total = map.totalSamples;
  const out = channels.map(() => new Float32Array(total));
  if (!total || !recipe || !recipe.steps || !recipe.steps.length || !channels.length) return { channels: out, length: total };

  const steps = recipe.steps;
  const count = Math.min(steps.length, map.count);

  // One flat list of reads across the whole output, each with the position it lands at. Flattening
  // is what lets the join logic below treat "end of a slot" and "end of a stutter fragment" as the
  // same kind of event, which they are.
  const segments = [];
  for (let i = 0; i < count; i++) {
    const slotStart = map.bounds[i];
    const slotLen = map.bounds[i + 1] - slotStart;
    const reads = buildReads(steps[i], map, slotLen);
    if (!reads.length) {
      segments.push({ at: slotStart, len: slotLen, read: null }); // deliberate silence
      continue;
    }
    let pos = slotStart;
    for (const read of reads) {
      segments.push({ at: pos, len: read.count, read });
      pos += read.count;
    }
  }
  if (!segments.length) return { channels: out, length: total };

  const shortest = segments.reduce((min, seg) => Math.min(min, seg.len), Infinity);
  const fadeLen = Math.max(0, Math.min(Math.floor(shortest / 2), Math.round((crossfadeMs / 1000) * map.sampleRate)));
  const scratch = new Float32Array(Math.max(1, fadeLen));

  for (let c = 0; c < channels.length; c++) {
    const src = channels[c];
    const dst = out[c];

    // Pass 1: every segment's audio, in order. Nothing overlaps, so this alone already produces a
    // correct-length, correctly-ordered rearrangement - the crossfades below only clean up joins.
    for (const seg of segments) {
      if (seg.read) copyRead(dst, seg.at, src, seg.read);
      // else: already zeroed by the Float32Array allocation - deliberate silence, written as silence.
    }

    if (fadeLen <= 0) continue;

    // Pass 2: edit boundaries only. Writing into [at - n, at) touches the PREVIOUS segment's tail,
    // never this segment's own audio, so it's safe to do once every segment exists.
    for (let j = 1; j < segments.length; j++) {
      const prev = segments[j - 1];
      const cur = segments[j];
      if (isNaturalJoin(prev.read, cur.read)) continue;
      const n = Math.min(fadeLen, prev.len, cur.len);
      if (n <= 0) continue;
      crossfadeInto(dst, src, cur.at - n, n, cur.read ? leadRead(cur.read, n) : null, scratch);
    }

    // The loop seam. A variation is meant to be auditioned and exported AS A LOOP, so the join from
    // the end back to the start matters exactly as much as any internal one.
    const last = segments[segments.length - 1];
    const first = segments[0];
    if (segments.length > 1 && !isNaturalSeam(last.read, first.read, total)) {
      const n = Math.min(fadeLen, last.len, first.len);
      if (n > 0) crossfadeInto(dst, src, total - n, n, first.read ? leadRead(first.read, n) : null, scratch);
    }
  }

  return { channels: out, length: total };
}

/** Rendered audio in the shape the audition players and the exporter both want. */
export function renderVariationAudio({ recipe, map, channels, sampleRate, crossfadeMs }) {
  const { channels: rendered, length } = renderRecipe({ recipe, map, channels, crossfadeMs });
  return {
    channels: rendered,
    mono: toMono(rendered),
    sampleRate,
    duration: sampleRate > 0 ? length / sampleRate : 0,
    length,
  };
}

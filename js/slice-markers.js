// slice-markers.js
//
// Pure logic behind "WAV with Slice Markers" export: turning the CURRENT canonical chop regions
// (js/chop-regions.js - already accounting for any manual edit, re-chop, or undo/redo) into RIFF cue
// sample-frame offsets, and checking that count against the Dirtywave M8's slice-marker limit. Kept
// separate from js/audio-codec.js (which only knows how to serialize a given list of sample-frame
// offsets into "cue " chunk bytes, with no notion of "region" or "M8") and from app.js (decode/export
// orchestration), so the region->cue math and the hardware constraint can both be unit-tested without
// a browser or a decoded file.

/** Dirtywave M8 slice-marker limit, as of current firmware. Generic WAV cue chunks themselves have no
 * such limit - this is purely an M8 hardware-acceptance constraint, checked separately from encoding
 * so a file with more markers can still be written (see checkM8MarkerLimit's caller in app.js, which
 * warns rather than truncating). */
export const M8_MAX_MARKERS = 128;

/**
 * Each canonical region's START becomes one cue point - the next region's start implicitly ends the
 * previous slice, and the last region runs to the end of the audio, so only starts are needed (see
 * the MARKER SEMANTICS discussion this module's export feature was built against). Regions are
 * sorted by start first, same as exportChopsForRegions's own "sort before cutting" rule, so cue
 * points always land in the order an importer expects.
 *
 * Deliberately does NOT apply the zero-crossing snap that Individual WAV export uses on its chop
 * boundaries: that snap exists to avoid an audible click at a real edit (the file is actually being
 * cut there). A cue point sits inside one continuous, unmodified waveform - nothing is being cut, so
 * there is no click to avoid, and snapping would just move the marker away from the exact position
 * the user set or edited for no benefit.
 *
 * @param {[number,number][]} regions - canonical [start,end] second pairs
 * @param {number} sampleRate
 * @param {number} frameCount - total sample frames in the audio the cues point into, for clamping
 * @returns {number[]} sample-frame offsets, ascending, one per region
 */
export function regionStartsToCueFrames(regions, sampleRate, frameCount) {
  const starts = regions.map(([s]) => s).sort((a, b) => a - b);
  const maxFrame = Math.max(0, frameCount - 1);
  return starts.map((s) => Math.max(0, Math.min(maxFrame, Math.round(s * sampleRate))));
}

/**
 * Whether `count` markers fit the M8's slice-marker limit. Returns the limit and count alongside the
 * verdict so a caller can build a precise warning message without re-importing the constant.
 * @param {number} count
 */
export function checkM8MarkerLimit(count) {
  return { ok: count <= M8_MAX_MARKERS, count, limit: M8_MAX_MARKERS };
}

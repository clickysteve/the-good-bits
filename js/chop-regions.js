// chop-regions.js
//
// Pure decision logic for what Process/Export should do with a file's chop (or one-shot) regions,
// pulled out of app.js's processOneFile() so it can be unit-tested without a browser, a decoded
// file, or essentia. The actual detection (phraseRegions/computeDrumRegions/detectOneShotRegions)
// stays in app.js - this module only decides WHETHER to call it.
//
// The rule the whole "Process must preserve user-edited chops" fix rests on: if a cache entry
// already holds regions (from a fresh detection, a re-chop, or a manual edit - analysisCache doesn't
// distinguish, because the editor writes edits straight back into the same field), Process reuses
// them as-is. Fresh detection only ever runs when there is nothing yet to preserve - the entry is
// missing, or its own detectionSignature() went stale (a settings change that actually affects where
// cuts land, which is its own explicit trigger for re-detection, distinct from re-chop).

/**
 * @param {number[][]|null|undefined} existingRegions - already-canonical regions for this file, if
 *   any (main chops or one-shots - this module doesn't care which), straight from analysisCache
 * @param {number[][]|null|undefined} existingBaseline - that same cache entry's baseline snapshot
 * @param {() => number[][]} detectFresh - called only when there is nothing cached to reuse
 * @returns {{regions: number[][], baseline: number[][], reused: boolean}}
 */
export function resolveRegions(existingRegions, existingBaseline, detectFresh) {
  if (existingRegions) {
    const baseline = existingBaseline || existingRegions.map((r) => [...r]);
    return { regions: existingRegions, baseline, reused: true };
  }
  const regions = detectFresh();
  return { regions, baseline: regions.map((r) => [...r]), reused: false };
}

/**
 * Wholesale replacement of the canonical regions - what an explicit, intentionally destructive
 * action (Re-chop by count/bars, Clear) does. Unlike resolveRegions(), this always produces a fresh
 * baseline too: the whole point of these actions is that Revert should come back to THIS layout, not
 * whatever was detected before it.
 * @param {number[][]} newRegions
 */
export function replaceRegions(newRegions) {
  const regions = newRegions.map((r) => [...r]);
  return { regions, baseline: regions.map((r) => [...r]) };
}

/**
 * The chop (or one-shot) index that should stay selected after Process re-renders a file's editor,
 * given whatever was selected last time. Falls back to "nothing selected" if the previous index no
 * longer points at a real region (e.g. it was deleted, or the set is now shorter).
 * @param {number|null|undefined} previousIndex
 * @param {number} regionCount
 * @returns {number|null}
 */
export function resolveSelection(previousIndex, regionCount) {
  return previousIndex != null && previousIndex >= 0 && previousIndex < regionCount ? previousIndex : null;
}

/**
 * The double-click-to-split gesture (js/editor-waveform.js): splits whichever canonical region
 * contains `time` into two, right at that point, leaving every other region untouched. Refuses -
 * returns null rather than clamping or fabricating an overlapping region - when there's no
 * containing region, or `time` sits close enough to either of that region's own edges that one
 * resulting half would be shorter than `minSliceSec`. That distance check is also what rejects a
 * click that's effectively ON an existing boundary: a point that close to an edge can't be more
 * than `minSliceSec` inside its region either.
 * @param {[number,number][]} regions - canonical regions, sorted by start, non-overlapping
 * @param {number} time
 * @param {number} minSliceSec
 * @returns {{regions:[number,number][], newIndex:number}|null}
 */
export function splitRegionAt(regions, time, minSliceSec) {
  const idx = regions.findIndex(([s, e]) => time >= s && time <= e);
  if (idx === -1) return null;
  const [s, e] = regions[idx];
  if (time - s < minSliceSec || e - time < minSliceSec) return null;
  const next = regions.map((r) => [...r]);
  next.splice(idx, 1, [s, time], [time, e]);
  return { regions: next, newIndex: idx + 1 };
}

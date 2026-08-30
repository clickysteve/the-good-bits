// edit-history.js
//
// Per-(file, region-set) undo/redo for canonical chop/one-shot regions. Deliberately separate from
// chop-regions.js (which decides WHAT a region-mutating action produces) - this only decides how a
// sequence of already-decided region states is remembered and traversed, so it can be unit-tested
// without a browser, a waveform, or analysisCache.
//
// A history is `{ entries: [{regions, selected}], index }` (or null/undefined before the first real
// edit). `entries[index]` is always the canonical state that was live immediately before whatever
// edit is next committed - undo/redo only ever move that pointer and hand back a clone; an entry, once
// pushed, is never mutated in place, so an old snapshot can't be corrupted by a later edit.

const DEFAULT_LIMIT = 80;

function cloneRegions(regions) {
  return (regions || []).map((r) => [...r]);
}

/** True when two region lists are the same boundaries in the same order - used to skip creating a
 * history entry for an edit that round-tripped back to where it started (e.g. a drag released at its
 * own start point, or a Revert/Re-chop that didn't actually change anything). */
export function regionsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}

/**
 * Lazily establishes the history's baseline - the state that existed immediately before the very
 * first edit - so the first Undo ever pressed for this file/set has somewhere real to land. A no-op
 * once a history already has entries: only the very first commit call for a file/set consumes
 * `baselineRegions`/`baselineSelected`, since every later commit already has a current entry to build
 * on regardless of what baseline is passed in.
 * @param {{entries:{regions:number[][],selected:number|null}[],index:number}|null|undefined} history
 * @param {number[][]} baselineRegions
 * @param {number|null} [baselineSelected]
 */
export function ensureHistory(history, baselineRegions, baselineSelected = null) {
  if (history && history.entries && history.entries.length) return history;
  return { entries: [{ regions: cloneRegions(baselineRegions), selected: baselineSelected }], index: 0 };
}

/**
 * Records one completed edit (a finished drag, an add, a delete, a re-chop, a Revert...) as the new
 * current state. Any redo tail is discarded first - "a new edit after Undo clears Redo." Deep-clones
 * the incoming regions so a later mutation of the caller's live array can never reach back into the
 * stack. Enforces `limit` by dropping the oldest entry (never index 0's role as "the still-reachable
 * bottom of the stack" - dropping from the front and decrementing index keeps that consistent).
 * @param {{entries:{regions:number[][],selected:number|null}[],index:number}} history - as returned
 *   by ensureHistory(); never call this against a null/undefined history
 * @param {number[][]} regions
 * @param {number|null} [selected]
 * @param {number} [limit]
 */
export function commitHistory(history, regions, selected = null, limit = DEFAULT_LIMIT) {
  const entries = history.entries.slice(0, history.index + 1);
  entries.push({ regions: cloneRegions(regions), selected });
  let index = history.index + 1;
  if (entries.length > limit) {
    entries.shift();
    index--;
  }
  return { entries, index };
}

export function canUndo(history) {
  return Boolean(history && history.index > 0);
}

export function canRedo(history) {
  return Boolean(history && history.index < history.entries.length - 1);
}

/**
 * @returns {{history:object, snapshot:{regions:number[][],selected:number|null}}|null} the moved
 *   history plus a clone of the snapshot to restore, or null if there's nothing to undo
 */
export function undoHistory(history) {
  if (!canUndo(history)) return null;
  const index = history.index - 1;
  const entry = history.entries[index];
  return { history: { entries: history.entries, index }, snapshot: { regions: cloneRegions(entry.regions), selected: entry.selected } };
}

/** @returns {{history:object, snapshot:{regions:number[][],selected:number|null}}|null} */
export function redoHistory(history) {
  if (!canRedo(history)) return null;
  const index = history.index + 1;
  const entry = history.entries[index];
  return { history: { entries: history.entries, index }, snapshot: { regions: cloneRegions(entry.regions), selected: entry.selected } };
}

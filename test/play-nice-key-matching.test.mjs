// Node-side unit tests for js/play-nice/key-matching.js - the musical rules behind PLAY NICE's
// pitch conforming. No DOM, no audio: this is note-name arithmetic and the "never take the long
// way round the chromatic circle" rule.
// Run with: node test/play-nice-key-matching.test.mjs
import assert from "node:assert/strict";
import {
  noteToIndex,
  indexToNote,
  normalizeMode,
  nearestSemitones,
  resolveTransposition,
  formatKey,
  formatSemitones,
  TRANSPOSE_STRATEGIES,
  DEFAULT_TRANSPOSE_STRATEGY,
} from "../js/play-nice/key-matching.js";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// --- note parsing ------------------------------------------------------------

test("noteToIndex: sharps, flats, unicode accidentals and casing all resolve", () => {
  assert.equal(noteToIndex("C"), 0);
  assert.equal(noteToIndex("A#"), 10);
  assert.equal(noteToIndex("Bb"), 10, "Bb is the same pitch as A#");
  assert.equal(noteToIndex("B♭"), 10, "unicode flat resolves like 'b'");
  assert.equal(noteToIndex("f#"), 6, "lower case resolves");
  assert.equal(noteToIndex("  D  "), 2, "surrounding whitespace is ignored");
});

test("noteToIndex: theoretical enharmonics resolve rather than being rejected", () => {
  assert.equal(noteToIndex("E#"), noteToIndex("F"));
  assert.equal(noteToIndex("Cb"), noteToIndex("B"));
});

test("noteToIndex: anything that isn't a note is null, not 0", () => {
  // 0 would silently mean "C" and quietly transpose a whole batch to the wrong key.
  for (const bad of ["", "H", "xyz", null, undefined, 7, {}]) assert.equal(noteToIndex(bad), null, `${bad} should be null`);
});

test("indexToNote: wraps rather than going out of bounds", () => {
  assert.equal(indexToNote(0), "C");
  assert.equal(indexToNote(12), "C");
  assert.equal(indexToNote(-1), "B");
});

test("normalizeMode: minor spellings collapse; absent stays absent", () => {
  assert.equal(normalizeMode("minor"), "minor");
  assert.equal(normalizeMode("Min"), "minor");
  assert.equal(normalizeMode("major"), "major");
  assert.equal(normalizeMode(""), null, "empty is 'no mode detected', not major");
  assert.equal(normalizeMode(null), null);
});

// --- the "no absurd octave leaps" rule ---------------------------------------

test("nearestSemitones: takes the short way round the chromatic circle", () => {
  // C -> B is one semitone DOWN, not eleven up. This is the whole point of the function.
  assert.equal(nearestSemitones(noteToIndex("C"), noteToIndex("B")), -1);
  assert.equal(nearestSemitones(noteToIndex("B"), noteToIndex("C")), 1);
});

test("nearestSemitones: never exceeds six semitones in either direction", () => {
  for (let from = 0; from < 12; from++) {
    for (let to = 0; to < 12; to++) {
      const st = nearestSemitones(from, to);
      assert.ok(st >= -5 && st <= 6, `${from}->${to} gave ${st}, outside [-5, 6]`);
      // It still has to be the RIGHT interval, not merely a small one.
      assert.equal(((from + st) % 12 + 12) % 12, to);
    }
  }
});

test("nearestSemitones: identical roots need no transposition", () => {
  assert.equal(nearestSemitones(5, 5), 0);
});

test("nearestSemitones: the tritone tie resolves upward, consistently", () => {
  // Six semitones is equally far in both directions; which way it goes matters less than
  // it going the same way every time, across a whole batch.
  assert.equal(nearestSemitones(noteToIndex("C"), noteToIndex("F#")), 6);
  assert.equal(nearestSemitones(noteToIndex("F#"), noteToIndex("C")), 6);
});

// --- resolveTransposition ----------------------------------------------------

test("resolveTransposition: F minor -> D minor is three semitones down", () => {
  const r = resolveTransposition({ key: "F", mode: "minor" }, { key: "D", mode: "minor" });
  assert.equal(r.semitones, -3);
  assert.equal(r.ok, true);
  assert.equal(r.modeMismatch, false);
});

test("nearest-root: a differing mode still transposes, but is flagged", () => {
  // Match root moves a root and nothing else; it cannot turn major into minor. Saying so is
  // the honest answer - silently doing it anyway, or silently refusing, both are not.
  const r = resolveTransposition({ key: "C", mode: "major" }, { key: "A", mode: "minor" }, "nearest-root");
  assert.equal(r.ok, true);
  assert.equal(r.semitones, -3, "C -> A is three down when only the root is matched");
  assert.equal(r.modeMismatch, true);
  assert.equal(r.relativeUsed, false);
});

// --- the major/minor problem -------------------------------------------------
//
// Transposition genuinely cannot change a recording's mode. The "relative" strategy solves
// the problem the other way round: match the target's SCALE instead of its tonic, so the
// source keeps its own mode and still lands in the target's notes.

test("relative is the default, because it only differs where matching roots fails", () => {
  assert.equal(DEFAULT_TRANSPOSE_STRATEGY, "relative");
});

test("relative: identical modes behave exactly like matching roots", () => {
  // The strategies must be indistinguishable in the common case, or the default would be
  // changing behaviour nobody asked it to change.
  for (const [sk, tk] of [["C", "E"], ["F", "D"], ["B", "C"], ["A", "A"]]) {
    for (const mode of ["major", "minor"]) {
      const rel = resolveTransposition({ key: sk, mode }, { key: tk, mode }, "relative");
      const root = resolveTransposition({ key: sk, mode }, { key: tk, mode }, "nearest-root");
      assert.equal(rel.semitones, root.semitones, `${sk} ${mode} -> ${tk} ${mode} diverged`);
    }
  }
});

test("relative: a minor loop conformed to a major target lands on the relative minor", () => {
  // F minor against a C major target -> A minor. Every note of A minor is in C major, so
  // the loop fits the target's harmony while staying the minor recording it always was.
  const r = resolveTransposition({ key: "F", mode: "minor" }, { key: "C", mode: "major" }, "relative");
  assert.equal(r.semitones, 4);
  assert.equal(r.resultKey, "A");
  assert.equal(r.resultMode, "minor");
  assert.equal(r.relativeUsed, true);
  assert.equal(r.modeMismatch, false, "this is handled, not merely reported");
});

test("relative: a major loop conformed to a minor target lands on the relative major", () => {
  const r = resolveTransposition({ key: "F", mode: "major" }, { key: "A", mode: "minor" }, "relative");
  assert.equal(r.semitones, -5);
  assert.equal(r.resultKey, "C");
  assert.equal(r.resultMode, "major");
  assert.equal(r.relativeUsed, true);
});

test("relative: an already-compatible loop is left completely alone", () => {
  // The case that proves the strategy is doing real musical work rather than shuffling
  // numbers: A minor IS C major's relative minor, so a loop in A minor over a C major
  // target needs no transposition at all. Matching roots would have moved it three
  // semitones for no reason and made it sound worse.
  const r = resolveTransposition({ key: "A", mode: "minor" }, { key: "C", mode: "major" }, "relative");
  assert.equal(r.semitones, 0);
  assert.equal(r.relativeUsed, true);

  const root = resolveTransposition({ key: "A", mode: "minor" }, { key: "C", mode: "major" }, "nearest-root");
  assert.equal(root.semitones, 3, "matching roots would have moved it pointlessly");
});

test("relative: the resulting key is always reported, since it isn't always the target", () => {
  // Landing somewhere other than the key the user typed is the most surprising thing the
  // tool does. It must never be silent.
  const r = resolveTransposition({ key: "D", mode: "minor" }, { key: "G", mode: "major" }, "relative");
  assert.equal(r.resultKey, "E", "G major's relative minor is E minor");
  assert.equal(r.resultMode, "minor");
});

test("relative: still never takes the long way round the chromatic circle", () => {
  for (let from = 0; from < 12; from++) {
    for (let to = 0; to < 12; to++) {
      const r = resolveTransposition(
        { key: indexToNote(from), mode: "minor" },
        { key: indexToNote(to), mode: "major" },
        "relative"
      );
      assert.ok(r.semitones >= -5 && r.semitones <= 6, `${from}->${to} gave ${r.semitones}`);
    }
  }
});

test("both strategies preserve the source's own mode - neither claims to change it", () => {
  for (const strategy of ["relative", "nearest-root"]) {
    const r = resolveTransposition({ key: "C", mode: "major" }, { key: "A", mode: "minor" }, strategy);
    assert.equal(r.resultMode, "major", `${strategy} must not pretend it made the loop minor`);
  }
});

test("resolveTransposition: a missing key reports why rather than returning a silent zero", () => {
  const noSource = resolveTransposition({ key: null, mode: null }, { key: "D", mode: "minor" });
  assert.equal(noSource.ok, false);
  assert.equal(noSource.semitones, 0);
  assert.match(noSource.reason, /source key/);

  const noTarget = resolveTransposition({ key: "D", mode: "minor" }, { key: null, mode: null });
  assert.equal(noTarget.ok, false);
  assert.match(noTarget.reason, /target key/);
});

test("resolveTransposition: an unknown strategy falls back rather than throwing", () => {
  // Same forgiving-lookup rule resolveCharacter() uses for stretch characters.
  const r = resolveTransposition({ key: "C", mode: "minor" }, { key: "D", mode: "minor" }, "no-such-strategy");
  assert.equal(r.ok, true);
  assert.equal(r.semitones, 2);
});

test("TRANSPOSE_STRATEGIES: the registry is real and the default is in it", () => {
  // The extension point for future compatible-key behaviour - if this ever stops being a
  // lookup, alternative strategies stop being addable without touching conform.js.
  assert.ok(TRANSPOSE_STRATEGIES[DEFAULT_TRANSPOSE_STRATEGY]);
  assert.equal(typeof TRANSPOSE_STRATEGIES[DEFAULT_TRANSPOSE_STRATEGY].resolve, "function");
});

// --- display -----------------------------------------------------------------

test("formatKey / formatSemitones: signed and unambiguous", () => {
  assert.equal(formatKey("D", "minor"), "D minor");
  assert.equal(formatKey("F#", null), "F#");
  assert.equal(formatKey(null, "minor"), "");
  assert.equal(formatSemitones(3), "+3 st", "direction must always be explicit");
  assert.equal(formatSemitones(-2), "-2 st");
  assert.equal(formatSemitones(0), "0 st");
});

console.log(`\n${passed} test(s) passed${failed ? `, ${failed} FAILED` : ""}.`);

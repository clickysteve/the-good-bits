// Node-side unit tests for js/play-nice/downbeat.js - the rhythmic alignment that decides whether
// a conformed loop actually sits against the reference or merely runs at the same tempo.
// Run with: node test/play-nice-downbeat.test.mjs
import assert from "node:assert/strict";
import { findFirstOnsetSample, gridAlignmentOffset, rotateChannels, alignToDownbeat, GRID_DIVISIONS_PER_BEAT, MIN_GRID_CONFIDENCE } from "../js/play-nice/downbeat.js";

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

const SR = 44100;

/** A percussive loop: a decaying tonal hit on every beat, optionally starting late. */
function loop(bpm, beats, { root = 220, leadSec = 0, exactLength = false } = {}) {
  const spb = 60 / bpm;
  const lead = Math.round(leadSec * SR);
  const n = exactLength ? Math.round(beats * spb * SR) : lead + Math.round(beats * spb * SR);
  const x = new Float32Array(n);
  for (let b = 0; b < beats; b++) {
    const s = lead + Math.round(b * spb * SR);
    const L = Math.round(spb * SR * 0.8);
    for (let i = 0; i < L && s + i < n; i++) {
      const env = Math.exp(-i / (SR * 0.05));
      x[s + i] += 0.7 * env * Math.sin((2 * Math.PI * root * i) / SR);
      if (i < 120) x[s + i] += 0.5 * (1 - i / 120);
    }
  }
  return x;
}
const msOf = (samples) => (samples / SR) * 1000;
/** gridAlignmentOffset returns {samples, confidence}; most assertions here only want the move. */
const offsetMs = (result) => (result == null ? null : msOf(result.samples));

/** A sustained pad/arpeggio: soft attacks, overlapping notes, no transients to lock onto. */
function pad(bpm, beats, { leadSec = 0 } = {}) {
  const spb = 60 / bpm;
  const lead = Math.round(leadSec * SR);
  const n = Math.round(beats * spb * SR);
  const x = new Float32Array(n);
  const notes = [261.63, 311.13, 392.0, 466.16];
  for (let b = 0; b < beats; b++) {
    const s = lead + Math.round(b * spb * SR);
    const L = Math.round(spb * SR * 2.5);
    const f = notes[b % notes.length];
    for (let i = 0; i < L && s + i < n; i++) {
      const attack = Math.min(1, i / (SR * 0.25));
      const release = Math.max(0, 1 - i / L);
      x[s + i] += 0.35 * attack * release * Math.sin((2 * Math.PI * f * i) / SR);
    }
  }
  return x;
}

// --- onset detection ---------------------------------------------------------

test("findFirstOnsetSample: locates the attack to the sample", () => {
  for (const leadMs of [0, 3, 12, 37, 85]) {
    const x = loop(120, 8, { leadSec: leadMs / 1000 });
    const found = findFirstOnsetSample(x, SR);
    const truth = Math.round((leadMs / 1000) * SR);
    assert.ok(Math.abs(found - truth) < SR * 0.001, `lead ${leadMs}ms: found ${found}, expected ${truth}`);
  }
});

test("findFirstOnsetSample: silence has no onset, and says so rather than returning 0", () => {
  // 0 would mean "starts immediately", which is the opposite of the truth and would make
  // the aligner rotate a silent file for no reason.
  assert.equal(findFirstOnsetSample(new Float32Array(SR), SR), null);
  assert.equal(findFirstOnsetSample(new Float32Array(0), SR), null);
  assert.equal(findFirstOnsetSample(null, SR), null);
});

// --- the core rule: fix slop, preserve musical placement ---------------------

test("grid alignment: editing slop is measured and removed", () => {
  for (const leadMs of [11, 18, 31]) {
    const x = loop(120, 8, { leadSec: leadMs / 1000, exactLength: true });
    const offset = offsetMs(gridAlignmentOffset(x, SR, 120));
    assert.ok(Math.abs(offset - leadMs) < 4, `lead ${leadMs}ms measured as ${offset.toFixed(1)}ms`);
  }
});

test("grid alignment: a loop that is already tight is left alone", () => {
  const offset = offsetMs(gridAlignmentOffset(loop(120, 8), SR, 120));
  assert.ok(Math.abs(offset) < 3, `expected ~0, got ${offset.toFixed(1)}ms`);
});

test("grid alignment: a deliberate offbeat start is NOT dragged onto the beat", () => {
  // A loop that starts on the "e" or the "&" is on the grid already. Pulling its first hit
  // to zero would destroy the intended feel - the single most damaging thing an aligner
  // can get wrong, and the reason this measures against a subdivision grid rather than
  // against zero.
  for (const division of [0.25, 0.5, 0.75]) {
    const spb = (60 / 120) * SR;
    const x = new Float32Array(Math.round(8 * spb));
    for (let b = 0; b < 8; b++) {
      const s = Math.round((b + division) * spb);
      for (let i = 0; i < Math.round(spb * 0.8) && s + i < x.length; i++) {
        const env = Math.exp(-i / (SR * 0.05));
        x[s + i] += 0.7 * env * Math.sin((2 * Math.PI * 220 * i) / SR) + (i < 120 ? 0.5 * (1 - i / 120) : 0);
      }
    }
    const offset = offsetMs(gridAlignmentOffset(x, SR, 120));
    assert.ok(Math.abs(offset) < 5, `offbeat start at ${division} beats moved by ${offset.toFixed(1)}ms`);
  }
});

test("grid alignment: the correction can never exceed half a subdivision", () => {
  // The guarantee that stops this ever making a musical decision on the user's behalf.
  const halfGridMs = (60 / 120 / GRID_DIVISIONS_PER_BEAT / 2) * 1000;
  for (const leadMs of [5, 40, 90, 160, 300]) {
    const x = loop(120, 8, { leadSec: leadMs / 1000, exactLength: true });
    const offset = offsetMs(gridAlignmentOffset(x, SR, 120));
    assert.ok(Math.abs(offset) <= halfGridMs + 1, `lead ${leadMs}ms produced a ${offset.toFixed(1)}ms move`);
  }
});

test("grid alignment: needs a tempo, and returns null without one", () => {
  const x = loop(120, 8);
  assert.equal(gridAlignmentOffset(x, SR, 0), null);
  assert.equal(gridAlignmentOffset(x, SR, null), null);
  assert.equal(gridAlignmentOffset(new Float32Array(0), SR, 120), null);
});

test("grid alignment: silence has nothing to align to", () => {
  assert.equal(gridAlignmentOffset(new Float32Array(SR * 4), SR, 120), null);
});

// --- rotation ----------------------------------------------------------------

test("rotateChannels: preserves length exactly", () => {
  // The whole reason this rotates rather than trims: the rest of the pipeline guarantees a
  // whole number of beats, and trimming would break it.
  const x = loop(120, 8);
  for (const shift of [0, 1, 500, -500, x.length + 37]) {
    const [out] = rotateChannels([x], shift);
    assert.equal(out.length, x.length, `shift ${shift} changed the length`);
  }
});

test("rotateChannels: moves the head to the tail, losing nothing", () => {
  const x = Float32Array.from({ length: 10 }, (_, i) => i + 1);
  const [out] = rotateChannels([x], 3);
  assert.deepEqual([...out], [4, 5, 6, 7, 8, 9, 10, 1, 2, 3]);
});

test("rotateChannels: a negative shift rotates the other way", () => {
  const x = Float32Array.from({ length: 5 }, (_, i) => i + 1);
  const [out] = rotateChannels([x], -1);
  assert.deepEqual([...out], [5, 1, 2, 3, 4]);
});

test("rotateChannels: every channel moves together", () => {
  // Rotating channels by different amounts would destroy the stereo image.
  const l = Float32Array.from({ length: 6 }, (_, i) => i);
  const r = Float32Array.from({ length: 6 }, (_, i) => i * 10);
  const [outL, outR] = rotateChannels([l, r], 2);
  assert.deepEqual([...outL], [2, 3, 4, 5, 0, 1]);
  assert.deepEqual([...outR], [20, 30, 40, 50, 0, 10]);
});

test("rotateChannels: a zero shift still returns copies the caller owns", () => {
  const x = loop(120, 4);
  const [out] = rotateChannels([x], 0);
  assert.notEqual(out, x);
  assert.equal(out.length, x.length);
});

// --- the whole correction ----------------------------------------------------

test("alignToDownbeat: removes slop and reports what it did", () => {
  const x = loop(120, 8, { leadSec: 0.031, exactLength: true });
  const result = alignToDownbeat([x], SR, 120);
  assert.equal(result.applied, true);
  assert.equal(result.found, true);
  assert.ok(Math.abs(result.offsetMs - 31) < 5, `moved by ${result.offsetMs.toFixed(1)}ms`);
  assert.equal(result.channels[0].length, x.length, "length must survive");
});

test("alignToDownbeat: converges, so the result is actually on the grid", () => {
  // One pass does not always land it; what matters is that the residual afterwards is ~0.
  for (const leadMs of [8, 19, 31, 44]) {
    const x = loop(120, 8, { leadSec: leadMs / 1000, exactLength: true });
    const result = alignToDownbeat([x], SR, 120);
    const residual = offsetMs(gridAlignmentOffset(result.channels[0], SR, 120));
    assert.ok(Math.abs(residual) < 2, `lead ${leadMs}ms left ${residual.toFixed(2)}ms on the table`);
    assert.equal(result.converged, true);
  }
});

test("alignToDownbeat: an already-tight loop is left untouched", () => {
  const x = loop(120, 8);
  const result = alignToDownbeat([x], SR, 120);
  assert.equal(result.applied, false);
  assert.equal(result.offsetMs, 0);
});

test("alignToDownbeat: silence is reported as unmeasurable, not silently rotated", () => {
  const result = alignToDownbeat([new Float32Array(SR * 4)], SR, 120);
  assert.equal(result.found, false);
  assert.equal(result.applied, false);
});

test("alignToDownbeat: two loops at different tempos end up on the SAME grid", () => {
  // The property the whole feature rests on, stated directly: independently aligning two
  // unrelated loops has to leave them agreeing with each other, not merely tidier.
  const a = alignToDownbeat([loop(120, 8, { root: 220, leadSec: 0.013, exactLength: true })], SR, 120);
  const b = alignToDownbeat([loop(120, 8, { root: 330, leadSec: 0.041, exactLength: true })], SR, 120);
  const ra = offsetMs(gridAlignmentOffset(a.channels[0], SR, 120));
  const rb = offsetMs(gridAlignmentOffset(b.channels[0], SR, 120));
  assert.ok(Math.abs(ra - rb) < 2, `the two loops disagree by ${Math.abs(ra - rb).toFixed(2)}ms`);
});

// --- confidence: knowing when NOT to move anything ---------------------------

test("confidence: percussive material scores far above the threshold", () => {
  const { confidence } = gridAlignmentOffset(loop(120, 16), SR, 120);
  assert.ok(confidence > MIN_GRID_CONFIDENCE * 2, `percussive confidence was only ${confidence.toFixed(2)}`);
});

test("confidence: a sustained pad scores far BELOW it", () => {
  // No attacks means no evidence. Every grid phase scores about the same, so the "winner"
  // is noise - and acting on noise is how a loop gets shoved out of time.
  const { confidence } = gridAlignmentOffset(pad(104, 64), SR, 104);
  assert.ok(confidence < MIN_GRID_CONFIDENCE, `pad confidence was ${confidence.toFixed(2)}, expected below ${MIN_GRID_CONFIDENCE}`);
});

test("a sustained loop is left exactly where the musician put it", () => {
  // The bug this gate exists for: an arpeggio was being rotated by 66ms - about a 32nd
  // note - on the strength of a correlation peak that meant nothing, and it audibly did
  // not sit in time afterwards.
  const x = pad(104, 64, { leadSec: 0.031 });
  const result = alignToDownbeat([x], SR, 104);
  assert.equal(result.confident, false);
  assert.equal(result.applied, false);
  assert.equal(result.offsetMs, 0);
  for (let i = 0; i < x.length; i += 997) assert.equal(result.channels[0][i], x[i], "audio must be untouched");
});

test("percussive material is still corrected - the gate isn't just 'do nothing'", () => {
  const result = alignToDownbeat([loop(120, 16, { leadSec: 0.031, exactLength: true })], SR, 120);
  assert.equal(result.confident, true);
  assert.equal(result.applied, true);
  assert.ok(Math.abs(result.offsetMs - 31) < 5);
});

test("confidence is reported so the UI can explain itself", () => {
  const loud = alignToDownbeat([loop(120, 16)], SR, 120);
  const soft = alignToDownbeat([pad(104, 64)], SR, 104);
  assert.ok(loud.confidence > soft.confidence);
  assert.equal(typeof soft.confidence, "number");
});

console.log(`\n${passed} test(s) passed${failed ? `, ${failed} FAILED` : ""}.`);

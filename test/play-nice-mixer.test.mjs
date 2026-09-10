// Node-side unit tests for the parts of js/play-nice/mixer.js that don't need an AudioContext:
// what the mix contains, how long it is, and the summed waveform it draws.
// Run with: node test/play-nice-mixer.test.mjs
import assert from "node:assert/strict";
import { createMixer } from "../js/play-nice/mixer.js";

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

/** load()/mixPeaks() never touch the context, so this only has to exist, not work. */
const mixer = () => createMixer({ getAudioContext: () => { throw new Error("no context needed"); } });

/** A tone burst occupying the first half of a buffer, so tiling is visible in the peaks. */
function audio(seconds, sampleRate, freq) {
  const n = Math.round(seconds * sampleRate);
  const ch = new Float32Array(n);
  for (let i = 0; i < Math.floor(n / 2); i++) ch[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return { channels: [ch], sampleRate };
}

/**
 * A mix track. Both variants are carried at once so switching Original/Conformed can be a
 * gain change on running sources rather than a restart - see the module header.
 */
function track(id, seconds, sampleRate, freq, opts = {}) {
  return {
    id,
    sampleRate,
    original: audio(seconds, sampleRate, freq),
    conformed: opts.conformedSeconds != null ? audio(opts.conformedSeconds, sampleRate, freq) : audio(seconds, sampleRate, freq),
    gain: opts.gain != null ? opts.gain : 1,
    audible: opts.audible !== false,
  };
}

test("duration is the longest track, so shorter loops tile inside it", () => {
  const m = mixer();
  m.load([track("a", 4, 44100, 220), track("b", 2, 44100, 330)]);
  assert.ok(Math.abs(m.duration() - 4) < 1e-9);
  assert.equal(m.trackCount(), 2);
});

test("empty and silent tracks are dropped rather than counted", () => {
  const m = mixer();
  m.load([
    track("a", 2, 44100, 220),
    { id: "empty", sampleRate: 44100, original: { channels: [new Float32Array(0)], sampleRate: 44100 }, conformed: null },
    { id: "none", sampleRate: 44100, original: null, conformed: null },
  ]);
  assert.equal(m.trackCount(), 1);
});

test("mixPeaks returns the requested number of bins, all finite and in range", () => {
  const m = mixer();
  m.load([track("a", 4, 44100, 220)]);
  const peaks = m.mixPeaks(200);
  assert.equal(peaks.length, 200);
  for (const p of peaks) {
    assert.ok(Number.isFinite(p), "a non-finite peak would break the canvas");
    assert.ok(p >= 0 && p <= 1.01, `peak out of range: ${p}`);
  }
});

test("mixPeaks reads each track at ITS OWN sample rate", () => {
  // The bug: the timeline rate was taken from tracks[0] and every other track indexed by
  // it, so a 48kHz loop drawn against a 44.1kHz timeline came out ~8.8% time-compressed
  // and tiled at the wrong period. Mixed rates are ordinary here - parseWav keeps each
  // file's own rate while decodeAudioData resamples to the context's.
  //
  // Both tracks below are 4s with content in the first half, so a correct mix is loud
  // across the first half of the bins and quiet across the second, whichever rate leads.
  const loud = (peaks, from, to) => {
    let max = 0;
    for (let i = Math.floor(peaks.length * from); i < Math.floor(peaks.length * to); i++) max = Math.max(max, peaks[i]);
    return max;
  };
  for (const order of [
    [track("a", 4, 44100, 220), track("b", 4, 48000, 330)],
    [track("b", 4, 48000, 330), track("a", 4, 44100, 220)],
  ]) {
    const m = mixer();
    m.load(order);
    const peaks = m.mixPeaks(200);
    assert.ok(loud(peaks, 0, 0.45) > 0.2, `first half should be loud (rate order ${order[0].sampleRate} first)`);
    assert.ok(loud(peaks, 0.55, 1) < 0.05, `second half should be silent (rate order ${order[0].sampleRate} first) - got ${loud(peaks, 0.55, 1).toFixed(3)}`);
  }
});

test("mixPeaks tiles a short loop across the full mix length", () => {
  // A 2s loop inside a 4s mix plays twice, and the waveform has to show both passes.
  const m = mixer();
  m.load([track("long", 4, 44100, 220), track("short", 2, 44100, 330)]);
  const peaks = m.mixPeaks(200);
  // The short track is loud in its own first half, i.e. bins 0-25% and 50-75% of the mix.
  let secondPass = 0;
  for (let i = Math.floor(peaks.length * 0.5); i < Math.floor(peaks.length * 0.72); i++) secondPass = Math.max(secondPass, peaks[i]);
  assert.ok(secondPass > 0.1, `the short loop's second pass is missing from the waveform (${secondPass.toFixed(3)})`);
});

test("mixPeaks with nothing loaded is null, not a crash", () => {
  const m = mixer();
  assert.equal(m.mixPeaks(100), null);
  m.load([]);
  assert.equal(m.mixPeaks(100), null);
  assert.equal(m.duration(), 0);
});

test("load() reports position and playing state without a context", () => {
  const m = mixer();
  m.load([track("a", 4, 44100, 220)]);
  assert.equal(m.isPlaying(), false);
  assert.equal(m.position(), 0);
  assert.equal(m.isLooping(), true, "looping is the sensible default for a loop tool");
});

// --- seamless switching -------------------------------------------------------

test("duration follows the ACTIVE variant, which can differ between the two", () => {
  // A conformed loop is a different length from its original, so the transport has to
  // report whichever one is currently audible.
  const m = mixer();
  m.load([track("a", 4, 44100, 220, { conformedSeconds: 3 })]);
  assert.equal(m.activeVariant(), "conformed");
  assert.ok(Math.abs(m.duration() - 3) < 1e-9);
  m.setVariant("original");
  assert.ok(Math.abs(m.duration() - 4) < 1e-9);
});

test("setVariant does not restart or move the playhead", () => {
  // The whole point: A/B is a gain crossfade on sources that never stop. Nothing is playing
  // in this harness, so what is asserted is that switching is not treated as a reload.
  const m = mixer();
  m.load([track("a", 4, 44100, 220)]);
  m.seek(2.5);
  assert.ok(Math.abs(m.position() - 2.5) < 1e-9);
  m.setVariant("original");
  assert.ok(Math.abs(m.position() - 2.5) < 1e-9, "switching variant must not reset position");
});

test("setTrackStates updates mute and level without reloading", () => {
  const m = mixer();
  m.load([track("a", 4, 44100, 220), track("b", 4, 44100, 330)]);
  const before = m.position();
  m.setTrackStates([{ id: "a", audible: false, gain: 1 }, { id: "b", audible: true, gain: 0.5 }]);
  assert.equal(m.position(), before);
  assert.equal(m.trackCount(), 2, "muting removes a track from the SOUND, not from the mix");
});

test("a muted track is drawn out of the waveform too", () => {
  // The waveform has to show what you hear, or the playhead is travelling over a picture of
  // something else.
  const loud = (peaks) => Math.max(...peaks);
  const m = mixer();
  m.load([track("a", 4, 44100, 220)]);
  assert.ok(loud(m.mixPeaks(100)) > 0.2);
  m.setTrackStates([{ id: "a", audible: false, gain: 1 }]);
  assert.ok(loud(m.mixPeaks(100)) < 0.01, "a muted track should not appear in the summed waveform");
});

test("monitoring gain scales the drawn waveform, so it matches what is audible", () => {
  const peak = (m) => Math.max(...m.mixPeaks(100));
  const full = mixer();
  full.load([track("a", 4, 44100, 220, { gain: 1 })]);
  const quiet = mixer();
  quiet.load([track("a", 4, 44100, 220, { gain: 0.25 })]);
  assert.ok(peak(quiet) < peak(full) * 0.5);
});

console.log(`\n${passed} test(s) passed${failed ? `, ${failed} FAILED` : ""}.`);

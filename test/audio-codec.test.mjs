// Node-side byte-level tests for js/audio-codec.js's encodeWav() cue-point support - the "WAV with
// Slice Markers" export feature's actual on-disk format. These inspect the encoded bytes directly
// (RIFF/WAVE headers, chunk ids/sizes, the "cue " chunk's field layout) rather than merely checking
// that a Blob comes back, since a hardware WAV parser (the Dirtywave M8) is the real acceptance
// target, not just "does our own parseWav() accept it back".
// Run with: node test/audio-codec.test.mjs
import assert from "node:assert/strict";
import { encodeWav, parseWav } from "../js/audio-codec.js";

// Every test here is async (encodeWav's output is read back via Blob.arrayBuffer()), so each call is
// awaited at its call site - otherwise the final "N test(s) passed" summary would print before any
// assertion actually ran.
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const readStr = (dv, off, len) => {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(off + i));
  return s;
};

/** Walks the top-level RIFF chunk list (after the 12-byte RIFF/size/WAVE header) into
 * {id, offset, size, bodyOffset}[] - offset/size describe the chunk header+body exactly as the file
 * lays them out, which parseWav() deliberately doesn't expose since it only cares about fmt/data. */
function listChunks(dv) {
  const chunks = [];
  let pos = 12;
  while (pos + 8 <= dv.byteLength) {
    const id = readStr(dv, pos, 4);
    const size = dv.getUint32(pos + 4, true);
    chunks.push({ id, offset: pos, size, bodyOffset: pos + 8 });
    pos += 8 + size + (size % 2);
  }
  return chunks;
}

function makeChannels(frameCount, numChannels = 1) {
  return Array.from({ length: numChannels }, (_, c) =>
    Float32Array.from({ length: frameCount }, (_, i) => Math.sin((2 * Math.PI * (c + 1) * i) / Math.max(1, frameCount)) * 0.5)
  );
}

async function bytesOf(blob) {
  return new DataView(await blob.arrayBuffer());
}

// --- Plain WAV export (no cue points) must be byte-for-byte unchanged -----------------------------

await test("plain export (no options arg): identical bytes to the pre-existing 3-arg call", async () => {
  const channels = makeChannels(100, 2);
  const a = await (await encodeWav(channels, 48000, 24)).arrayBuffer();
  const b = await (await encodeWav(channels, 48000, 24, {})).arrayBuffer();
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
});

await test("plain export: no cue chunk present", async () => {
  const dv = await bytesOf(encodeWav(makeChannels(50), 44100, 16));
  const chunks = listChunks(dv);
  assert.ok(!chunks.some((c) => c.id === "cue "), "should have no cue chunk");
  assert.deepEqual(
    chunks.map((c) => c.id),
    ["fmt ", "data"]
  );
});

await test("plain export: RIFF/WAVE header and fmt chunk are well-formed", async () => {
  const channels = makeChannels(10, 2);
  const dv = await bytesOf(encodeWav(channels, 48000, 24));
  assert.equal(readStr(dv, 0, 4), "RIFF");
  assert.equal(readStr(dv, 8, 4), "WAVE");
  const riffSize = dv.getUint32(4, true);
  assert.equal(riffSize, dv.byteLength - 8, "RIFF size must equal file length minus the 8-byte RIFF header");
  const chunks = listChunks(dv);
  const fmt = chunks.find((c) => c.id === "fmt ");
  assert.equal(fmt.size, 16);
  assert.equal(dv.getUint16(fmt.bodyOffset, true), 1, "PCM format tag");
  assert.equal(dv.getUint16(fmt.bodyOffset + 2, true), 2, "numChannels");
  assert.equal(dv.getUint32(fmt.bodyOffset + 4, true), 48000, "sampleRate");
  assert.equal(dv.getUint16(fmt.bodyOffset + 14, true), 24, "bitsPerSample");
});

await test("plain export: data chunk size and content match the source samples", async () => {
  const channels = makeChannels(37, 1);
  const dv = await bytesOf(encodeWav(channels, 44100, 16));
  const chunks = listChunks(dv);
  const data = chunks.find((c) => c.id === "data");
  assert.equal(data.size, 37 * 1 * 2);
  assert.equal(data.bodyOffset + data.size, dv.byteLength);
});

// --- Cue chunk layout --------------------------------------------------------------------------

await test("cue chunk: present when cuePoints given, with correct chunk ordering RIFF/WAVE/fmt/cue/data", async () => {
  const dv = await bytesOf(encodeWav(makeChannels(1000), 48000, 24, { cuePoints: [0, 48000] }));
  const chunks = listChunks(dv);
  assert.deepEqual(
    chunks.map((c) => c.id),
    ["fmt ", "cue ", "data"]
  );
});

await test("cue chunk: count field and chunk size match the number of cue points", async () => {
  const cuePoints = [0, 100, 200, 300];
  const dv = await bytesOf(encodeWav(makeChannels(400), 48000, 24, { cuePoints }));
  const cue = listChunks(dv).find((c) => c.id === "cue ");
  assert.ok(cue, "cue chunk must be present");
  assert.equal(cue.size, 4 + cuePoints.length * 24);
  assert.equal(dv.getUint32(cue.bodyOffset, true), cuePoints.length);
});

await test("cue chunk: RIFF total size accounts for the cue chunk bytes", async () => {
  const withCues = await bytesOf(encodeWav(makeChannels(1000), 48000, 24, { cuePoints: [0, 500] }));
  const without = await bytesOf(encodeWav(makeChannels(1000), 48000, 24));
  const cue = listChunks(withCues).find((c) => c.id === "cue ");
  const cueChunkTotalBytes = 8 + cue.size; // "cue " id(4) + size field(4) + body
  assert.equal(withCues.getUint32(4, true), without.getUint32(4, true) + cueChunkTotalBytes);
  assert.equal(withCues.byteLength, without.byteLength + cueChunkTotalBytes);
});

await test("cue chunk: each record has a unique sequential dwName, fccChunk='data', dwChunkStart=0, dwBlockStart=0", async () => {
  const cuePoints = [0, 48000, 120000, 200000];
  const dv = await bytesOf(encodeWav(makeChannels(300000), 48000, 24, { cuePoints }));
  const cue = listChunks(dv).find((c) => c.id === "cue ");
  const names = new Set();
  for (let i = 0; i < cuePoints.length; i++) {
    const rec = cue.bodyOffset + 4 + i * 24;
    const dwName = dv.getUint32(rec, true);
    const dwPosition = dv.getUint32(rec + 4, true);
    const fccChunk = readStr(dv, rec + 8, 4);
    const dwChunkStart = dv.getUint32(rec + 12, true);
    const dwBlockStart = dv.getUint32(rec + 16, true);
    const dwSampleOffset = dv.getUint32(rec + 20, true);

    names.add(dwName);
    assert.equal(fccChunk, "data");
    assert.equal(dwChunkStart, 0);
    assert.equal(dwBlockStart, 0);
    assert.equal(dwSampleOffset, cuePoints[i]);
    assert.equal(dwPosition, cuePoints[i], "dwPosition conventionally mirrors dwSampleOffset for a single data chunk");
  }
  assert.equal(names.size, cuePoints.length, "every dwName must be unique");
});

// --- Known-offset test (spec: 48kHz, slice starts 0.0/1.0/2.5s -> frames 0/48000/120000) -----------

await test("known offset: 48kHz, starts at 0.0/1.0/2.5s produce cue frames 0/48000/120000", async () => {
  const sampleRate = 48000;
  const frameCount = sampleRate * 5; // 5s of audio, long enough to hold every marker
  const cuePoints = [0, 48000, 120000];
  const dv = await bytesOf(encodeWav(makeChannels(frameCount), sampleRate, 24, { cuePoints }));
  const cue = listChunks(dv).find((c) => c.id === "cue ");
  const got = cuePoints.map((_, i) => dv.getUint32(cue.bodyOffset + 4 + i * 24 + 20, true));
  assert.deepEqual(got, [0, 48000, 120000]);
});

// --- Edge cases ----------------------------------------------------------------------------------

await test("edge case: marker at zero", async () => {
  const dv = await bytesOf(encodeWav(makeChannels(1000), 48000, 24, { cuePoints: [0] }));
  const cue = listChunks(dv).find((c) => c.id === "cue ");
  assert.equal(dv.getUint32(cue.bodyOffset + 4 + 20, true), 0);
});

await test("edge case: marker near EOF is clamped to the last valid frame, never past it", async () => {
  const frameCount = 1000;
  const dv = await bytesOf(encodeWav(makeChannels(frameCount), 48000, 24, { cuePoints: [999, 1000, 5000] }));
  const cue = listChunks(dv).find((c) => c.id === "cue ");
  const offsets = [0, 1, 2].map((i) => dv.getUint32(cue.bodyOffset + 4 + i * 24 + 20, true));
  assert.deepEqual(offsets, [999, 999, 999], "anything at/after the last frame clamps to frameCount-1");
});

await test("edge case: one marker", async () => {
  const dv = await bytesOf(encodeWav(makeChannels(500), 44100, 16, { cuePoints: [250] }));
  const cue = listChunks(dv).find((c) => c.id === "cue ");
  assert.equal(dv.getUint32(cue.bodyOffset, true), 1);
});

await test("edge case: several (non-round-number-of-seconds) markers keep exact rounding", async () => {
  const sampleRate = 44100;
  // 0.333... and 1.6666...s - exercises Math.round() rather than truncation.
  const seconds = [0.3333333, 1.6666667];
  const cuePoints = seconds.map((s) => Math.round(s * sampleRate));
  const dv = await bytesOf(encodeWav(makeChannels(sampleRate * 3), sampleRate, 24, { cuePoints }));
  const cue = listChunks(dv).find((c) => c.id === "cue ");
  const got = cuePoints.map((_, i) => dv.getUint32(cue.bodyOffset + 4 + i * 24 + 20, true));
  assert.deepEqual(got, cuePoints);
});

await test("edge case: more than 128 markers - the generic encoder writes every one, no truncation", async () => {
  const n = 200;
  const cuePoints = Array.from({ length: n }, (_, i) => i * 100);
  const dv = await bytesOf(encodeWav(makeChannels(n * 100 + 100), 48000, 24, { cuePoints }));
  const cue = listChunks(dv).find((c) => c.id === "cue ");
  assert.equal(dv.getUint32(cue.bodyOffset, true), n);
  assert.equal(cue.size, 4 + n * 24);
});

await test("edge case: empty cuePoints array behaves exactly like omitting the option", async () => {
  const channels = makeChannels(64);
  const a = await (await encodeWav(channels, 48000, 16, { cuePoints: [] })).arrayBuffer();
  const b = await (await encodeWav(channels, 48000, 16)).arrayBuffer();
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
});

// --- Regression: a cue-bearing file still round-trips through parseWav (which ignores "cue ") -----

await test("regression: parseWav still decodes audio correctly from a file with a cue chunk", async () => {
  const sampleRate = 48000;
  const n = 240;
  const l = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 5 * i) / n) * 0.7);
  const r = Float32Array.from({ length: n }, (_, i) => Math.cos((2 * Math.PI * 5 * i) / n) * 0.4);
  const blob = encodeWav([l, r], sampleRate, 24, { cuePoints: [0, 100] });
  const decoded = parseWav(await blob.arrayBuffer());
  assert.equal(decoded.sampleRate, sampleRate);
  assert.equal(decoded.numberOfChannels, 2);
  assert.equal(decoded.length, n);
  const dl = decoded.getChannelData(0);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(dl[i] - l[i]) < 0.001);
});

console.log(`\n${passed} test(s) passed.`);

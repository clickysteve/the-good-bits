// The lo-fi stages now run on Slop Factory Core's output engines (js/outputstage.js is a thin
// layer over js/vendor/slopfactory-core/engines.js). These checks pin the migration down:
// every stage, mode, shape and the full chain must produce exactly the samples the original,
// standalone js/outputstage.js produced. The hashes in outputstage-golden.json were recorded
// from that original file (The Good Bits 2.0, commit 31a2c16) before the move.
// Run with: node test/outputstage-core.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as api from "../js/outputstage.js";
import { cases, hash, signal } from "./outputstage-golden.mjs";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const golden = JSON.parse(readFileSync(new URL("./outputstage-golden.json", import.meta.url), "utf8"));

test("every case recorded from the original file is still covered", () => {
  assert.deepEqual(cases().map(([n]) => n).sort(), Object.keys(golden).sort());
});

test("output stage, drive, crunch and the chain are sample-identical to the original implementation", () => {
  const wrong = [];
  for (const [name, fn] of cases()) if (hash(fn(api)) !== golden[name]) wrong.push(name);
  assert.deepEqual(wrong, []);
});

test("lofiChainConfig: The Good Bits order, only enabled stages, no-op stages left out", () => {
  const c = api.lofiChainConfig({
    outputStage: { enabled: true, mode: "vinyl", mixPct: 100, intensityPct: 50 },
    drive: { enabled: true, type: "tube", amountPct: 0 },
    crunch: { enabled: true, bits: 6, rateDivide: 2 },
  });
  assert.deepEqual(c.stages.map((s) => s.engine), ["goodbits.output-stage", "goodbits.crunch"]);
  assert.equal(api.lofiChainConfig({}).stages.length, 0);
  assert.equal(api.lofiChainConfig({ outputStage: { enabled: true, mode: "clean", mixPct: 100 } }).stages.length, 0);
});

test("the catalogues come from the Core engines' metadata", () => {
  const modes = api.GOOD_BITS_ENGINES.get("goodbits.output-stage").params.find((p) => p.id === "mode").options.map((o) => o.value);
  assert.deepEqual(api.OUTPUT_STAGES.slice(1).map((s) => s.key), modes);
  assert.deepEqual(api.GOOD_BITS_ENGINES.list().map((e) => e.id), ["goodbits.output-stage", "goodbits.drive", "goodbits.crunch"]);
});

test("inputs are never modified", () => {
  const src = signal(2000, 44100, true);
  const before = src.map((c) => Float32Array.from(c));
  api.applyLofiChain(src, 44100, { outputStage: { enabled: true, mode: "damaged", mixPct: 100, intensityPct: 100 }, crunch: { enabled: true, bits: 2, rateDivide: 5 } }, 3);
  assert.deepEqual(src, before);
});

console.log(`\n${passed} passed`);

// Node-side unit tests for js/play-nice/naming.js and js/play-nice/roles.js - what conformed files
// are called, and the input-role capability model the pipeline consults instead of assuming
// everything it is handed is a tempo-bearing loop.
// Run with: node test/play-nice-naming.test.mjs
import assert from "node:assert/strict";
import { conformedFileName, batchFolderName, uniqueName, stemOf, PLAY_NICE_OUTPUT_DIR } from "../js/play-nice/naming.js";
import { ROLES, resolveRole, roleSupports, DEFAULT_ROLE } from "../js/play-nice/roles.js";
import { planConform } from "../js/play-nice/conform.js";
import { createTargetContext } from "../js/play-nice/target-context.js";

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

const target = createTargetContext({ bpm: 128, key: "E", keyMode: "minor" });
const plan = (over = {}) =>
  planConform({ role: "loop", source: { bpm: 100, key: "C", mode: "minor" }, target, tempoFit: true, pitchFit: true, method: "clean", sessionMethod: "clean", ...over });

// --- filenames ---------------------------------------------------------------

test("stemOf: drops the extension, keeps dots inside the name", () => {
  assert.equal(stemOf("Amen Break.wav"), "Amen Break");
  assert.equal(stemOf("loop.v2.aiff"), "loop.v2");
  assert.equal(stemOf("noextension"), "noextension");
});

test("the original name stays recognisable, and the marker says PLAY NICE touched it", () => {
  const name = conformedFileName("Amen Break.wav", target, plan());
  assert.ok(name.startsWith("Amen Break"), `"${name}" should lead with the original stem`);
  assert.ok(name.includes("play nice"), "the marker has to be there");
  assert.ok(name.endsWith(".wav"));
});

test("the name records what it was conformed to", () => {
  const name = conformedFileName("loop.wav", target, plan());
  assert.ok(name.includes("128bpm"));
  assert.ok(name.includes("Em"));
});

test("a tempo-only conform doesn't claim a key it never touched", () => {
  // A filename that names a key the audio was never moved to is worse than a longer name.
  const name = conformedFileName("loop.wav", target, plan({ pitchFit: false }));
  assert.ok(name.includes("128bpm"));
  assert.ok(!name.includes("Em"), `"${name}" should not mention a key`);
});

test("a pitch-only conform doesn't claim a tempo it never touched", () => {
  const name = conformedFileName("loop.wav", target, plan({ tempoFit: false }));
  assert.ok(name.includes("Em"));
  assert.ok(!name.includes("128bpm"), `"${name}" should not mention a tempo`);
});

test("output can never land on top of a source file", () => {
  // The source is "loop.wav"; the output must not be.
  const name = conformedFileName("loop.wav", target, plan());
  assert.notEqual(name, "loop.wav");
});

test("path-hostile characters in a source name are sanitised away", () => {
  const name = conformedFileName("dr/um*s: <bad>.wav", target, plan());
  for (const ch of ["/", "\\", ":", "*", "?", '"', "<", ">", "|"]) {
    assert.ok(!name.includes(ch), `"${name}" still contains ${ch}`);
  }
  assert.ok(name.endsWith(".wav"));
});

test("an enormous source name is truncated rather than producing an unwritable path", () => {
  const name = conformedFileName(`${"x".repeat(400)}.wav`, target, plan());
  assert.ok(name.length < 220, `name was ${name.length} chars`);
});

test("a source name that sanitises to nothing still yields a usable filename", () => {
  const name = conformedFileName("///.wav", target, plan());
  assert.ok(name.endsWith(".wav"));
  assert.ok(name.length > 4);
});

// --- folders and collisions --------------------------------------------------

test("the batch folder names the target it holds", () => {
  const folder = batchFolderName(target);
  assert.ok(folder.includes("play nice"));
  assert.ok(folder.includes("128bpm"));
  assert.ok(!folder.includes("/"), "a folder name must be one path segment");
});

test("the batch folder degrades to a plain name when there is no target detail", () => {
  const folder = batchFolderName(createTargetContext({ bpm: null, pitchEnabled: false }));
  assert.ok(folder.length > 0);
  assert.equal(typeof PLAY_NICE_OUTPUT_DIR, "string");
});

test("uniqueName: two sources called loop.wav never overwrite each other", () => {
  // Batch export flattens separate folders into one destination, so this is a real
  // collision, not a hypothetical one.
  const taken = new Set();
  assert.equal(uniqueName("loop.wav", taken), "loop.wav");
  assert.equal(uniqueName("loop.wav", taken), "loop 2.wav");
  assert.equal(uniqueName("loop.wav", taken), "loop 3.wav");
  assert.equal(uniqueName("other.wav", taken), "other.wav");
});

// --- roles -------------------------------------------------------------------

test("roles: a loop conforms tempo and pitch; a one-shot only pitch", () => {
  assert.equal(roleSupports("loop", "fitTempo"), true);
  assert.equal(roleSupports("loop", "fitPitch"), true);
  assert.equal(roleSupports("oneShot", "fitTempo"), false, "a one-shot has no tempo to conform");
  assert.equal(roleSupports("oneShot", "fitPitch"), true);
});

test("roles: a reference defines the target and is never conformed or exported", () => {
  assert.equal(roleSupports("reference", "definesTarget"), true);
  assert.equal(roleSupports("reference", "fitTempo"), false);
  assert.equal(roleSupports("reference", "exportable"), false);
  assert.equal(roleSupports("loop", "definesTarget"), false);
});

test("roles: analysis is asked per role, so a one-shot is never BPM-analysed", () => {
  assert.equal(roleSupports("oneShot", "analyzeTempo"), false);
  assert.equal(roleSupports("oneShot", "analyzeKey"), true);
  assert.equal(roleSupports("loop", "analyzeTempo"), true);
});

test("roles: an unrecognised role falls back rather than throwing", () => {
  assert.equal(resolveRole("nonsense").key, DEFAULT_ROLE);
  assert.equal(roleSupports("nonsense", "fitTempo"), true);
});

test("roles: every role declares every capability the pipeline asks about", () => {
  // A missing capability would read as false and silently disable something.
  const required = ["analyzeTempo", "analyzeKey", "fitTempo", "fitPitch", "definesTarget", "exportable", "generative"];
  for (const [key, role] of Object.entries(ROLES)) {
    for (const cap of required) assert.equal(typeof role[cap], "boolean", `${key} is missing ${cap}`);
  }
});

console.log(`\n${passed} test(s) passed${failed ? `, ${failed} FAILED` : ""}.`);

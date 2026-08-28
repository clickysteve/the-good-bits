// Node-side unit tests for the parts of io-fs.js that don't touch the DOM
// (collectAudioFilesLegacy / collectIndividualFilesLegacy operate on plain
// data shaped like a FileList, so they're testable without a browser).
// Run with: node test/io-fs.test.mjs
import assert from "node:assert/strict";
import { collectAudioFilesLegacy, collectIndividualFilesLegacy } from "../js/io-fs.js";

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

function mockFile(webkitRelativePath, name) {
  return { webkitRelativePath, name };
}

test("collectAudioFilesLegacy: flat mode groups everything under the picked folder", () => {
  const files = [
    mockFile("MySession/take1.wav", "take1.wav"),
    mockFile("MySession/Sub/take2.wav", "take2.wav"),
    mockFile("MySession/notes.txt", "notes.txt"), // not audio, should be dropped
    mockFile("MySession/wav/converted.wav", "converted.wav"), // inside excluded "wav" segment
  ];
  const groups = collectAudioFilesLegacy(files, { splitSubfolders: false });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].rootName, "MySession");
  assert.equal(groups[0].files.length, 2);
  const names = groups[0].files.map((f) => f.name).sort();
  assert.deepEqual(names, ["take1.wav", "take2.wav"]);
});

test("collectAudioFilesLegacy: splitSubfolders groups by immediate child folder", () => {
  const files = [
    mockFile("Parent/SessionA/take1.wav", "take1.wav"),
    mockFile("Parent/SessionA/take2.wav", "take2.wav"),
    mockFile("Parent/SessionB/take1.wav", "take1.wav"),
    mockFile("Parent/loose.wav", "loose.wav"), // sits directly in the picked folder
  ];
  const groups = collectAudioFilesLegacy(files, { splitSubfolders: true });
  const byRoot = Object.fromEntries(groups.map((g) => [g.rootName, g.files]));
  assert.equal(groups.length, 3, `expected 3 groups, got ${JSON.stringify(groups.map((g) => g.rootName))}`);
  assert.equal(byRoot["Parent/SessionA"].length, 2);
  assert.equal(byRoot["Parent/SessionB"].length, 1);
  assert.equal(byRoot["Parent"].length, 1);
  assert.equal(byRoot["Parent"][0].name, "loose.wav");
});

test("collectAudioFilesLegacy: excludes wav/ and chops/ segments even when splitting", () => {
  const files = [
    mockFile("Parent/SessionA/chops/take1/01.wav", "01.wav"),
    mockFile("Parent/SessionA/take1.wav", "take1.wav"),
  ];
  const groups = collectAudioFilesLegacy(files, { splitSubfolders: true });
  const sessionA = groups.find((g) => g.rootName === "Parent/SessionA");
  assert.equal(sessionA.files.length, 1);
  assert.equal(sessionA.files[0].name, "take1.wav");
});

test("collectAudioFilesLegacy: returns [] for an empty FileList", () => {
  assert.deepEqual(collectAudioFilesLegacy([], { splitSubfolders: false }), []);
});

test("collectIndividualFilesLegacy: builds one relativeDir-less group, filtering non-audio", () => {
  const files = [{ name: "a.wav" }, { name: "b.mp3" }, { name: "readme.txt" }];
  const group = collectIndividualFilesLegacy(files, "Individual files 1");
  assert.equal(group.rootName, "Individual files 1");
  assert.equal(group.files.length, 2);
  assert.ok(group.files.every((f) => f.relativeDir === ""));
});

console.log(`\n${passed} test(s) passed.`);

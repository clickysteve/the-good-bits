// Node-side unit tests for the parts of io-fs.js that don't touch the DOM
// (collectAudioFilesLegacy / collectIndividualFilesLegacy operate on plain
// data shaped like a FileList, so they're testable without a browser).
// Run with: node test/io-fs.test.mjs
import assert from "node:assert/strict";
import {
  collectAudioFilesLegacy,
  collectIndividualFilesLegacy,
  clearOldNumberedFilesFSA,
  clearOldChopsFSA,
  collectAudioFilesFSA,
  formatSourcePath,
} from "../js/io-fs.js";

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

async function asyncTest(name, fn) {
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

function mockFile(webkitRelativePath, name) {
  return { webkitRelativePath, name };
}

/**
 * Minimal fake FileSystemDirectoryHandle: just enough of the real API's shape
 * (getDirectoryHandle/entries/removeEntry) for clearOldNumberedFilesFSA() to exercise, with no real
 * filesystem underneath - a plain in-memory tree of {dirs: Map<string,FakeDir>, files: Map<string,any>}.
 */
function fakeDir(files = {}, dirs = {}) {
  return {
    kind: "directory",
    files: new Map(Object.entries(files).map(([name]) => [name, { kind: "file", name }])),
    dirs: new Map(Object.entries(dirs)),
    async getDirectoryHandle(name, { create = false } = {}) {
      if (this.dirs.has(name)) return this.dirs.get(name);
      if (!create) {
        const err = new Error(`NotFoundError: ${name}`);
        err.name = "NotFoundError";
        throw err;
      }
      const child = fakeDir();
      this.dirs.set(name, child);
      return child;
    },
    async *entries() {
      for (const [name, handle] of this.files) yield [name, handle];
      for (const [name, handle] of this.dirs) yield [name, handle];
    },
    async removeEntry(name) {
      if (!this.files.delete(name)) throw new Error(`no such file: ${name}`);
    },
  };
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

test("collectAudioFilesLegacy: excludes the 'clean copy' output segments too, not just chops/one shots", () => {
  const files = [
    mockFile("Parent/chops clean/take1/01.wav", "01.wav"),
    mockFile("Parent/one shots clean/take1/01.wav", "01.wav"),
    mockFile("Parent/take1.wav", "take1.wav"),
  ];
  const groups = collectAudioFilesLegacy(files, { splitSubfolders: false });
  const parent = groups.find((g) => g.rootName === "Parent");
  assert.equal(parent.files.length, 1);
  assert.equal(parent.files[0].name, "take1.wav");
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

await asyncTest("clearOldNumberedFilesFSA: does NOT create a 'chops clean' directory that didn't already exist (the empty-clean-folder bug)", async () => {
  const root = fakeDir();
  await clearOldNumberedFilesFSA(root, "chops clean", "", "take1");
  assert.equal(root.dirs.has("chops clean"), false, "cleaning up must never bring the directory into existence");
});

await asyncTest("clearOldNumberedFilesFSA: does NOT create the nested stem directory either, when the root exists but the stem folder doesn't", async () => {
  const root = fakeDir({}, { "chops clean": fakeDir() });
  await clearOldNumberedFilesFSA(root, "chops clean", "", "take1");
  const cleanRoot = root.dirs.get("chops clean");
  assert.equal(cleanRoot.dirs.has("take1"), false);
});

await asyncTest("clearOldNumberedFilesFSA: removes existing NN.wav files but leaves other files alone, when the directory already exists", async () => {
  const stemDir = fakeDir({ "01.wav": true, "02.wav": true, "notes.txt": true });
  const root = fakeDir({}, { chops: fakeDir({}, { take1: stemDir }) });
  await clearOldNumberedFilesFSA(root, "chops", "", "take1");
  assert.deepEqual([...stemDir.files.keys()], ["notes.txt"]);
});

await asyncTest("clearOldChopsFSA: a first-ever export (no chops/ directory yet) is a silent no-op, not an error", async () => {
  const root = fakeDir();
  await assert.doesNotReject(() => clearOldChopsFSA(root, "", "take1"));
  assert.equal(root.dirs.has("chops"), false);
});

// --- collectAudioFilesFSA: recursive traversal of File System Access API directory handles ------
// (fakeDir()'s entries() already yields nested directory handles the same shape a real
// FileSystemDirectoryHandle does, so it exercises the real recursion in collectAudioFilesFSA.)

await asyncTest("collectAudioFilesFSA: finds files nested arbitrarily deep, not just directly inside the picked folder", async () => {
  const root = fakeDir(
    { "drums.wav": true },
    { Vocals: fakeDir({ "take1.wav": true }, { More: fakeDir({ "take2.wav": true }) }) }
  );
  const files = await collectAudioFilesFSA(root);
  const found = files.map((f) => (f.relativeDir ? `${f.relativeDir}/${f.name}` : f.name)).sort();
  assert.deepEqual(found, ["Vocals/More/take2.wav", "Vocals/take1.wav", "drums.wav"]);
});

await asyncTest("collectAudioFilesFSA: ignores unsupported file types found in a nested subfolder", async () => {
  const root = fakeDir({}, { Sub: fakeDir({ "notes.txt": true, "take.wav": true, "cover.png": true }) });
  const files = await collectAudioFilesFSA(root);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "take.wav");
});

await asyncTest("collectAudioFilesFSA: same basename in two different nested subfolders stay distinct via relativeDir", async () => {
  const root = fakeDir({}, {
    A: fakeDir({ "loop.wav": true }),
    B: fakeDir({ "loop.wav": true }),
  });
  const files = await collectAudioFilesFSA(root);
  assert.equal(files.length, 2, "both files must be discovered, not deduped/collided into one");
  const keys = files.map((f) => `${f.relativeDir}/${f.name}`).sort();
  assert.deepEqual(keys, ["A/loop.wav", "B/loop.wav"]);
  // Distinct handle identity too, not just distinct-looking descriptors aliasing the same handle.
  assert.notStrictEqual(files[0].fsaHandle, files[1].fsaHandle);
});

await asyncTest("collectAudioFilesFSA: excludes a nested 'chops'/'wav' output segment, at any depth", async () => {
  const root = fakeDir({}, {
    Session: fakeDir({ "take1.wav": true }, { chops: fakeDir({ "01.wav": true }) }),
  });
  const files = await collectAudioFilesFSA(root);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "take1.wav");
});

// --- formatSourcePath: compact provenance display for one source file --------------------------

test("formatSourcePath: a file directly in the picked folder (no relativeDir)", () => {
  assert.equal(formatSourcePath("Samples", "", "vocals.m4a"), "Samples / vocals.m4a");
});

test("formatSourcePath: a recursive import's relativeDir is split into its own path segments", () => {
  assert.equal(formatSourcePath("Samples", "Trumpets/Weird", "vocals.m4a"), "Samples / Trumpets / Weird / vocals.m4a");
});

test("formatSourcePath: no root name available (e.g. an individually-picked file) - falls back to just the file", () => {
  assert.equal(formatSourcePath("", "", "vocals.m4a"), "vocals.m4a");
});

test("formatSourcePath: two files with the same basename from different subfolders produce distinct paths", () => {
  const a = formatSourcePath("Samples", "Trumpets/Session 03", "vocals.m4a");
  const b = formatSourcePath("Samples", "Trumpets/Session 04", "vocals.m4a");
  assert.notEqual(a, b);
  assert.equal(a, "Samples / Trumpets / Session 03 / vocals.m4a");
  assert.equal(b, "Samples / Trumpets / Session 04 / vocals.m4a");
});

console.log(`\n${passed} test(s) passed.`);

// Node-side unit tests for folder-store.js's graceful-degradation contract.
//
// The module's real job (storing FileSystemDirectoryHandle objects in IndexedDB) only makes sense
// in a browser with the File System Access API, so it can't be meaningfully exercised in Node.
// What CAN be tested here, and matters just as much: every exported function is best-effort and
// must never throw when IndexedDB simply isn't present (Node has no `indexedDB` global at all,
// which is exactly the "not available" branch each function is supposed to handle quietly).
// Run with: node test/folder-store.test.mjs
import assert from "node:assert/strict";
import { rememberFolder, listRememberedFolders, forgetFolder, forgetAllFolders } from "../js/folder-store.js";

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

test("indexedDB is genuinely absent in this environment (sanity check for the rest of this file)", () => {
  assert.equal(typeof indexedDB, "undefined");
});

await asyncTest("listRememberedFolders: resolves to [] rather than throwing when IndexedDB is unavailable", async () => {
  const result = await listRememberedFolders();
  assert.deepEqual(result, []);
});

await asyncTest("rememberFolder: resolves (doesn't throw) when IndexedDB is unavailable", async () => {
  await rememberFolder("some folder", { fake: "handle" });
});

await asyncTest("forgetFolder: resolves (doesn't throw) when IndexedDB is unavailable", async () => {
  await forgetFolder("some folder");
});

await asyncTest("forgetAllFolders: resolves (doesn't throw) when IndexedDB is unavailable", async () => {
  await forgetAllFolders();
});

console.log(`\n${passed} test(s) passed.`);

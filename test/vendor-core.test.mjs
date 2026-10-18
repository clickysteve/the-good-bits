// The vendored Slop Factory Core file is exactly what vendor.json says: a pinned commit's
// dist/engines.standalone.js, byte for byte. Update it only with scripts/vendor-core.mjs.
// Run with: node test/vendor-core.test.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

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

const dir = new URL("../js/vendor/slopfactory-core/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("vendor.json", dir), "utf8"));

test("vendor.json pins a full commit of @slopfactory/core and a semantic version", () => {
  assert.equal(manifest.package, "@slopfactory/core");
  assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test("the vendored files match their recorded SHA-256", () => {
  for (const [file, sha] of Object.entries(manifest.files)) {
    assert.equal(createHash("sha256").update(readFileSync(new URL(file, dir))).digest("hex"), sha, file);
  }
});

test("the vendored engines file is self-contained (no imports to resolve)", () => {
  const text = readFileSync(new URL("engines.js", dir), "utf8");
  assert.doesNotMatch(text, /^\s*import\b/m);
});

console.log(`\n${passed} passed`);

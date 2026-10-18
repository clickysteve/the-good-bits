// Copies Slop Factory Core's output engines into js/vendor/slopfactory-core/ at a pinned commit.
//
// The Good Bits has no bundler and no npm dependencies, so it cannot install Core as a package.
// Instead it keeps one file from Core's committed build, dist/engines.standalone.js (the engines
// module as a single ES module with no imports), plus vendor.json recording Core's version, the
// exact commit and the file's SHA-256. test/vendor-core.test.mjs fails if the file drifts.
//
//   node scripts/vendor-core.mjs <full 40-character Core commit SHA>
//
// Use a commit that is on Core's main branch (a released version), never a branch name.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "clickysteve/slopfactory-core";
const commit = process.argv[2] ?? "";
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error("usage: node scripts/vendor-core.mjs <full 40-character commit SHA of slopfactory-core>");
  process.exit(1);
}
const raw = (path) => `https://raw.githubusercontent.com/${REPO}/${commit}/${path}`;
async function get(path) {
  const res = await fetch(raw(path));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "js/vendor/slopfactory-core");
const pkg = JSON.parse((await get("package.json")).toString("utf8"));
const file = await get("dist/engines.standalone.js");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "engines.js"), file);
const manifest = {
  package: pkg.name,
  version: pkg.version,
  source: `https://github.com/${REPO}`,
  commit,
  from: "dist/engines.standalone.js",
  files: { "engines.js": createHash("sha256").update(file).digest("hex") },
  licence: pkg.license,
};
writeFileSync(join(dir, "vendor.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`vendored ${pkg.name} ${pkg.version} (${commit.slice(0, 7)})`);

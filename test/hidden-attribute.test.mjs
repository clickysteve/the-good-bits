// hidden-attribute.test.mjs
//
// A class rule that sets `display: flex` (0,1,0) outranks the browser's own
// `[hidden] { display: none }`, so an element the app hides with `el.hidden = true`
// stays on screen unless the stylesheet repeats the rule for that class. Both
// cases below shipped that way: the STRETCH "queued for export" summary showed
// with nothing queued, and LAB's drop zone stayed up after a loop was loaded.
//
// Each entry pins one element the JS hides via the attribute. The first check
// keeps the test honest (if the JS stops toggling .hidden, the entry is stale);
// the second is the actual guard.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "css", "style.css"), "utf8");

const CASES = [
  { file: "js/stretch-workspace.js", variable: "browserExportSummary", className: "stretch-character-export-summary" },
  { file: "js/lab/controller.js", variable: "dropzone", className: "lab-dropzone" },
];

for (const { file, variable, className } of CASES) {
  test(`.${className} stays hidden when ${variable}.hidden is set`, () => {
    const src = readFileSync(join(root, file), "utf8");
    assert.match(src, new RegExp(`\\b${variable}\\.hidden\\s*=`), `${file} no longer sets ${variable}.hidden - update this test`);
    assert.match(src, new RegExp(`["\`]${className}["\` ]`), `${file} no longer gives ${variable} the class ${className}`);
    assert.match(
      css,
      new RegExp(`\\.${className}\\[hidden\\][^{]*\\{\\s*display:\\s*none;?\\s*\\}`),
      `css/style.css needs .${className}[hidden] { display: none; } - its display rule otherwise overrides the hidden attribute`
    );
  });
}

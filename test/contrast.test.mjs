// contrast.test.mjs
//
// Guards the one failure that shipped three times without anyone noticing.
//
// Before this existed the app carried three parallel themes, and two of them
// rendered body text below the readable minimum: Console's panel labels sat at
// 2.55:1 and even the default Classic theme's were 3.34:1, against a WCAG AA
// floor of 4.5:1 for normal text. Nothing caught it because nothing looked.
//
// This parses the real custom properties out of css/style.css and asserts every
// text role against the surface it actually sits on. If someone re-tints the
// palette and pushes a role under the floor, the build fails here rather than
// six months later when they finally look at that screen in daylight.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "..", "css", "style.css"), "utf8");

/** Pull `--name: #hex;` declarations out of the :root block. */
function readTokens(source) {
  const root = source.match(/:root\s*\{([\s\S]*?)\n\}/);
  assert.ok(root, "css/style.css must declare a :root token block");
  const tokens = {};
  for (const [, name, value] of root[1].matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    tokens[name] = value;
  }
  return tokens;
}

/** Relative luminance, per WCAG 2.x. */
function luminance(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const [la, lb] = [luminance(a), luminance(b)];
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const AA_NORMAL = 4.5;

// Every foreground/background pairing the stylesheet actually produces. Adding a
// new text role to style.css means adding it here too.
const PAIRINGS = [
  ["--text", "--bg", "body text on the app ground"],
  ["--text", "--bg-panel", "body text on panels and cards"],
  ["--text", "--bg-raised", "input text"],
  ["--text-dim", "--bg-panel", "labels and secondary copy on panels"],
  ["--text-dim", "--bg-raised", "secondary copy on raised surfaces"],
  ["--text-faint", "--bg", "module headings on the app ground"],
  ["--text-faint", "--bg-panel", "module headings, hints, meta on panels"],
  ["--text-faint", "--bg-raised", "hints on raised surfaces"],
  ["--accent", "--bg-panel", "accent text on panels"],
  ["--accent", "--bg", "accent text on the app ground"],
  ["--accent-2", "--bg-panel", "naming preview and param values"],
  ["--good", "--bg-panel", "success status"],
  ["--warn", "--bg-panel", "warning status and skipped files"],
  ["--danger", "--bg-panel", "destructive affordances"],
  ["--on-accent", "--accent", "button label on an accent fill"],
  ["--log-text", "--log-bg", "run log"],
  ["--text-faint", "--log-bg", "faint text in the log"],
];

test("every text role clears WCAG AA (4.5:1) against its own surface", () => {
  const tokens = readTokens(css);
  const failures = [];

  for (const [fg, bg, role] of PAIRINGS) {
    assert.ok(tokens[fg], `missing token ${fg}`);
    assert.ok(tokens[bg], `missing token ${bg}`);
    const ratio = contrast(tokens[fg], tokens[bg]);
    if (ratio < AA_NORMAL) {
      failures.push(`  ${role}\n    ${fg} ${tokens[fg]} on ${bg} ${tokens[bg]} = ${ratio.toFixed(2)}:1 (needs ${AA_NORMAL}:1)`);
    }
  }

  assert.equal(failures.length, 0, `\n${failures.join("\n")}\n`);
});

test("the stylesheet defines exactly one palette", () => {
  // Three parallel themes are what let two of them rot unnoticed. If a second
  // palette block ever reappears, every pairing above has to be checked against
  // it too - so fail here and force that decision to be explicit.
  const themeBlocks = css.match(/\[data-theme[^\]]*\]\s*\{/g) || [];
  assert.equal(
    themeBlocks.length,
    0,
    `found ${themeBlocks.length} [data-theme] block(s); if you are reintroducing themes, extend PAIRINGS to cover each one`
  );
});

test("no text colour is defined only inside a media or density block", () => {
  // A colour whose only definition sits behind a conditional block renders
  // wrong in the unmatched state. Tokens must come from :root.
  const tokens = readTokens(css);
  for (const name of ["--text", "--text-dim", "--text-faint", "--accent", "--bg", "--bg-panel"]) {
    assert.ok(tokens[name], `${name} must be defined in :root, not only in a conditional block`);
  }
});

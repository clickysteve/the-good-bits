// naming-tokens.js
//
// Pure string <-> segment conversion behind the File Name Pattern token editor
// (js/naming-pattern-editor.js). No DOM here on purpose - the editor is a presentation/editing
// layer over the exact same plain string app.js has always stored in
// namingSettings.chopPattern and fed to resolveNamePattern()/buildChopFileName(); this module is
// what keeps the two directions (string -> chips for display, chips -> string for storage/export)
// in exact agreement, and it's simple enough to unit-test without a browser.
//
// Recognised tokens are exactly the three resolveNamePattern() understands - name, tag, number -
// matched case-insensitively, same as that function. Anything else in braces (typos, a stray
// literal "{foo}") is left as plain text: it was never a valid token before this editor existed,
// and turning it into one would change what gets exported.

export const NAMING_TOKENS = ["name", "tag", "number"];

const TOKEN_RE = /\{(name|tag|number)\}/gi;

/**
 * Splits a pattern string into an ordered list of segments: {type:"token", key:"name"|"tag"|"number"}
 * for a recognised placeholder (key is always lowercase, regardless of the source casing), or
 * {type:"text", value} for everything else, including any unrecognised "{...}". Adjacent text runs
 * are never split - only genuine token boundaries break a segment.
 */
export function parsePatternToSegments(pattern) {
  const segments = [];
  const str = pattern || "";
  let lastIndex = 0;
  TOKEN_RE.lastIndex = 0;
  let match;
  while ((match = TOKEN_RE.exec(str))) {
    if (match.index > lastIndex) segments.push({ type: "text", value: str.slice(lastIndex, match.index) });
    segments.push({ type: "token", key: match[1].toLowerCase() });
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (lastIndex < str.length) segments.push({ type: "text", value: str.slice(lastIndex) });
  return segments;
}

/** Inverse of parsePatternToSegments: joins segments back into the canonical pattern string. */
export function segmentsToPattern(segments) {
  return segments.map((s) => (s.type === "token" ? `{${s.key}}` : s.value)).join("");
}

/** True if `key` is one of the three tokens this editor (and resolveNamePattern) recognises. */
export function isKnownToken(key) {
  return NAMING_TOKENS.includes(String(key).toLowerCase());
}

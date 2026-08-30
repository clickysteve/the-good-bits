// tempo-override.js
//
// Pure logic behind per-source-file tempo correction - ANALYSIS PROPOSES, USER OVERRIDES. Detection
// (essentia-bridge.js) can get halved/doubled or simply wrong; this is the small, DOM-free core that
// reconciles a user's correction with the raw detected value, pulled out of app.js (which owns the
// actual per-file Map keyed by analysisKey() and wires all this to the Stretch workspace's Source
// field) so the resolution/validation rules are unit-testable without a browser - the same reason
// js/chop-regions.js and js/file-inclusion.js keep their own pure decision logic out of the DOM-wired
// file. Nothing here ever touches a detected value: analyzeKeyAndTempo()'s result is the one thing
// this module treats as immutable input, never output.

// Generous backstop against garbage input (a stray extra digit, a paste error) rather than a
// creative ceiling - stretchChannels' own ratio clamp keeps the DSP safe regardless of how far from
// a plausible tempo a corrected BPM still is, so this only exists to keep NaN/zero/negative/Infinity
// out of a stored override.
export const MAX_SOURCE_BPM = 100000;

/**
 * Validates/cleans a user-typed or half/double-derived source BPM. Returns null for anything that
 * can't become a usable tempo (NaN, non-numeric, zero, negative, Infinity) - the caller should treat
 * null as "reject this input, don't store it, leave the existing state alone".
 */
export function sanitizeSourceBpm(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_SOURCE_BPM, n);
}

/**
 * The single answer to "what tempo should this source be treated as?" - every musical operation
 * (stretch ratio, bar-based chop length, the {tempo} naming token) should resolve through this
 * rather than reading detected tempo directly; only analysis/debug/display code that specifically
 * wants the raw detected value should bypass it.
 * @param {number|null|undefined} override - a manual correction, or null/undefined if none exists
 * @param {number|null|undefined} detectedBpm - the raw value analyzeKeyAndTempo() produced
 * @returns {number|null} override if present, else detectedBpm, else null
 */
export function resolveEffectiveTempo(override, detectedBpm) {
  if (override != null) return override;
  return detectedBpm || null;
}

/** "140 BPM (manual)" / "120 BPM" / "unclear" / "unavailable" - the one place an effective tempo and
 * its detected/manual provenance become the string shown in logs and result cards. */
export function formatBpmText(bpm, isManual, available) {
  if (bpm) return `${Math.round(bpm)} BPM${isManual ? " (manual)" : ""}`;
  return available ? "unclear" : "unavailable";
}

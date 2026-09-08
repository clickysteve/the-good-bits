// local-storage.js
//
// Small, safe wrapper around this browser's localStorage - every read/write in the app funnels
// through here rather than each call site repeating its own try/catch. Every function is
// best-effort: private browsing, storage disabled, or quota exceeded should never throw into the
// caller, only degrade to "nothing was remembered" (readJSON/readString return null, writeJSON/
// writeString silently no-op).

/** Reads and JSON-parses a stored value, or null if missing/unavailable/corrupt. */
export function readJSON(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/** JSON-serializes and stores a value under `key`. */
export function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    /* best-effort only - private browsing, storage disabled, quota, etc. */
  }
}

/** Reads a stored plain string, or null if missing/unavailable. */
export function readString(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

/** Stores a plain string under `key`. */
export function writeString(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {
    /* best-effort only - private browsing, storage disabled, quota, etc. */
  }
}

// file-inclusion.js
//
// Pure helpers behind "which imported files actually participate in Process/Export" - the
// per-source-file include/exclude checkboxes in the folder/file picker, as distinct from which chop
// REGION is selected within a file (a completely different axis - see js/chop-regions.js for that).
//
// A file descriptor here is whatever shape app.js/io-fs.js already use ({relativeDir, name, ext,
// fsaHandle|legacyFile, ...}); this module only ever reads/writes its `included` field, so it works
// unchanged for every source path (FSA folder, legacy webkitdirectory, drag-and-drop, individually
// picked files).

/** Every valid file starts included - `included` missing entirely (a freshly-discovered file) counts
 * as included, same as `included: true`; only an explicit `false` counts as excluded. */
export function isIncluded(fileInfo) {
  return !!fileInfo && fileInfo.included !== false;
}

/** Stamps `included: true` onto every file in a freshly-discovered list, without disturbing a file
 * that already has an explicit inclusion state (e.g. re-normalising a list that was already touched). */
export function normalizeIncludedFiles(files) {
  return files.map((f) => (typeof f.included === "boolean" ? f : { ...f, included: true }));
}

/** The files eligible for Process/Export/preview out of `files` - i.e. every included one. */
export function includedFiles(files) {
  return files.filter(isIncluded);
}

/** Sets every file's inclusion flag in place (used by Select All / Deselect All). Mutates the
 * existing descriptors rather than replacing them, since other code (editContext, analysisCache
 * keys) may hold direct references to these same objects. */
export function setAllIncluded(files, included) {
  for (const f of files) f.included = included;
}

/** True if none of `folders` (each `{files}`) has a single included file left - the "zero included
 * files" state Process/Export must handle safely rather than throwing. */
export function noFilesIncluded(folders) {
  return !folders.some((folder) => folder.files.some(isIncluded));
}

/**
 * What the "active" pointer (e.g. the STRETCH workspace's current file) should become once the
 * underlying list is filtered down to included-only items. Keeps the current active item if it's
 * still there; otherwise falls back to the first included item, or null if none remain.
 * @param {Array} includedItems - already-filtered list (see includedFiles)
 * @param {*} currentKey
 * @param {(item:*) => *} keyOf
 */
export function resolveActiveKey(includedItems, currentKey, keyOf) {
  if (includedItems.some((item) => keyOf(item) === currentKey)) return currentKey;
  return includedItems.length ? keyOf(includedItems[0]) : null;
}

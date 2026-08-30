// file-inclusion.js
//
// Pure helpers behind two DIFFERENT per-source-file flags, deliberately kept separate:
//
//   `included`       - "is this file part of the current job at all". Set via the folder/file
//                       picker's checkboxes, BEFORE Process ever runs. A file with this off is never
//                       decoded, analyzed, rendered, or given a results card - processBatch() skips
//                       it outright (see isIncluded()'s call site in app.js's per-file loop).
//
//   `exportIncluded`  - "does this already-processed file's card get to write anything to disk". Set
//                       via the "Include in export" toggle on the per-file results card, AFTER
//                       Process has already run. A file with this off still decodes, analyzes,
//                       renders its waveform/chops, and stays fully editable/auditionable - only the
//                       actual export writes (js/app.js's writeOutput(), the single choke point every
//                       output kind passes through) are skipped for it.
//
// These are intentionally not the same flag: turning "Include in export" off must never stop a file
// from being processed/edited/auditioned (Process and Export are separate decisions), and turning
// `included` off must never leave a half-processed, half-visible card around. Overloading one flag
// for both would break one or the other.
//
// Both are otherwise structurally identical (missing/undefined counts as on; only an explicit
// `false` counts as off), so this module exposes the same small set of operations for each rather
// than duplicating the logic under two names.
//
// A file descriptor here is whatever shape app.js/io-fs.js already use ({relativeDir, name, ext,
// fsaHandle|legacyFile, ...}); this module only ever reads/writes the `included`/`exportIncluded`
// fields, so it works unchanged for every source path (FSA folder, legacy webkitdirectory,
// drag-and-drop, individually picked files) and is independent of nested path identity - two files
// with the same basename in different folders are different descriptor objects with their own
// independent flags.

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

// ---------------------------------------------------------------------------
// Export inclusion ("Include in export") - see the module doc comment above for how this differs
// from `included`/isIncluded() above. Same shape, same defaults-to-on rule, deliberately a separate
// field so the two decisions (part of the job vs. gets written on export) can't collide.
// ---------------------------------------------------------------------------

/** Every valid file starts included in export - `exportIncluded` missing entirely (a freshly
 * processed file, or one from before this flag existed) counts as included, same as
 * `exportIncluded: true`; only an explicit `false` (the per-file card's toggle switched off) counts
 * as excluded from export. */
export function isExportIncluded(fileInfo) {
  return !!fileInfo && fileInfo.exportIncluded !== false;
}

/** Stamps `exportIncluded: true` onto every file in a freshly-discovered list, without disturbing a
 * file that already has an explicit export-inclusion state. Called alongside normalizeIncludedFiles()
 * at the same single entry point (app.js's pushSourceFolder()), so every newly imported source -
 * including every file discovered by a recursive folder import - starts with export ON regardless of
 * which import path (FSA folder, legacy webkitdirectory, drag-and-drop, individually picked files, a
 * remembered-folder reconnect) brought it in. */
export function normalizeExportIncludedFiles(files) {
  return files.map((f) => (typeof f.exportIncluded === "boolean" ? f : { ...f, exportIncluded: true }));
}

/** The files that should actually produce export output out of `files` - i.e. every file that is
 * BOTH part of the job (isIncluded) AND still marked for export (isExportIncluded). A job-excluded
 * file is never processed at all, so it can't be "exportable" regardless of its own export flag. */
export function exportableFiles(files) {
  return files.filter((f) => isIncluded(f) && isExportIncluded(f));
}

/** Sets every file's export-inclusion flag in place (the per-file-list "Include all"/"Exclude all"
 * bulk controls). Mutates the existing descriptors, same reasoning as setAllIncluded() above - other
 * code may hold direct references to these same objects (editContext, analysisCache keys). Never
 * touches `included`, so a bulk export toggle can't accidentally pull a file out of the job (or back
 * into one it was deliberately removed from) and vice versa. */
export function setAllExportIncluded(files, exportIncluded) {
  for (const f of files) f.exportIncluded = exportIncluded;
}

/** True if none of `folders` (each `{files}`) has a single exportable file left - the "zero
 * exportable files" state the Export action must handle safely (a clear message, never an empty
 * ZIP/empty folders/a silent "success") rather than just running the batch anyway. */
export function noFilesExportIncluded(folders) {
  return !folders.some((folder) => exportableFiles(folder.files).length > 0);
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

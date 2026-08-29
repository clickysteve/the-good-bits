// folder-store.js
//
// Persists FileSystemDirectoryHandle objects (File System Access API) across page reloads via
// IndexedDB, so a queued source folder can be reconnected next session with one click instead of
// being re-added from scratch every time. Chrome/Edge only - Safari and Firefox don't support the
// File System Access API at all, so callers should gate all of this behind
// supportsFileSystemAccess() from io-fs.js. Browsers don't persist the *permission* itself across
// reloads (that's a deliberate security boundary), only the handle - so a remembered folder still
// needs a user-gesture click to re-grant read/write access each session; this module only saves
// the "find and pick the folder again" step.
//
// Every function here is best-effort: IndexedDB can be unavailable (private browsing in some
// browsers, storage disabled) or a stored handle can go stale (the folder was moved/deleted), and
// none of that should ever break the rest of the app - failures are swallowed and callers get an
// empty/no-op result instead of a thrown error.

const DB_NAME = "good-bits-folders";
const DB_VERSION = 1;
const STORE_NAME = "folders";

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "name" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("failed to open IndexedDB"));
  });
}

/** Runs one write op against the object store and resolves once the transaction commits. */
function runTx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    run(tx.objectStore(STORE_NAME));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Remembers a folder handle by name (overwrites any existing entry with the same name). */
export async function rememberFolder(name, handle) {
  try {
    const db = await openDb();
    await runTx(db, "readwrite", (store) => store.put({ name, handle }));
    db.close();
  } catch (_) {
    /* best-effort only */
  }
}

/** Returns all remembered {name, handle} entries, or [] if IndexedDB isn't available/empty. */
export async function listRememberedFolders() {
  try {
    const db = await openDb();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  } catch (_) {
    return [];
  }
}

/** Stops remembering a folder by name. */
export async function forgetFolder(name) {
  try {
    const db = await openDb();
    await runTx(db, "readwrite", (store) => store.delete(name));
    db.close();
  } catch (_) {
    /* best-effort only */
  }
}

/** Stops remembering every folder. */
export async function forgetAllFolders() {
  try {
    const db = await openDb();
    await runTx(db, "readwrite", (store) => store.clear());
    db.close();
  } catch (_) {
    /* best-effort only */
  }
}

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
//
// Keyed by folder name, but a name is NOT a unique identity - browsers expose no filesystem path to
// this app at all (see io-fs.js's formatSourcePath), so two entirely different folders can
// legitimately share the same display name (two projects each with a "Drums" subfolder, say).
// Records therefore hold a *list* of handles per name rather than one, so remembering a
// same-named-but-different folder can't silently clobber (overwrite, or accidentally forget) one
// already remembered - see normalizeHandles()/sameEntry() below, which also read the older
// single-`handle`-per-name shape this store used before, so existing users' already-remembered
// folders keep working with no migration step.

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

function getRecord(db, name) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(name);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** A record's handle list, reading either this store's current shape ({name, handles: [...]}) or
 * the single-handle shape it used before ({name, handle}) - so a folder remembered by an older
 * version of this module still comes back correctly rather than being silently dropped. */
function normalizeHandles(record) {
  if (!record) return [];
  if (Array.isArray(record.handles)) return record.handles;
  return record.handle ? [record.handle] : [];
}

/** Whether two FileSystemDirectoryHandles reference the same underlying folder. Swallows the error
 * isSameEntry() can throw for a handle that's gone stale, treating that as "not the same folder"
 * rather than letting it break the remember/forget call around it. */
async function sameEntry(a, b) {
  try {
    return await a.isSameEntry(b);
  } catch (_) {
    return false;
  }
}

/** Remembers a folder handle by name. If a handle for the same underlying folder (isSameEntry) is
 * already remembered under this name, its stored entry is just refreshed in place; otherwise it's
 * added alongside whatever else is already remembered under this name rather than overwriting it -
 * see the module doc comment above for why two remembered entries can share a name. */
export async function rememberFolder(name, handle) {
  try {
    const db = await openDb();
    const existing = normalizeHandles(await getRecord(db, name));
    let matched = false;
    for (let i = 0; i < existing.length; i++) {
      if (await sameEntry(existing[i], handle)) {
        existing[i] = handle;
        matched = true;
        break;
      }
    }
    const handles = matched ? existing : [...existing, handle];
    await runTx(db, "readwrite", (store) => store.put({ name, handles }));
    db.close();
  } catch (_) {
    /* best-effort only */
  }
}

/** Returns every remembered {name, handle} entry (one per handle, so a name shared by more than one
 * remembered folder yields more than one entry), or [] if IndexedDB isn't available/empty. */
export async function listRememberedFolders() {
  try {
    const db = await openDb();
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    const out = [];
    for (const record of records) {
      for (const handle of normalizeHandles(record)) out.push({ name: record.name, handle });
    }
    return out;
  } catch (_) {
    return [];
  }
}

/**
 * Stops remembering a folder by name. With `handle` given, only the entry for that specific
 * underlying folder (isSameEntry) is dropped, leaving any other differently-located folder that
 * happens to share this display name untouched; without it, every entry under this name is
 * forgotten (used when there's no handle left to distinguish by, e.g. clearing everything).
 */
export async function forgetFolder(name, handle) {
  try {
    const db = await openDb();
    if (handle) {
      const existing = normalizeHandles(await getRecord(db, name));
      const remaining = [];
      for (const h of existing) {
        if (!(await sameEntry(h, handle))) remaining.push(h);
      }
      if (remaining.length > 0 && remaining.length < existing.length) {
        await runTx(db, "readwrite", (store) => store.put({ name, handles: remaining }));
        db.close();
        return;
      }
      if (remaining.length === existing.length) {
        // handle didn't match anything under this name - nothing to remove.
        db.close();
        return;
      }
    }
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

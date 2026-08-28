// io-fs.js
//
// Folder selection, recursive audio discovery, and output writing.
// Two paths, feature-detected at runtime:
//
//   - File System Access API (Chrome/Edge): folders are opened read-write,
//     so wav/ and chops/ get written straight back into the source folder,
//     exactly like the old macOS app did.
//   - Fallback (Safari/Firefox, or any browser without that API): folders
//     are read via a hidden <input type="file" webkitdirectory> element,
//     and the whole batch's output is assembled into one ZIP for download,
//     mirroring the same folder structure inside it.
//
// "Add Folder" can be clicked repeatedly to build up a multi-folder batch,
// the same way Cmd/Shift-click built a multi-folder selection in the old
// native folder picker.

export const AUDIO_EXTS = new Set([".wav", ".m4a", ".aif", ".aiff", ".flac", ".mp3"]);

export function supportsFileSystemAccess() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

function isExcludedSegment(name) {
  const n = name.toLowerCase();
  return n === "wav" || n === "chops";
}

// ---------------------------------------------------------------------------
// File System Access API path
// ---------------------------------------------------------------------------

/** Opens the native folder picker. Returns null if the user cancels. */
export async function pickFolderFSA() {
  try {
    return await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (err) {
    if (err && err.name === "AbortError") return null;
    throw err;
  }
}

export async function ensureReadWritePermission(dirHandle) {
  const opts = { mode: "readwrite" };
  if ((await dirHandle.queryPermission(opts)) === "granted") return true;
  return (await dirHandle.requestPermission(opts)) === "granted";
}

/** Recursively collect audio files under a FileSystemDirectoryHandle, skipping wav/ and chops/. */
export async function collectAudioFilesFSA(dirHandle, relPrefix = "") {
  const out = [];
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "directory") {
      if (isExcludedSegment(name)) continue;
      const nested = await collectAudioFilesFSA(handle, relPrefix ? `${relPrefix}/${name}` : name);
      out.push(...nested);
    } else if (handle.kind === "file") {
      const ext = extOf(name);
      if (AUDIO_EXTS.has(ext)) {
        out.push({ relativeDir: relPrefix, name, ext, fsaHandle: handle });
      }
    }
  }
  out.sort((a, b) => (a.relativeDir + "/" + a.name).localeCompare(b.relativeDir + "/" + b.name));
  return out;
}

async function getNestedDirHandle(rootHandle, relDir, create) {
  if (!relDir) return rootHandle;
  let cur = rootHandle;
  for (const part of relDir.split("/").filter(Boolean)) {
    cur = await cur.getDirectoryHandle(part, { create });
  }
  return cur;
}

/** Write a Blob to sourceDirHandle/subdirName/relDir/fileName (creating folders as needed). */
export async function writeFileFSA(sourceDirHandle, subdirName, relDir, fileName, blob) {
  const subdir = await sourceDirHandle.getDirectoryHandle(subdirName, { create: true });
  const targetDir = await getNestedDirHandle(subdir, relDir, true);
  const fileHandle = await targetDir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/** Delete any previously-generated NN.wav files in a chops destination directory (idempotent re-runs). */
export async function clearOldChopsFSA(sourceDirHandle, relDir, stem) {
  try {
    const chopsRoot = await sourceDirHandle.getDirectoryHandle("chops", { create: true });
    const destDir = await getNestedDirHandle(chopsRoot, relDir ? `${relDir}/${stem}` : stem, true);
    for await (const [name, handle] of destDir.entries()) {
      if (handle.kind === "file" && /^\d+\.wav$/i.test(name)) {
        try {
          await destDir.removeEntry(name);
        } catch (_) {
          /* ignore */
        }
      }
    }
  } catch (_) {
    /* destination didn't exist yet - nothing to clear */
  }
}

// ---------------------------------------------------------------------------
// Legacy <input webkitdirectory> path
// ---------------------------------------------------------------------------

/**
 * Build a source-folder descriptor from a FileList produced by
 * <input type="file" webkitdirectory>. All files share a common top-level
 * folder name in their webkitRelativePath.
 */
export function collectAudioFilesLegacy(fileList) {
  const files = Array.from(fileList);
  if (files.length === 0) return null;
  const firstParts = files[0].webkitRelativePath.split("/");
  const rootName = firstParts[0];

  const out = [];
  for (const file of files) {
    const parts = file.webkitRelativePath.split("/").slice(1); // drop root folder name
    if (parts.length === 0) continue;
    const name = parts[parts.length - 1];
    const relativeDir = parts.slice(0, -1).join("/");
    if (parts.slice(0, -1).some(isExcludedSegment)) continue;
    const ext = extOf(name);
    if (!AUDIO_EXTS.has(ext)) continue;
    out.push({ relativeDir, name, ext, legacyFile: file });
  }
  out.sort((a, b) => (a.relativeDir + "/" + a.name).localeCompare(b.relativeDir + "/" + b.name));
  return { rootName, files: out };
}

// ---------------------------------------------------------------------------
// ZIP export (fallback output path)
// ---------------------------------------------------------------------------

/**
 * Accumulates output blobs across an entire batch and produces one ZIP,
 * mirroring "<Source Folder>/wav/..." and "<Source Folder>/chops/..." for
 * every queued folder, just like a direct-write run would leave on disk.
 */
export class ZipBatch {
  constructor() {
    this.zip = new window.JSZip();
  }
  addFile(sourceFolderName, subdirName, relDir, fileName, blob) {
    const parts = [sourceFolderName, subdirName, ...(relDir ? relDir.split("/") : [])];
    let folder = this.zip;
    for (const p of parts) folder = folder.folder(p);
    folder.file(fileName, blob);
  }
  async downloadAs(filename) {
    const blob = await this.zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}

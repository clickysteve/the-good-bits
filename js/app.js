import { phraseRegions, drumRegions, toMono, findNearestZeroCrossing, applyFades, sanitizeForPath, buildKeyTempoTag } from "./dsp.js";
import { encodeWav, parseWav, parseAiff } from "./audio-codec.js";
import { analyzeKeyAndTempo, essentiaAvailable } from "./essentia-bridge.js";
import {
  AUDIO_EXTS,
  supportsFileSystemAccess,
  supportsFilePickerFSA,
  pickFolderFSA,
  pickFilesFSA,
  ensureReadWritePermission,
  collectAudioFilesFSA,
  discoverImmediateSourceChildren,
  collectAudioFilesLegacy,
  collectIndividualFilesLegacy,
  writeFileFSA,
  clearOldChopsFSA,
  ZipBatch,
} from "./io-fs.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mode = "phrases"; // 'phrases' | 'rhodes' | 'drums'
let processing = false;
let nextFolderId = 1;
let looseFileGroupCounter = 0;
let looseDestinationHandle = null; // cached FSA destination for individually-picked files
const sourceFolders = []; // {id, name, kind:'fsa'|'legacy', handle?, isLoose?, files:[...]}

const FSA_SUPPORTED = supportsFileSystemAccess();
const FSA_FILE_PICKER_SUPPORTED = supportsFilePickerFSA();

const params = {
  phrases: { silenceMarginDb: 18, minSilenceDuration: 0.32, mergeGap: 0.2, minLen: 0.8, maxLen: 18.0, preferred: 11.0, pad: 0.12 },
  rhodes: { silenceMarginDb: 10, minSilenceDuration: 0.5, mergeGap: 0.55, minLen: 1.8, maxLen: 20.0, preferred: 13.0, pad: 0.18 },
  drums: { preferred: 8.0, maxLen: 16.0, minLen: 3.0, onsetSensitivity: 0.65, snapToTempo: true, barsPerChop: "auto" },
};
const DEFAULT_PARAMS = JSON.parse(JSON.stringify(params));
let autoParams = true; // when true, always use DEFAULT_PARAMS regardless of any manual edits below

const exportSettings = { bitDepth: 24, fadeMs: 5, zcSearchMs: 15 };
const detectSettings = { key: true, tempo: true };

const PARAM_SCHEMAS = {
  phrases: [
    { key: "silenceMarginDb", label: "Silence sensitivity (above noise floor)", min: 6, max: 30, step: 1, unit: "dB" },
    { key: "minSilenceDuration", label: "Minimum gap to count as silence", min: 0.1, max: 1.0, step: 0.02, unit: "s" },
    { key: "mergeGap", label: "Bridge gaps shorter than", min: 0.05, max: 1.0, step: 0.02, unit: "s" },
    { key: "minLen", label: "Minimum phrase length", min: 0.2, max: 3.0, step: 0.1, unit: "s" },
    { key: "preferred", label: "Preferred phrase length", min: 5, max: 20, step: 0.5, unit: "s" },
    { key: "maxLen", label: "Maximum phrase length", min: 5, max: 25, step: 0.5, unit: "s" },
    { key: "pad", label: "Padding around each phrase", min: 0, max: 0.5, step: 0.02, unit: "s" },
  ],
  rhodes: [
    { key: "silenceMarginDb", label: "Silence sensitivity (above noise floor)", min: 4, max: 24, step: 1, unit: "dB" },
    { key: "minSilenceDuration", label: "Minimum gap to count as silence", min: 0.2, max: 1.5, step: 0.02, unit: "s" },
    { key: "mergeGap", label: "Bridge gaps shorter than", min: 0.1, max: 1.5, step: 0.02, unit: "s" },
    { key: "minLen", label: "Minimum phrase length", min: 0.5, max: 4.0, step: 0.1, unit: "s" },
    { key: "preferred", label: "Preferred phrase length", min: 8, max: 25, step: 0.5, unit: "s" },
    { key: "maxLen", label: "Maximum phrase length", min: 8, max: 30, step: 0.5, unit: "s" },
    { key: "pad", label: "Padding around each phrase", min: 0, max: 0.5, step: 0.02, unit: "s" },
  ],
  drums: [
    { key: "preferred", label: "Preferred break length", min: 3, max: 15, step: 0.5, unit: "s" },
    { key: "minLen", label: "Minimum break length", min: 1, max: 8, step: 0.5, unit: "s" },
    { key: "maxLen", label: "Maximum break length", min: 6, max: 24, step: 0.5, unit: "s" },
    { key: "onsetSensitivity", label: "Onset sensitivity", min: 0.3, max: 1.0, step: 0.05, unit: "x" },
  ],
};

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

/** The parameter set actually used for processing: defaults while Auto is on, live-edited values otherwise. */
function activeParams() {
  return autoParams ? DEFAULT_PARAMS : params;
}

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const modeCards = document.querySelectorAll(".mode-card");
const autoParamsCheckbox = $("#auto-params-checkbox");
const paramsPanel = $("#params-panel");
const folderList = $("#folder-list");
const addFolderBtn = $("#add-folder-btn");
const addFilesBtn = $("#add-files-btn");
const splitSubfoldersCheckbox = $("#split-subfolders-checkbox");
const clearFoldersBtn = $("#clear-folders-btn");
const legacyFolderInput = $("#legacy-folder-input");
const legacyFilesInput = $("#legacy-files-input");
const processBtn = $("#process-btn");
const outputBanner = $("#output-banner");
const logPanel = $("#log-panel");
const resultsPanel = $("#results-panel");
const bitDepthSelect = $("#bit-depth-select");
const fadeMsSlider = $("#fade-ms-slider");
const zcMsSlider = $("#zc-ms-slider");
const detectKeyCheckbox = $("#detect-key-checkbox");
const detectTempoCheckbox = $("#detect-tempo-checkbox");
const essentiaStatus = $("#essentia-status");

// ---------------------------------------------------------------------------
// Logging / progress
// ---------------------------------------------------------------------------

function log(line) {
  const el = document.createElement("div");
  el.className = "log-line";
  el.textContent = line;
  logPanel.appendChild(el);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function clearLog() {
  logPanel.innerHTML = "";
}

// ---------------------------------------------------------------------------
// Mode + params UI
// ---------------------------------------------------------------------------

function renderParamsPanel() {
  paramsPanel.innerHTML = "";

  if (autoParams) {
    const note = document.createElement("p");
    note.className = "params-auto-note";
    note.textContent =
      "Using recommended settings for this mode. Uncheck “Auto” above to fine-tune silence sensitivity, phrase length, and other parameters by hand.";
    paramsPanel.appendChild(note);
    return;
  }

  const schema = PARAM_SCHEMAS[mode];
  const grid = document.createElement("div");
  grid.className = "params-grid";

  for (const field of schema) {
    const row = document.createElement("div");
    row.className = "param-row";

    const labelEl = document.createElement("label");
    labelEl.textContent = field.label;

    const valueEl = document.createElement("span");
    valueEl.className = "param-value";
    const current = params[mode][field.key];
    valueEl.textContent = `${current}${field.unit}`;

    const input = document.createElement("input");
    input.type = "range";
    input.min = field.min;
    input.max = field.max;
    input.step = field.step;
    input.value = current;
    input.addEventListener("input", () => {
      params[mode][field.key] = parseFloat(input.value);
      valueEl.textContent = `${input.value}${field.unit}`;
    });

    const top = document.createElement("div");
    top.className = "param-top";
    top.appendChild(labelEl);
    top.appendChild(valueEl);

    row.appendChild(top);
    row.appendChild(input);
    grid.appendChild(row);
  }

  paramsPanel.appendChild(grid);

  if (mode === "drums") {
    const snapRow = document.createElement("div");
    snapRow.className = "param-row param-row--checkbox";
    const snapLabel = document.createElement("label");
    const snapCheckbox = document.createElement("input");
    snapCheckbox.type = "checkbox";
    snapCheckbox.checked = params.drums.snapToTempo;
    snapCheckbox.addEventListener("change", () => {
      params.drums.snapToTempo = snapCheckbox.checked;
    });
    snapLabel.appendChild(snapCheckbox);
    snapLabel.append(" Snap chop boundaries to the detected tempo grid (for seamless loops)");
    snapRow.appendChild(snapLabel);
    paramsPanel.appendChild(snapRow);
  }

  const resetBtn = document.createElement("button");
  resetBtn.className = "btn btn--ghost";
  resetBtn.textContent = "Reset to defaults";
  resetBtn.addEventListener("click", () => {
    params[mode] = JSON.parse(JSON.stringify(DEFAULT_PARAMS[mode]));
    renderParamsPanel();
  });
  paramsPanel.appendChild(resetBtn);
}

modeCards.forEach((card) => {
  card.addEventListener("click", () => {
    mode = card.dataset.mode;
    modeCards.forEach((c) => c.classList.toggle("mode-card--active", c === card));
    renderParamsPanel();
  });
});

autoParamsCheckbox.addEventListener("change", () => {
  autoParams = autoParamsCheckbox.checked;
  renderParamsPanel();
});

// ---------------------------------------------------------------------------
// Folder queue UI
// ---------------------------------------------------------------------------

function renderFolderList() {
  folderList.innerHTML = "";
  if (sourceFolders.length === 0) {
    const empty = document.createElement("div");
    empty.className = "folder-list-empty";
    empty.textContent = "Nothing added yet.";
    folderList.appendChild(empty);
  }
  for (const folder of sourceFolders) {
    const row = document.createElement("div");
    row.className = "folder-row";

    const info = document.createElement("div");
    info.className = "folder-row-info";
    const nameEl = document.createElement("div");
    nameEl.className = "folder-row-name";
    nameEl.textContent = folder.name;
    const countEl = document.createElement("div");
    countEl.className = "folder-row-count";
    countEl.textContent = folder.isLoose
      ? `${folder.files.length} file(s) — output goes to ${folder.destinationLabel || "a chosen folder"}`
      : `${folder.files.length} audio file(s) found`;
    info.appendChild(nameEl);
    info.appendChild(countEl);

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn btn--icon";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove";
    removeBtn.addEventListener("click", () => {
      const idx = sourceFolders.indexOf(folder);
      if (idx >= 0) sourceFolders.splice(idx, 1);
      renderFolderList();
      updateProcessButton();
    });

    row.appendChild(info);
    row.appendChild(removeBtn);
    folderList.appendChild(row);
  }
}

function updateProcessButton() {
  processBtn.disabled = processing || sourceFolders.length === 0;
}

function folderAlreadyQueued(name) {
  return sourceFolders.some((f) => f.kind === "fsa" && !f.isLoose && f.name === name);
}

async function addFolderFSA() {
  const handle = await pickFolderFSA();
  if (!handle) return;

  if (splitSubfoldersCheckbox.checked) {
    const children = await discoverImmediateSourceChildren(handle);
    if (children.length > 0) {
      let added = 0;
      for (const child of children) {
        if (folderAlreadyQueued(child.name)) continue;
        const files = await collectAudioFilesFSA(child.handle);
        sourceFolders.push({ id: nextFolderId++, name: child.name, kind: "fsa", handle: child.handle, files });
        added++;
      }
      log(`Added ${added} subfolder(s) from "${handle.name}" as separate sources.`);
      renderFolderList();
      updateProcessButton();
      return;
    }
    // No qualifying subfolders — fall through and treat the picked folder itself as one source.
  }

  if (folderAlreadyQueued(handle.name)) {
    log(`"${handle.name}" is already in the queue.`);
    return;
  }
  const files = await collectAudioFilesFSA(handle);
  sourceFolders.push({ id: nextFolderId++, name: handle.name, kind: "fsa", handle, files });
  renderFolderList();
  updateProcessButton();
}

function addFolderLegacy() {
  legacyFolderInput.value = "";
  legacyFolderInput.click();
}

legacyFolderInput.addEventListener("change", () => {
  const groups = collectAudioFilesLegacy(legacyFolderInput.files, { splitSubfolders: splitSubfoldersCheckbox.checked });
  for (const g of groups) {
    sourceFolders.push({ id: nextFolderId++, name: g.rootName, kind: "legacy", files: g.files });
  }
  renderFolderList();
  updateProcessButton();
});

async function addIndividualFilesFSA() {
  const handles = await pickFilesFSA();
  if (handles.length === 0) return;

  if (!looseDestinationHandle) {
    log("Choose a folder for the wav/ and chops/ output of these files…");
    looseDestinationHandle = await pickFolderFSA();
    if (!looseDestinationHandle) return;
  }
  const ok = await ensureReadWritePermission(looseDestinationHandle);
  if (!ok) {
    log("Permission to write to the chosen output folder was denied.");
    looseDestinationHandle = null;
    return;
  }

  looseFileGroupCounter++;
  const files = handles.map((h) => ({ relativeDir: "", name: h.name, ext: extOf(h.name), fsaHandle: h }));
  sourceFolders.push({
    id: nextFolderId++,
    name: `Individual files ${looseFileGroupCounter}`,
    kind: "fsa",
    handle: looseDestinationHandle,
    isLoose: true,
    destinationLabel: looseDestinationHandle.name,
    files,
  });
  renderFolderList();
  updateProcessButton();
}

function addIndividualFilesLegacy() {
  legacyFilesInput.value = "";
  legacyFilesInput.click();
}

legacyFilesInput.addEventListener("change", () => {
  if (legacyFilesInput.files.length === 0) return;
  looseFileGroupCounter++;
  const group = collectIndividualFilesLegacy(legacyFilesInput.files, `Individual files ${looseFileGroupCounter}`);
  sourceFolders.push({ id: nextFolderId++, name: group.rootName, kind: "legacy", isLoose: true, files: group.files });
  renderFolderList();
  updateProcessButton();
});

addFolderBtn.addEventListener("click", async () => {
  try {
    if (FSA_SUPPORTED) await addFolderFSA();
    else addFolderLegacy();
  } catch (err) {
    log(`Could not open the folder picker: ${err.message || err}`);
    console.error(err);
  }
});

addFilesBtn.addEventListener("click", async () => {
  try {
    if (FSA_SUPPORTED && FSA_FILE_PICKER_SUPPORTED) await addIndividualFilesFSA();
    else addIndividualFilesLegacy();
  } catch (err) {
    log(`Could not open the file picker: ${err.message || err}`);
    console.error(err);
  }
});

clearFoldersBtn.addEventListener("click", () => {
  sourceFolders.length = 0;
  looseDestinationHandle = null;
  renderFolderList();
  updateProcessButton();
});

// ---------------------------------------------------------------------------
// Audio decoding
// ---------------------------------------------------------------------------

let sharedAudioCtx = null;
function getAudioContext() {
  if (!sharedAudioCtx) sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return sharedAudioCtx;
}

/** Returns {buffer, method}. Throws with a clear message if nothing could decode it. */
async function decodeFile(file, ext) {
  const arrayBuffer = await file.arrayBuffer();

  if (ext === ".wav") {
    return { buffer: parseWav(arrayBuffer), method: "wav-parser" };
  }
  if (ext === ".aif" || ext === ".aiff") {
    try {
      return { buffer: parseAiff(arrayBuffer), method: "aiff-parser" };
    } catch (err) {
      // fall through to native decode as a last resort for unusual AIFF variants
    }
  }

  try {
    const ac = getAudioContext();
    const audioBuffer = await ac.decodeAudioData(arrayBuffer.slice(0));
    return { buffer: audioBuffer, method: "native-decode" };
  } catch (err) {
    throw new Error(`this browser could not decode "${file.name}" (${ext}): ${err.message || err}`);
  }
}

// ---------------------------------------------------------------------------
// Per-file processing
// ---------------------------------------------------------------------------

function bufferChannels(buffer) {
  return Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
}

function sliceChannels(channels, startSample, endSample) {
  return channels.map((ch) => ch.slice(startSample, endSample));
}

function chopFileName(index) {
  return `${String(index).padStart(2, "0")}.wav`;
}

async function writeOutput(folder, subdir, relDir, fileName, blob, zipBatch) {
  if (folder.kind === "fsa") {
    await writeFileFSA(folder.handle, subdir, relDir, fileName, blob);
  } else {
    zipBatch.addFile(folder.name, subdir, relDir, fileName, blob);
  }
}

/** Processes one source audio file: decode, analyze, export chops. Returns the number of chops made. */
async function processOneFile(folder, fileInfo, zipBatch, folderResultsEl) {
  const file = fileInfo.fsaHandle ? await fileInfo.fsaHandle.getFile() : fileInfo.legacyFile;
  const stem = fileInfo.name.replace(/\.[^.]+$/, "");

  log(`  ${fileInfo.name}`);
  const { buffer, method } = await decodeFile(file, fileInfo.ext);
  const channels = bufferChannels(buffer);
  const mono = toMono(channels);

  // Key/tempo are detected once per source file, so every chop from this file
  // shares the same tag. That's why the tag goes on the containing folder
  // (and the wav/ copy's filename) rather than being repeated on every
  // numbered chop.
  const wantKey = detectSettings.key;
  const wantTempo = detectSettings.tempo;
  const kt = await analyzeKeyAndTempo(mono, buffer.sampleRate, { key: wantKey, tempo: wantTempo });
  const tag = buildKeyTempoTag(kt);
  const taggedStem = sanitizeForPath(stem + tag);

  // Non-WAV sources get a full 24-bit WAV copy in wav/; true WAV sources are
  // analyzed and chopped in place, with nothing duplicated into wav/.
  if (fileInfo.ext !== ".wav") {
    const wavBlob = encodeWav(channels, buffer.sampleRate, 24);
    await writeOutput(folder, "wav", fileInfo.relativeDir, `${taggedStem}.wav`, wavBlob, zipBatch);
    log(`    converted to WAV (${method})`);
  }

  const modeParams = activeParams();
  let regions;
  if (mode === "drums") {
    const bpm = modeParams.drums.snapToTempo ? kt.bpm : null;
    regions = drumRegions(mono, buffer.sampleRate, modeParams.drums, bpm).regions;
  } else {
    regions = phraseRegions(mono, buffer.sampleRate, modeParams[mode]).regions;
  }

  const keyText = kt.key ? `${kt.key} ${kt.scale || ""}`.trim() : kt.available ? "unknown" : "unavailable";
  const bpmText = kt.bpm ? `${Math.round(kt.bpm)} BPM` : kt.available ? "unclear" : "unavailable";
  log(`    key: ${keyText} | tempo: ${bpmText} | ${regions.length} candidate phrase(s)`);

  if (folder.kind === "fsa") {
    await clearOldChopsFSA(folder.handle, fileInfo.relativeDir, taggedStem);
  }

  const fadeInSamples = Math.round((exportSettings.fadeMs / 1000) * buffer.sampleRate);
  const fadeOutSamples = fadeInSamples;
  const zcWindow = Math.round((exportSettings.zcSearchMs / 1000) * buffer.sampleRate);

  const chopRows = [];
  let made = 0;
  for (const [s, e] of regions) {
    made++;
    let startSample = Math.max(0, Math.round(s * buffer.sampleRate));
    let endSample = Math.min(mono.length, Math.round(e * buffer.sampleRate));
    if (zcWindow > 0) {
      startSample = findNearestZeroCrossing(mono, startSample, zcWindow);
      endSample = findNearestZeroCrossing(mono, endSample, zcWindow);
    }
    if (endSample <= startSample) continue;

    const sliced = sliceChannels(channels, startSample, endSample);
    applyFades(sliced, fadeInSamples, fadeOutSamples);
    const blob = encodeWav(sliced, buffer.sampleRate, exportSettings.bitDepth);

    const fileName = chopFileName(made);
    await writeOutput(folder, "chops", `${fileInfo.relativeDir ? fileInfo.relativeDir + "/" : ""}${taggedStem}`, fileName, blob, zipBatch);

    chopRows.push({ fileName, blob, seconds: (endSample - startSample) / buffer.sampleRate });
  }

  log(`    created ${chopRows.length} chop(s)`);
  renderFileResult(folderResultsEl, fileInfo.name, keyText, bpmText, chopRows);
  return chopRows.length;
}

// ---------------------------------------------------------------------------
// Results UI (audition panel)
// ---------------------------------------------------------------------------

function renderFolderResultSection(folder) {
  const section = document.createElement("div");
  section.className = "result-folder";
  const heading = document.createElement("h3");
  heading.textContent = folder.name;
  section.appendChild(heading);
  resultsPanel.appendChild(section);
  return section;
}

function renderFileResult(folderSection, fileName, keyText, bpmText, chopRows) {
  const block = document.createElement("div");
  block.className = "result-file";

  const header = document.createElement("div");
  header.className = "result-file-header";
  header.innerHTML = `<span class="result-file-name">${escapeHtml(fileName)}</span><span class="result-file-meta">key: ${escapeHtml(
    keyText
  )} &middot; tempo: ${escapeHtml(bpmText)} &middot; ${chopRows.length} chop(s)</span>`;
  block.appendChild(header);

  const list = document.createElement("div");
  list.className = "chop-list";
  for (const chop of chopRows) {
    const row = document.createElement("div");
    row.className = "chop-row";
    const label = document.createElement("span");
    label.className = "chop-name";
    label.textContent = `${chop.fileName} (${chop.seconds.toFixed(1)}s)`;
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = URL.createObjectURL(chop.blob);
    row.appendChild(label);
    row.appendChild(audio);
    list.appendChild(row);
  }
  block.appendChild(list);
  folderSection.appendChild(block);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

async function processBatch() {
  processing = true;
  updateProcessButton();
  clearLog();
  resultsPanel.innerHTML = "";

  const zipBatch = FSA_SUPPORTED ? null : new ZipBatch();
  let totalChops = 0;
  let processedFolders = 0;

  for (const folder of sourceFolders) {
    log(`Folder: ${folder.name}`);
    if (folder.files.length === 0) {
      log("  No source audio found, skipped");
      continue;
    }

    if (folder.kind === "fsa") {
      const ok = await ensureReadWritePermission(folder.handle);
      if (!ok) {
        log("  Permission to write to this folder was denied, skipped");
        continue;
      }
    }

    const folderSection = renderFolderResultSection(folder);

    for (const fileInfo of folder.files) {
      try {
        totalChops += await processOneFile(folder, fileInfo, zipBatch, folderSection);
      } catch (err) {
        log(`  ERROR on ${fileInfo.name}: ${err.message || err} — skipping this file, batch continues`);
        console.error(err);
      }
      // Yield to the event loop so the log/UI stay responsive during a big batch.
      await new Promise((r) => setTimeout(r, 0));
    }
    processedFolders++;
  }

  if (zipBatch) {
    log("Building ZIP for download…");
    await zipBatch.downloadAs("auto_sample_chopper_output.zip");
    log("ZIP download started.");
  }

  log(`Done. Processed ${processedFolders} folder(s), created ${totalChops} candidate chop(s).`);
  processing = false;
  updateProcessButton();
}

processBtn.addEventListener("click", () => {
  if (!processing) processBatch();
});

// ---------------------------------------------------------------------------
// Export / detection settings wiring
// ---------------------------------------------------------------------------

bitDepthSelect.addEventListener("change", () => {
  exportSettings.bitDepth = parseInt(bitDepthSelect.value, 10);
});
fadeMsSlider.addEventListener("input", () => {
  exportSettings.fadeMs = parseFloat(fadeMsSlider.value);
  $("#fade-ms-value").textContent = `${fadeMsSlider.value}ms`;
});
zcMsSlider.addEventListener("input", () => {
  exportSettings.zcSearchMs = parseFloat(zcMsSlider.value);
  $("#zc-ms-value").textContent = `${zcMsSlider.value}ms`;
});
detectKeyCheckbox.addEventListener("change", () => {
  detectSettings.key = detectKeyCheckbox.checked;
});
detectTempoCheckbox.addEventListener("change", () => {
  detectSettings.tempo = detectTempoCheckbox.checked;
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  outputBanner.textContent = FSA_SUPPORTED
    ? "Chops are saved straight into each folder's wav/ and chops/ subfolders."
    : "This browser can't write directly to folders, so the whole batch will be bundled into one ZIP for you to download and unzip wherever you like.";
  outputBanner.className = FSA_SUPPORTED ? "banner banner--good" : "banner banner--info";

  if (!FSA_FILE_PICKER_SUPPORTED && FSA_SUPPORTED) {
    addFilesBtn.title = "This browser supports folder writing but not the individual-file picker — falling back to a plain file chooser.";
  }

  renderParamsPanel();
  renderFolderList();
  updateProcessButton();

  essentiaAvailable().then((available) => {
    essentiaStatus.textContent = available
      ? "Key & tempo detection ready."
      : "Key & tempo detection unavailable (couldn't load essentia.js) — chopping still works normally.";
    essentiaStatus.className = available ? "essentia-status essentia-status--ok" : "essentia-status essentia-status--warn";
  });
}

init();

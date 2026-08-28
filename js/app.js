import {
  phraseRegions,
  drumRegions,
  toMono,
  findNearestZeroCrossing,
  applyFades,
  sanitizeForPath,
  buildKeyTempoTag,
  joinNameParts,
  barsToSeconds,
  bandEnergies,
  classifyHit,
  findOneShotWindows,
  dedupeHits,
  peakAbs,
  onsetStrengthCurve,
  computeRmsEnvelope,
  pickOnsets,
} from "./dsp.js";
import { encodeWav, parseWav, parseAiff } from "./audio-codec.js";
import { analyzeKeyAndTempo, essentiaAvailable } from "./essentia-bridge.js";
import { APP_VERSION } from "./version.js";
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
  clearOldOneShotsFSA,
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
  // preferred/minLen/maxLen here are only the fallback used when a chop length in bars can't be
  // computed (no confident tempo detected) — normally length comes from drumBars + detected BPM.
  drums: { preferred: 8.0, maxLen: 16.0, minLen: 3.0, onsetSensitivity: 0.65, snapToTempo: true },
};
const DEFAULT_PARAMS = JSON.parse(JSON.stringify(params));
let autoParams = true; // when true, always use DEFAULT_PARAMS regardless of any manual edits below

// Drum chop length in bars (assumes 4/4) and the one-shot-extraction toggle live outside the
// Auto/manual params split — they're primary creative choices, not fine-tuning knobs.
const BAR_OPTIONS = [1, 2, 3, 4, 6, 8, 16];
let drumBars = 4;
let extractOneShots = false;

// Output naming: how the chops folder/filenames are built from the source name and the
// detected key/tempo tag. Kept separate from params so it applies the same regardless of mode.
const namingSettings = {
  chopPattern: "number", // 'number' | 'name-number' | 'name-tag-number'
  includeFolderTag: true, // fold the key/tempo tag into the chops folder name (and wav/ copy)
  separator: " ", // ' ' | '_' | '-'
  maxLen: 48, // safety cap on generated name length, for samplers with tight limits
};

const exportSettings = { bitDepth: 24, fadeMs: 5, zcSearchMs: 15 };
const detectSettings = { key: true, tempo: true };

const SETTINGS_STORAGE_KEY = "good-bits-settings-v1";

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
  drums: [{ key: "onsetSensitivity", label: "Onset sensitivity", min: 0.3, max: 1.0, step: 0.05, unit: "x" }],
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
const versionBadge = $("#version-badge");
const drumOptions = $("#drum-options");
const drumBarsSelect = $("#drum-bars-select");
const oneShotsCheckbox = $("#one-shots-checkbox");
const namingPatternSelect = $("#naming-pattern-select");
const namingSeparatorSelect = $("#naming-separator-select");
const namingMaxLenInput = $("#naming-maxlen-input");
const namingFolderTagCheckbox = $("#naming-folder-tag-checkbox");

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

function updateDrumOptionsVisibility() {
  drumOptions.hidden = mode !== "drums";
}

modeCards.forEach((card) => {
  card.addEventListener("click", () => {
    mode = card.dataset.mode;
    modeCards.forEach((c) => c.classList.toggle("mode-card--active", c === card));
    updateDrumOptionsVisibility();
    renderParamsPanel();
    saveSettings();
  });
});

autoParamsCheckbox.addEventListener("change", () => {
  autoParams = autoParamsCheckbox.checked;
  renderParamsPanel();
  saveSettings();
});

// ---------------------------------------------------------------------------
// Drum-specific options: chop length in bars, one-shot extraction
// ---------------------------------------------------------------------------

for (const bars of BAR_OPTIONS) {
  const opt = document.createElement("option");
  opt.value = String(bars);
  opt.textContent = `${bars} bar${bars === 1 ? "" : "s"}`;
  drumBarsSelect.appendChild(opt);
}

drumBarsSelect.addEventListener("change", () => {
  drumBars = parseInt(drumBarsSelect.value, 10);
  saveSettings();
});

oneShotsCheckbox.addEventListener("change", () => {
  extractOneShots = oneShotsCheckbox.checked;
  saveSettings();
});

// ---------------------------------------------------------------------------
// Output naming
// ---------------------------------------------------------------------------

namingPatternSelect.addEventListener("change", () => {
  namingSettings.chopPattern = namingPatternSelect.value;
  saveSettings();
});
namingSeparatorSelect.addEventListener("change", () => {
  namingSettings.separator = namingSeparatorSelect.value;
  saveSettings();
});
namingMaxLenInput.addEventListener("input", () => {
  namingSettings.maxLen = parseInt(namingMaxLenInput.value, 10);
  $("#naming-maxlen-value").textContent = `${namingMaxLenInput.value} chars`;
  saveSettings();
});
namingFolderTagCheckbox.addEventListener("change", () => {
  namingSettings.includeFolderTag = namingFolderTagCheckbox.checked;
  saveSettings();
});

/** Build the "<stem><sep><tag>" folder/base name (tag omitted if includeFolderTag is off or nothing was detected). */
function buildTaggedStem(stem, tag) {
  const parts = namingSettings.includeFolderTag && tag ? [stem, tag] : [stem];
  return sanitizeForPath(joinNameParts(parts, namingSettings.separator), namingSettings.maxLen);
}

/** Build one chop's output filename per the chosen naming pattern. */
function buildChopFileName(stem, tag, index) {
  const num = String(index).padStart(2, "0");
  const sep = namingSettings.separator;
  if (namingSettings.chopPattern === "number") return `${num}.wav`;
  const base = namingSettings.chopPattern === "name-tag-number" ? joinNameParts([stem, tag], sep) : stem;
  const reserve = sep.length + num.length;
  const safeBase = sanitizeForPath(base, Math.max(8, namingSettings.maxLen - reserve));
  return `${joinNameParts([safeBase], sep)}${sep}${num}.wav`;
}

// ---------------------------------------------------------------------------
// Settings persistence (this browser only — a light convenience, not sync)
// ---------------------------------------------------------------------------

function saveSettings() {
  try {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        mode,
        autoParams,
        drumBars,
        extractOneShots,
        naming: namingSettings,
        exportSettings,
        detectSettings,
        splitSubfolders: splitSubfoldersCheckbox.checked,
      })
    );
  } catch (_) {
    /* best-effort only — private browsing, storage disabled, quota, etc. */
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/** Apply a saved settings blob to state + the DOM controls, before the first render. */
function applySettings(saved) {
  if (!saved) return;
  if (saved.mode && params[saved.mode]) {
    mode = saved.mode;
    modeCards.forEach((c) => c.classList.toggle("mode-card--active", c.dataset.mode === mode));
  }
  if (typeof saved.autoParams === "boolean") {
    autoParams = saved.autoParams;
    autoParamsCheckbox.checked = autoParams;
  }
  if (BAR_OPTIONS.includes(saved.drumBars)) {
    drumBars = saved.drumBars;
    drumBarsSelect.value = String(drumBars);
  }
  if (typeof saved.extractOneShots === "boolean") {
    extractOneShots = saved.extractOneShots;
    oneShotsCheckbox.checked = extractOneShots;
  }
  if (saved.naming) {
    Object.assign(namingSettings, saved.naming);
    namingPatternSelect.value = namingSettings.chopPattern;
    namingSeparatorSelect.value = namingSettings.separator;
    namingMaxLenInput.value = String(namingSettings.maxLen);
    $("#naming-maxlen-value").textContent = `${namingSettings.maxLen} chars`;
    namingFolderTagCheckbox.checked = namingSettings.includeFolderTag;
  }
  if (saved.exportSettings) {
    Object.assign(exportSettings, saved.exportSettings);
    bitDepthSelect.value = String(exportSettings.bitDepth);
    fadeMsSlider.value = String(exportSettings.fadeMs);
    $("#fade-ms-value").textContent = `${exportSettings.fadeMs}ms`;
    zcMsSlider.value = String(exportSettings.zcSearchMs);
    $("#zc-ms-value").textContent = `${exportSettings.zcSearchMs}ms`;
  }
  if (saved.detectSettings) {
    Object.assign(detectSettings, saved.detectSettings);
    detectKeyCheckbox.checked = detectSettings.key;
    detectTempoCheckbox.checked = detectSettings.tempo;
  }
  if (typeof saved.splitSubfolders === "boolean") {
    splitSubfoldersCheckbox.checked = saved.splitSubfolders;
  }
  updateDrumOptionsVisibility();
}

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
  // (and the wav/ copy's filename) by default rather than being repeated on
  // every numbered chop — see the "Output naming" panel for the options.
  const wantKey = detectSettings.key;
  const wantTempo = detectSettings.tempo;
  const kt = await analyzeKeyAndTempo(mono, buffer.sampleRate, { key: wantKey, tempo: wantTempo });
  const tag = buildKeyTempoTag(kt, namingSettings.separator);
  const taggedStem = buildTaggedStem(stem, tag);

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
    const barsSec = barsToSeconds(drumBars, kt.bpm);
    const drumParams = { ...modeParams.drums };
    if (barsSec) {
      drumParams.preferred = barsSec;
      drumParams.minLen = Math.max(0.4, barsSec * 0.5);
      drumParams.maxLen = barsSec * 1.5;
    } // else: no confident tempo — fall back to the fixed preferred/minLen/maxLen above
    const snapBpm = drumParams.snapToTempo ? kt.bpm : null;
    regions = drumRegions(mono, buffer.sampleRate, drumParams, snapBpm).regions;
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

    const fileName = buildChopFileName(stem, tag, made);
    await writeOutput(folder, "chops", `${fileInfo.relativeDir ? fileInfo.relativeDir + "/" : ""}${taggedStem}`, fileName, blob, zipBatch);

    chopRows.push({ fileName, blob, seconds: (endSample - startSample) / buffer.sampleRate });
  }

  log(`    created ${chopRows.length} chop(s)`);

  let oneShotRows = [];
  if (mode === "drums" && extractOneShots) {
    oneShotRows = await extractAndWriteOneShots(folder, fileInfo, taggedStem, mono, channels, buffer.sampleRate, zipBatch);
    log(`    extracted ${oneShotRows.length} one-shot hit(s)`);
  }

  renderFileResult(folderResultsEl, fileInfo.name, keyText, bpmText, chopRows, oneShotRows);
  return chopRows.length;
}

/** Finds, classifies, dedupes and writes one-shot hits for a drum-mode source file. */
async function extractAndWriteOneShots(folder, fileInfo, taggedStem, mono, channels, sampleRate, zipBatch) {
  const { times, vals } = computeRmsEnvelope(mono, sampleRate, 20, 10);
  if (!vals.length) return [];
  const diffs = onsetStrengthCurve(vals);
  const onsets = pickOnsets(times, diffs, 0.65, 0.08);
  const windows = findOneShotWindows(mono, sampleRate, onsets);

  const candidates = windows.map(([s, e]) => {
    const startSample = Math.max(0, Math.round(s * sampleRate));
    const endSample = Math.min(mono.length, Math.round(e * sampleRate));
    const { low, mid, high } = bandEnergies(mono, sampleRate, startSample, endSample);
    const label = classifyHit({ low, mid, high, durationSec: e - s });
    const peak = peakAbs(mono, startSample, endSample);
    return { start: s, end: e, startSample, endSample, low, mid, high, peak, label };
  });

  const kept = dedupeHits(candidates);
  if (kept.length === 0) return [];

  if (folder.kind === "fsa") {
    await clearOldOneShotsFSA(folder.handle, fileInfo.relativeDir, taggedStem);
  }

  const fadeOutSamples = Math.round(0.008 * sampleRate); // short tail fade only — a full fade-in would blunt the transient
  const counters = {};
  const rows = [];
  for (const hit of kept) {
    counters[hit.label] = (counters[hit.label] || 0) + 1;
    const sliced = sliceChannels(channels, hit.startSample, hit.endSample);
    applyFades(sliced, 0, fadeOutSamples);
    const blob = encodeWav(sliced, sampleRate, exportSettings.bitDepth);
    const fileName = `${hit.label}_${String(counters[hit.label]).padStart(2, "0")}.wav`;
    await writeOutput(
      folder,
      "one shots",
      `${fileInfo.relativeDir ? fileInfo.relativeDir + "/" : ""}${taggedStem}`,
      fileName,
      blob,
      zipBatch
    );
    rows.push({ fileName, blob, seconds: (hit.endSample - hit.startSample) / sampleRate });
  }
  return rows;
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

function renderChopList(chopRows) {
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
  return list;
}

function renderFileResult(folderSection, fileName, keyText, bpmText, chopRows, oneShotRows = []) {
  const block = document.createElement("div");
  block.className = "result-file";

  const header = document.createElement("div");
  header.className = "result-file-header";
  header.innerHTML = `<span class="result-file-name">${escapeHtml(fileName)}</span><span class="result-file-meta">key: ${escapeHtml(
    keyText
  )} &middot; tempo: ${escapeHtml(bpmText)} &middot; ${chopRows.length} chop(s)${
    oneShotRows.length ? ` &middot; ${oneShotRows.length} one-shot(s)` : ""
  }</span>`;
  block.appendChild(header);
  block.appendChild(renderChopList(chopRows));

  if (oneShotRows.length) {
    const oneShotHeading = document.createElement("div");
    oneShotHeading.className = "result-subheading";
    oneShotHeading.textContent = "One-shots";
    block.appendChild(oneShotHeading);
    block.appendChild(renderChopList(oneShotRows));
  }

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
  saveSettings();
});
fadeMsSlider.addEventListener("input", () => {
  exportSettings.fadeMs = parseFloat(fadeMsSlider.value);
  $("#fade-ms-value").textContent = `${fadeMsSlider.value}ms`;
  saveSettings();
});
zcMsSlider.addEventListener("input", () => {
  exportSettings.zcSearchMs = parseFloat(zcMsSlider.value);
  $("#zc-ms-value").textContent = `${zcMsSlider.value}ms`;
  saveSettings();
});
detectKeyCheckbox.addEventListener("change", () => {
  detectSettings.key = detectKeyCheckbox.checked;
  saveSettings();
});
detectTempoCheckbox.addEventListener("change", () => {
  detectSettings.tempo = detectTempoCheckbox.checked;
  saveSettings();
});
splitSubfoldersCheckbox.addEventListener("change", saveSettings);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function init() {
  versionBadge.textContent = `v${APP_VERSION}`;
  applySettings(loadSettings());

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

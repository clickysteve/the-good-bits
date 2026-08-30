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
  hitFingerprint,
  findOneShotWindows,
  dedupeHits,
  peakAbs,
  multiBandOnsetStrengthCurve,
  computeRmsEnvelope,
  pickOnsets,
  computePeaks,
  findAudibleStart,
  equalSliceRegions,
} from "./dsp.js";
import { stretchChannels, ratioForTargetTempo, resolveCharacter, characterGroups, MACROS } from "./timestretch.js";
import { stretchRenderSignature, isProcessedPreviewStale, randomiseMacroValues, randomSeed } from "./dsp/stretch/workspace-state.js";
import { createStretchWorkspace } from "./stretch-workspace.js";
import { OUTPUT_STAGES, DRIVE_TYPES, applyLofiChain as applyLofiChainPure } from "./outputstage.js";
import { encodeWav, parseWav, parseAiff } from "./audio-codec.js";
import { analyzeKeyAndTempo, essentiaAvailable } from "./essentia-bridge.js";
import { APP_VERSION } from "./version.js";
import { createEditableWaveform } from "./editor-waveform.js";
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
  collectDroppedFolderLegacy,
  writeFileFSA,
  clearOldChopsFSA,
  clearOldOneShotsFSA,
  clearOldNumberedFilesFSA,
  ZipBatch,
} from "./io-fs.js";
import { rememberFolder, listRememberedFolders, forgetFolder, forgetAllFolders } from "./folder-store.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mode = "phrases"; // 'phrases' | 'rhodes' | 'drums'
let processing = false;

// Preview and Export are the same run with one difference: whether writeOutput() is allowed to
// touch the disk. See writeOutput().
let dryRun = false;

/**
 * What Preview worked out, so Export doesn't have to work it out again.
 *
 * Keyed per source file, holding the detected key/tempo and the chop and one-shot regions. Export
 * still re-decodes the audio (cheap next to essentia, and holding every decoded buffer would blow
 * up memory on a large batch) but skips key/tempo and onset detection entirely when the entry is
 * still valid. The editor writes edited regions straight back in here, which is how an adjustment
 * made during a preview survives through to the export.
 */
const analysisCache = new Map();

function analysisKey(folder, fileInfo) {
  return `${folder.id}::${fileInfo.relativeDir || ""}/${fileInfo.name}`;
}

/**
 * Everything that would change what detection produces. Stored alongside each cache entry; when it
 * no longer matches, the entry is stale and detection reruns. Deliberately does NOT include
 * time-stretch, lo-fi or naming: those change how a chop is rendered or named, not where it is cut,
 * so tweaking them and re-exporting can safely reuse the detected regions.
 */
function detectionSignature() {
  return JSON.stringify({
    mode,
    drumBars,
    chopIntoPieces,
    extractOneShots,
    detect: detectSettings,
    params: activeParams()[mode],
    zcSearchMs: exportSettings.zcSearchMs,
  });
}

function cachedAnalysis(folder, fileInfo) {
  const entry = analysisCache.get(analysisKey(folder, fileInfo));
  if (!entry) return null;
  return entry.signature === detectionSignature() ? entry : null;
}

/**
 * Drops everything Preview/Process worked out, including any manual edits sitting in it.
 * Deliberately NOT called just because the folder queue changed (adding or removing a folder used
 * to clear this wholesale, which meant adding a second folder after editing the first one's chops
 * silently discarded those edits) - only an explicit "start over" action should reach for this.
 * A settings change that actually affects detection doesn't need this either: cachedAnalysis()
 * already treats an entry as stale the moment detectionSignature() no longer matches it.
 */
function invalidateAnalysis() {
  analysisCache.clear();
}
let cancelRequested = false;
let nextFolderId = 1;
let looseFileGroupCounter = 0;
let looseDestinationHandle = null; // cached FSA destination for individually-picked files
const sourceFolders = []; // {id, name, kind:'fsa'|'legacy', handle?, isLoose?, files:[...]}
// Folders remembered from a previous session (via folder-store.js/IndexedDB) whose permission
// hasn't been re-granted yet this session - shown in the folder list with a Reconnect button.
const pendingReconnectFolders = []; // {name, handle}

const FSA_SUPPORTED = supportsFileSystemAccess();
const FSA_FILE_PICKER_SUPPORTED = supportsFilePickerFSA();

const params = {
  phrases: { silenceMarginDb: 18, minSilenceDuration: 0.32, mergeGap: 0.2, minLen: 0.8, maxLen: 18.0, preferred: 11.0, pad: 0.12 },
  rhodes: { silenceMarginDb: 10, minSilenceDuration: 0.5, mergeGap: 0.55, minLen: 1.8, maxLen: 20.0, preferred: 13.0, pad: 0.18 },
  // preferred/minLen/maxLen here are only the fallback used when a chop length in bars can't be
  // computed (no confident tempo detected) - normally length comes from drumBars + detected BPM.
  drums: { preferred: 8.0, maxLen: 16.0, minLen: 3.0, onsetSensitivity: 0.65, snapToTempo: true },
};
const DEFAULT_PARAMS = JSON.parse(JSON.stringify(params));
let autoParams = true; // when true, always use DEFAULT_PARAMS regardless of any manual edits below

// Drum chop length in bars (assumes 4/4) and the one-shot-extraction toggle live outside the
// Auto/manual params split - they're primary creative choices, not fine-tuning knobs.
const BAR_OPTIONS = [1, 2, 3, 4, 6, 8, 16];
let drumBars = 4;
let extractOneShots = false;

// Whether the batch chops each file into pieces at all - off means "process the whole file only"
// (still runs key/tempo detection, the wav/ copy, and any time-stretch/lo-fi processing), so
// time-stretch and the lo-fi stages can be used standalone without cutting anything up.
let chopIntoPieces = true;

// Output naming: how the chops folder/filenames are built from the source name and the
// detected key/tempo tag. Kept separate from params so it applies the same regardless of mode.
// chopPattern is a typable template using {name}/{tag}/{number} tokens (see buildChopFileName) -
// no fixed set of presets, so it can be typed exactly how a given sampler wants it named.
const namingSettings = {
  chopPattern: "{number}",
  includeFolderTag: true, // fold the key/tempo tag into the chops folder name (and wav/ copy)
  separator: " ", // ' ' | '_' | '-' - joins the key and tempo inside the auto-generated tag
};

// Internal safety cap on generated name length so a long source name + a long typed pattern can't
// produce a pathological path. Not user-configurable - it's a backstop, not a setting to tune.
const SAFE_NAME_LIMIT = 180;

// Old chopPattern values from a settings blob saved before naming became a typable template.
const LEGACY_PATTERN_MAP = {
  number: "{number}",
  "name-number": "{name} {number}",
  "name-tag-number": "{name} {tag} {number}",
};

const exportSettings = { bitDepth: 24, fadeMs: 5, zcSearchMs: 15 };
const detectSettings = { key: true, tempo: true };

// Applied to main chops and the full-file wav/ copy, but not one-shots, at export time.
// macroValues is a flat {texture, variation, smear, roughness} map - a character only reads the
// macro(s) named in its own registry entry (js/dsp/stretch/characters.js), so values for macros a
// character doesn't use just ride along unused rather than needing to be reset per-character.
// seed drives every deterministic-random engine (granular jitter, phase/spectral randomisation,
// repeat jitter) - same input + settings + seed always reproduces the same output.
const timestretchSettings = {
  enabled: false,
  mode: "target-tempo",
  targetBpm: 120,
  ratio: 1.0,
  character: "clean",
  macroValues: { texture: 50, variation: 50, smear: 50, roughness: 50 },
  seed: 1,
};

// Lo-fi processing chain (output-stage character -> drive -> crunch), applied in that order.
// Same scope as time-stretch: main chops and the full-file wav/ copy, not one-shots.
const outputStageSettings = { enabled: false, mode: "cassette", mixPct: 100, intensityPct: 50 };
const driveSettings = { enabled: false, type: "tape", amountPct: 40 };
const crunchSettings = { enabled: false, bits: 8, rateDivide: 1 };

// Processing scope, shared by time-stretch and the lo-fi chain above. Off by default so existing
// behavior (one-shots always raw, only one copy of everything) doesn't change until opted into.
let applyProcessingToOneShots = false; // also run the stretch/lo-fi chain on one-shots, not just chops
let keepUnprocessedCopy = false; // additionally write a raw, unprocessed copy of anything processed

const SETTINGS_STORAGE_KEY = "good-bits-settings-v1";

// Reset at the start of every batch; "continue"/"skip" once the user checks "remember for
// this batch" in the no-tempo-detected confirm dialog, so they aren't asked file after file.
let drumTempoSkipPolicy = null;

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

/**
 * Break-sized drum regions for `bars` bars at `bpm` (falling back to drums-mode's fixed
 * preferred/min/max length when bpm is unknown). Shared by the initial per-file detection pass and
 * by the editor's "Re-chop by bars" action, so there's exactly one place that turns a bar count
 * into drumRegions() parameters.
 */
function computeDrumRegions(mono, sampleRate, bars, bpm) {
  const barsSec = barsToSeconds(bars, bpm);
  const drumParams = { ...activeParams().drums };
  if (barsSec) {
    drumParams.preferred = barsSec;
    drumParams.minLen = Math.max(0.4, barsSec * 0.5);
    drumParams.maxLen = barsSec * 1.5;
  } // else: no confident tempo - fall back to the fixed preferred/minLen/maxLen above
  const snapBpm = drumParams.snapToTempo ? bpm : null;
  return drumRegions(mono, sampleRate, drumParams, snapBpm).regions;
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
const fadeMsNumber = $("#fade-ms-value");
const zcMsSlider = $("#zc-ms-slider");
const zcMsNumber = $("#zc-ms-value");
const detectKeyCheckbox = $("#detect-key-checkbox");
const detectTempoCheckbox = $("#detect-tempo-checkbox");
const essentiaStatus = $("#essentia-status");
const versionBadge = $("#version-badge");
const taskSwitcherBtns = document.querySelectorAll("#task-switcher .seg-btn");
const settingsToggleBtn = $("#settings-toggle");
const drumOptions = $("#drum-options");
const drumBarsSelect = $("#drum-bars-select");
const oneShotsCheckbox = $("#one-shots-checkbox");
const namingPatternInput = $("#naming-pattern-input");
const namingSeparatorSelect = $("#naming-separator-select");
const namingFolderTagCheckbox = $("#naming-folder-tag-checkbox");
const namingPreviewEl = $("#naming-preview");
const timestretchEnableCheckbox = $("#timestretch-enable-checkbox");
const timestretchOptions = $("#timestretch-options");
const timestretchModeSelect = $("#timestretch-mode-select");
const timestretchTargetRow = $("#timestretch-target-row");
const timestretchTargetBpmInput = $("#timestretch-target-bpm-input");
const timestretchTargetBpmNumber = $("#timestretch-target-bpm-value");
const timestretchRatioRow = $("#timestretch-ratio-row");
const timestretchRatioInput = $("#timestretch-ratio-input");
const timestretchRatioNumber = $("#timestretch-ratio-value");
const timestretchCharacterSelect = $("#timestretch-character-select");
const timestretchCharacterHint = $("#timestretch-character-hint");
const timestretchMacro1Row = $("#timestretch-macro1-row");
const timestretchMacro1Label = $("#timestretch-macro1-label");
const timestretchMacro1Slider = $("#timestretch-macro1-slider");
const timestretchMacro1Number = $("#timestretch-macro1-value");
const timestretchMacro1Hint = $("#timestretch-macro1-hint");
const timestretchMacro2Row = $("#timestretch-macro2-row");
const timestretchMacro2Label = $("#timestretch-macro2-label");
const timestretchMacro2Slider = $("#timestretch-macro2-slider");
const timestretchMacro2Number = $("#timestretch-macro2-value");
const timestretchMacro2Hint = $("#timestretch-macro2-hint");
const timestretchSeedRow = $("#timestretch-seed-row");
const timestretchSeedInput = $("#timestretch-seed-input");
const timestretchPitchNote = $("#timestretch-pitch-note");
const timestretchDetectedBpmReadout = $("#timestretch-detected-bpm-readout");
const timestretchResolvedRatioReadout = $("#timestretch-resolved-ratio-readout");
const stretchWorkspaceEl = $("#stretch-workspace");
const detectionParamsPanel = $("#detection-params-panel");
const outputstageEnableCheckbox = $("#outputstage-enable-checkbox");
const outputstageOptions = $("#outputstage-options");
const outputstageModeSelect = $("#outputstage-mode-select");
const outputstageMixSlider = $("#outputstage-mix-slider");
const outputstageMixNumber = $("#outputstage-mix-value");
const outputstageIntensitySlider = $("#outputstage-intensity-slider");
const outputstageIntensityNumber = $("#outputstage-intensity-value");
const driveEnableCheckbox = $("#drive-enable-checkbox");
const driveOptions = $("#drive-options");
const driveTypeSelect = $("#drive-type-select");
const driveAmountSlider = $("#drive-amount-slider");
const driveAmountNumber = $("#drive-amount-value");
const crunchEnableCheckbox = $("#crunch-enable-checkbox");
const crunchOptions = $("#crunch-options");
const crunchBitsSlider = $("#crunch-bits-slider");
const crunchBitsNumber = $("#crunch-bits-value");
const crunchRateSlider = $("#crunch-rate-slider");
const crunchRateNumber = $("#crunch-rate-value");
const oneshotProcessingCheckbox = $("#oneshot-processing-checkbox");
const keepCleanCopyCheckbox = $("#keep-clean-copy-checkbox");
const previewBtn = $("#preview-btn");
const previewStatus = $("#preview-status");
const cancelBtn = $("#cancel-btn");
const progressRow = $("#progress-row");
const progressBarFill = $("#progress-bar-fill");
const progressLabel = $("#progress-label");

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

function logWarn(line) {
  const el = document.createElement("div");
  el.className = "log-line log-line--warn";
  el.textContent = `⚠ ${line}`;
  logPanel.appendChild(el);
  logPanel.scrollTop = logPanel.scrollHeight;
}

function clearLog() {
  logPanel.innerHTML = "";
}

// ---------------------------------------------------------------------------
// Confirm dialog (themed replacement for window.confirm, since a blocking
// native dialog would clash with the rest of the UI)
// ---------------------------------------------------------------------------

function showConfirmDialog({ title, body, confirmLabel = "Continue", cancelLabel = "Cancel", showRemember = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = "modal";

    const h = document.createElement("h3");
    h.textContent = title;
    modal.appendChild(h);

    const p = document.createElement("p");
    p.textContent = body;
    modal.appendChild(p);

    let rememberCheckbox = null;
    if (showRemember) {
      const label = document.createElement("label");
      label.className = "checkbox-label modal-remember";
      rememberCheckbox = document.createElement("input");
      rememberCheckbox.type = "checkbox";
      label.appendChild(rememberCheckbox);
      label.append(" Use this choice for the rest of this batch");
      modal.appendChild(label);
    }

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn--ghost";
    cancelBtn.textContent = cancelLabel;
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn btn--primary";
    confirmBtn.textContent = confirmLabel;
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    confirmBtn.focus();

    function close(confirmed) {
      overlay.remove();
      resolve({ confirmed, remember: rememberCheckbox ? rememberCheckbox.checked : false });
    }
    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
  });
}

/** Gate for drums-mode files where tempo detection was attempted but came back empty. */
async function resolveTempoWarning(fileName) {
  if (drumTempoSkipPolicy === "continue") return true;
  if (drumTempoSkipPolicy === "skip") return false;

  logWarn(`no confident tempo detected for "${fileName}"`);
  const { confirmed, remember } = await showConfirmDialog({
    title: "No tempo detected",
    body: `"${fileName}" - no confident tempo was detected, so the drum chop length will fall back to a fixed length instead of your chosen bar count. Continue with the fallback, or skip this file?`,
    confirmLabel: "Continue with fallback length",
    cancelLabel: "Skip this file",
    showRemember: true,
  });
  if (remember) drumTempoSkipPolicy = confirmed ? "continue" : "skip";
  return confirmed;
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
  drumOptions.hidden = mode !== "drums" || !chopIntoPieces;
  detectionParamsPanel.hidden = !chopIntoPieces;
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
drumBarsSelect.value = String(drumBars); // options default to the first one otherwise, not the state's actual default (4)

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

namingPatternInput.addEventListener("input", () => {
  namingSettings.chopPattern = namingPatternInput.value;
  updateNamingPreview();
  saveSettings();
});
namingSeparatorSelect.addEventListener("change", () => {
  namingSettings.separator = namingSeparatorSelect.value;
  updateNamingPreview();
  saveSettings();
});
namingFolderTagCheckbox.addEventListener("change", () => {
  namingSettings.includeFolderTag = namingFolderTagCheckbox.checked;
  updateNamingPreview();
  saveSettings();
});

/** Build the "<stem><sep><tag>" folder/base name (tag omitted if includeFolderTag is off or nothing was detected). */
function buildTaggedStem(stem, tag) {
  const parts = namingSettings.includeFolderTag && tag ? [stem, tag] : [stem];
  return sanitizeForPath(joinNameParts(parts, namingSettings.separator), SAFE_NAME_LIMIT);
}

/** Substitutes {name}/{tag}/{number} tokens (case-insensitively) in a typed naming pattern. */
function resolveNamePattern(template, tokens) {
  return template.replace(/\{(name|tag|number)\}/gi, (match, key) => {
    const value = tokens[key.toLowerCase()];
    return value === undefined || value === null ? "" : String(value);
  });
}

/**
 * Build one chop's output filename from the user-typed pattern. A {number} token is added
 * automatically if the pattern doesn't include one, so chops from the same file can never
 * collide/overwrite each other even if the pattern the user typed would otherwise repeat.
 */
function buildChopFileName(stem, tag, index) {
  const num = String(index).padStart(2, "0");
  let template = (namingSettings.chopPattern || "").trim() || "{number}";
  if (!/\{number\}/i.test(template)) template = `${template} {number}`.trim();
  const resolved = resolveNamePattern(template, { name: stem, tag, number: num }).replace(/\s+/g, " ").trim();
  const base = sanitizeForPath(resolved, SAFE_NAME_LIMIT) || num;
  return `${base}.wav`;
}

/** Refreshes the "here's what that'll look like" example under the naming pattern input. */
function updateNamingPreview() {
  const sampleTag = buildKeyTempoTag({ key: "C", scale: "minor", bpm: 120 }, namingSettings.separator);
  const folderName = buildTaggedStem("drum_take", sampleTag);
  const sampleNames = [1, 2, 3].map((i) => buildChopFileName("drum_take", sampleTag, i));
  namingPreviewEl.textContent = `${folderName}/  ->  ${sampleNames.join(", ")}`;
}

/**
 * Pairs a <input type="range"> with a same-scale <input type="number"> so a setting is always
 * both draggable AND typable - dragging live-updates the number as you go, typing a value commits
 * (on blur or Enter, i.e. a "change" event) clamped to the slider's min/max and rounded to its
 * step, and either path calls the same onValue(value) so each setting only needs one update
 * function regardless of which control the user actually used.
 */
function bindSliderNumber(slider, number, onValue) {
  const min = Number(slider.min);
  const max = Number(slider.max);
  const step = Number(slider.step) || 1;
  slider.addEventListener("input", () => {
    number.value = slider.value;
    onValue(Number(slider.value));
  });
  number.addEventListener("change", () => {
    let v = Number(number.value);
    if (!Number.isFinite(v)) v = Number(slider.value);
    v = Math.min(max, Math.max(min, Math.round(v / step) * step));
    number.value = String(v);
    slider.value = String(v);
    onValue(v);
  });
}

// ---------------------------------------------------------------------------
// Time-stretch
// ---------------------------------------------------------------------------

function updateTimestretchModeVisibility() {
  timestretchTargetRow.hidden = timestretchSettings.mode !== "target-tempo";
  timestretchRatioRow.hidden = timestretchSettings.mode !== "fixed-ratio";
}

// Character <select> is populated here (data-driven, from js/dsp/stretch/characters.js) rather than
// hand-written in index.html, the same pattern the output-stage select already uses (see the
// OUTPUT_STAGES loop below) - a couple dozen characters across five groups would be an unmaintainable
// wall of markup otherwise, and this way the palette and the UI can never drift out of sync.
for (const group of characterGroups()) {
  if (!group.characters.length) continue;
  const optgroup = document.createElement("optgroup");
  optgroup.label = group.label;
  for (const c of group.characters) {
    const opt = document.createElement("option");
    opt.value = c.key;
    opt.textContent = c.label;
    opt.title = c.description;
    optgroup.appendChild(opt);
  }
  timestretchCharacterSelect.appendChild(optgroup);
}

const MACRO_SLOTS = [
  { row: timestretchMacro1Row, label: timestretchMacro1Label, slider: timestretchMacro1Slider, number: timestretchMacro1Number, hint: timestretchMacro1Hint },
  { row: timestretchMacro2Row, label: timestretchMacro2Label, slider: timestretchMacro2Slider, number: timestretchMacro2Number, hint: timestretchMacro2Hint },
];

/**
 * Shows/hides the character description, up to two macro-control sliders, and the seed field for
 * whichever character is currently selected - only the controls that character's registry entry
 * actually names (see js/dsp/stretch/characters.js) are shown, so switching characters can't leave a
 * stale, meaningless slider on screen or silently carry a setting into an engine that ignores it.
 */
function updateCharacterUI() {
  const character = resolveCharacter(timestretchSettings.character);
  timestretchCharacterHint.textContent = character.description || "";

  const macroKeys = character.macros || [];
  MACRO_SLOTS.forEach((slot, i) => {
    const key = macroKeys[i];
    slot.row.hidden = !key;
    if (!key) return;
    const meta = MACROS[key];
    slot.label.textContent = meta.label;
    slot.hint.textContent = meta.hint || "";
    const value = timestretchSettings.macroValues[key] ?? meta.default;
    slot.slider.value = slot.number.value = String(value);
    slot.slider.dataset.macroKey = key;
    slot.number.dataset.macroKey = key;
  });

  timestretchSeedRow.hidden = !character.usesSeed;
  timestretchSeedInput.value = String(timestretchSettings.seed ?? 1);

  timestretchPitchNote.textContent =
    character.preservesPitch === false
      ? "Pitch follows speed - stretching also changes pitch, like tape or varispeed."
      : "Pitch preserved. No confident tempo means it exports unstretched.";
}

for (const slot of MACRO_SLOTS) {
  bindSliderNumber(slot.slider, slot.number, (v) => {
    const key = slot.slider.dataset.macroKey;
    if (!key) return;
    timestretchSettings.macroValues[key] = v;
    saveSettings();
  });
}

timestretchSeedInput.addEventListener("change", () => {
  const v = Math.max(0, Math.round(Number(timestretchSeedInput.value) || 0));
  timestretchSettings.seed = v;
  timestretchSeedInput.value = String(v);
  saveSettings();
});

// ---------------------------------------------------------------------------
// Stretch workspace: STRETCH's central Original vs. Processed audition area, its character
// browser, and per-file selection. CHOP and BOTH are untouched - they keep rendering into
// #results-panel via renderFileResult(), exactly as before this redesign. See
// js/stretch-workspace.js for the renderer and js/dsp/stretch/workspace-state.js for the pure
// staleness/randomise helpers behind it.
//
// State lives in two places, same split as everywhere else in this file: `analysisCache` (keyed by
// analysisKey(), see near the top of this file) gets two extra fields per entry when task is
// STRETCH - stretchOriginal and stretchProcessed - populated by processOneFile(); this module only
// tracks which file is currently active in the workspace and re-renders from that cache.
// ---------------------------------------------------------------------------

const stretchWorkspace = createStretchWorkspace({ container: stretchWorkspaceEl, getAudioContext, color: themeColor });

let stretchActiveKey = null; // analysisKey() of the file shown in the workspace right now
const stretchFileOrder = []; // [{key, folder, fileInfo}], rebuilt at the start of every stretch-task batch run

/** Everything that affects what a stretch render sounds like - lofi included, since the workspace's Processed pane reflects the whole chain, not just the stretch stage. */
function currentStretchSignature() {
  return stretchRenderSignature(timestretchSettings, lofiSettingsSnapshot());
}

function stretchStaleFor(entry) {
  return !!(entry && entry.stretchProcessed && isProcessedPreviewStale(entry.stretchProcessed.signature, timestretchSettings, lofiSettingsSnapshot()));
}

/** Cheap - safe to call on every settings tweak (see saveSettings()). Never rebuilds a waveform. */
function refreshStretchStaleIndicator() {
  if (task !== "stretch") return;
  const entry = stretchActiveKey ? analysisCache.get(stretchActiveKey) : null;
  stretchWorkspace.setStale(stretchStaleFor(entry));
  updateStretchDetectedReadouts();
}

function updateStretchDetectedReadouts() {
  const entry = stretchActiveKey ? analysisCache.get(stretchActiveKey) : null;
  const bpm = entry && entry.kt ? entry.kt.bpm : null;
  timestretchDetectedBpmReadout.textContent = bpm ? `${Math.round(bpm)} BPM` : "–";
  timestretchResolvedRatioReadout.textContent = entry ? `${resolveStretchRatio(bpm).toFixed(2)}x` : "–";
}

/**
 * Rebuilds the flat file list the workspace's file strip shows, from whatever's currently queued -
 * called on every add/remove (via renderFolderList()) so a newly-added file appears right away
 * (shown as not-yet-processed) rather than waiting for the next Process/Export run, AND at the start
 * of every stretch-task batch run so processing order matches what's on screen. Picks a default
 * active file if none is set (or the previous one is gone).
 */
function rebuildStretchFileOrder() {
  stretchFileOrder.length = 0;
  for (const folder of sourceFolders) {
    for (const fileInfo of folder.files) stretchFileOrder.push({ key: analysisKey(folder, fileInfo), folder, fileInfo });
  }
  if (stretchFileOrder.length && !stretchFileOrder.some((f) => f.key === stretchActiveKey)) {
    stretchActiveKey = stretchFileOrder[0].key;
  } else if (!stretchFileOrder.length) {
    stretchActiveKey = null;
  }
}

function renderStretchFileStrip() {
  const items = stretchFileOrder.map(({ key, fileInfo }) => {
    const entry = analysisCache.get(key);
    return { key, fileName: fileInfo.name, processed: !!(entry && entry.stretchOriginal) };
  });
  stretchWorkspace.setFileList(items, stretchActiveKey, setStretchActiveFile);
}

function renderStretchActivePanes() {
  const entry = stretchActiveKey ? analysisCache.get(stretchActiveKey) : null;
  stretchWorkspace.setOriginal(entry ? entry.stretchOriginal : null);
  stretchWorkspace.setProcessed(entry ? entry.stretchProcessed : null, stretchStaleFor(entry));
  updateStretchDetectedReadouts();
}

function setStretchActiveFile(key) {
  if (stretchActiveKey === key) return;
  stretchWorkspace.stopAllPlayback();
  stretchActiveKey = key;
  renderStretchFileStrip();
  renderStretchActivePanes();
}

function renderStretchCharacterBrowser() {
  if (task !== "stretch") return;
  stretchWorkspace.renderCharacterBrowser({
    characterKey: timestretchSettings.character,
    macroValues: timestretchSettings.macroValues,
    seed: timestretchSettings.seed,
    onSelectCharacter: (key) => {
      if (timestretchSettings.character === key) return;
      timestretchSettings.character = key;
      updateCharacterUI(); // keeps the BOTH-only rail select (still live for the BOTH task) in sync
      renderStretchCharacterBrowser();
      saveSettings();
    },
    onMacroChange: (key, value) => {
      timestretchSettings.macroValues[key] = value;
      saveSettings();
    },
    onSeedChange: (value) => {
      timestretchSettings.seed = value;
      saveSettings();
    },
    onRandomise: () => {
      const character = resolveCharacter(timestretchSettings.character);
      timestretchSettings.macroValues = randomiseMacroValues(character, timestretchSettings.macroValues);
      if (character.usesSeed) timestretchSettings.seed = randomSeed();
      renderStretchCharacterBrowser();
      updateCharacterUI();
      saveSettings();
      log(`  randomised "${character.label}"'s creative controls.`);
    },
  });
}

/** Shows/hides the whole workspace - only meaningful once there's something in it to show. */
function updateStretchWorkspaceVisibility() {
  const show = task === "stretch" && sourceFolders.length > 0;
  stretchWorkspaceEl.hidden = !show;
  if (!show) stretchWorkspace.stopAllPlayback();
}

/**
 * STRETCH's entire purpose is stretching, so the "Stretch on export" checkbox has nothing to gate
 * there - stretch is inherently on, and its options should just be visible, not hidden behind a
 * checkbox the user has to know to tick first. BOTH keeps the checkbox meaningful (stretch really
 * is optional when you're also chopping); CHOP never shows this section at all. See
 * stretchEffectivelyEnabled(), which resolveStretchRatio() uses instead of reading
 * timestretchSettings.enabled directly, so this is a display-only override - it never mutates the
 * underlying setting BOTH relies on.
 */
function updateStretchTaskVisibility() {
  timestretchOptions.hidden = !(task === "stretch" || timestretchSettings.enabled);
}

/** Whether a stretch should actually run: always in STRETCH, the checkbox's own state in BOTH. */
function stretchEffectivelyEnabled() {
  return task === "stretch" || timestretchSettings.enabled;
}

timestretchEnableCheckbox.addEventListener("change", () => {
  timestretchSettings.enabled = timestretchEnableCheckbox.checked;
  updateStretchTaskVisibility();
  saveSettings();
});
timestretchModeSelect.addEventListener("change", () => {
  timestretchSettings.mode = timestretchModeSelect.value;
  updateTimestretchModeVisibility();
  saveSettings();
});
bindSliderNumber(timestretchTargetBpmInput, timestretchTargetBpmNumber, (v) => {
  timestretchSettings.targetBpm = v;
  saveSettings();
});
bindSliderNumber(timestretchRatioInput, timestretchRatioNumber, (v) => {
  timestretchSettings.ratio = v / 100;
  saveSettings();
});
timestretchCharacterSelect.addEventListener("change", () => {
  timestretchSettings.character = timestretchCharacterSelect.value;
  updateCharacterUI();
  saveSettings();
});

/**
 * Simple is a clean pass, always: original tempo, no output character, nothing coloured.
 *
 * It would be surprising for a density toggle to silently keep applying a lo-fi chain you
 * configured in Advanced and can no longer see. So rather than resetting those settings (which
 * would lose them), Simple bypasses the whole effects chain and Advanced restores it. Every
 * effects decision funnels through here: stretch ratio, lo-fi enablement, and the settings
 * snapshot handed to the worker.
 */
function effectsEnabled() {
  return task !== "chop";
}

/** ratio to pass to stretchChannels for this file, or 1 (no-op) if stretching doesn't apply. */
function resolveStretchRatio(detectedBpm) {
  if (!effectsEnabled()) return 1;
  if (!stretchEffectivelyEnabled()) return 1;
  if (timestretchSettings.mode === "fixed-ratio") return timestretchSettings.ratio;
  return detectedBpm ? ratioForTargetTempo(detectedBpm, timestretchSettings.targetBpm) : 1;
}

// ---------------------------------------------------------------------------
// Lo-fi processing: output-stage character, drive (saturation), crunch
// (bitcrush / sample-rate reduction) - applied in that order, same export
// scope as time-stretch (main chops + the full-file wav/ copy, not one-shots).
// ---------------------------------------------------------------------------

for (const stage of OUTPUT_STAGES) {
  if (stage.key === "clean") continue; // the enable checkbox is the off switch; no need for a "clean" entry in the select
  const opt = document.createElement("option");
  opt.value = stage.key;
  opt.textContent = `${stage.label} - ${stage.description}`;
  outputstageModeSelect.appendChild(opt);
}
outputstageModeSelect.value = outputStageSettings.mode;

for (const d of DRIVE_TYPES) {
  const opt = document.createElement("option");
  opt.value = d.key;
  opt.textContent = `${d.label} - ${d.description}`;
  driveTypeSelect.appendChild(opt);
}
driveTypeSelect.value = driveSettings.type;

outputstageEnableCheckbox.addEventListener("change", () => {
  outputStageSettings.enabled = outputstageEnableCheckbox.checked;
  outputstageOptions.hidden = !outputStageSettings.enabled;
  saveSettings();
});
outputstageModeSelect.addEventListener("change", () => {
  outputStageSettings.mode = outputstageModeSelect.value;
  saveSettings();
});
bindSliderNumber(outputstageMixSlider, outputstageMixNumber, (v) => {
  outputStageSettings.mixPct = v;
  saveSettings();
});
bindSliderNumber(outputstageIntensitySlider, outputstageIntensityNumber, (v) => {
  outputStageSettings.intensityPct = v;
  saveSettings();
});

driveEnableCheckbox.addEventListener("change", () => {
  driveSettings.enabled = driveEnableCheckbox.checked;
  driveOptions.hidden = !driveSettings.enabled;
  saveSettings();
});
driveTypeSelect.addEventListener("change", () => {
  driveSettings.type = driveTypeSelect.value;
  saveSettings();
});
bindSliderNumber(driveAmountSlider, driveAmountNumber, (v) => {
  driveSettings.amountPct = v;
  saveSettings();
});

crunchEnableCheckbox.addEventListener("change", () => {
  crunchSettings.enabled = crunchEnableCheckbox.checked;
  crunchOptions.hidden = !crunchSettings.enabled;
  saveSettings();
});
bindSliderNumber(crunchBitsSlider, crunchBitsNumber, (v) => {
  crunchSettings.bits = v;
  saveSettings();
});
bindSliderNumber(crunchRateSlider, crunchRateNumber, (v) => {
  crunchSettings.rateDivide = v;
  saveSettings();
});
oneshotProcessingCheckbox.addEventListener("change", () => {
  applyProcessingToOneShots = oneshotProcessingCheckbox.checked;
  saveSettings();
});
keepCleanCopyCheckbox.addEventListener("change", () => {
  keepUnprocessedCopy = keepCleanCopyCheckbox.checked;
  saveSettings();
});

/** true if any lo-fi stage is switched on, and effects apply at all (see effectsEnabled). */
function lofiActive() {
  if (!effectsEnabled()) return false;
  return outputStageSettings.enabled || driveSettings.enabled || crunchSettings.enabled;
}

/**
 * Plain snapshot of the current lo-fi settings, safe to structured-clone into a worker message.
 * Forced to all-off when effects are bypassed - the worker only sees this snapshot, so gating
 * lofiActive() alone would still let a stale "enabled" flag colour the audio in Simple.
 */
function lofiSettingsSnapshot() {
  if (!effectsEnabled()) {
    return {
      outputStage: { ...outputStageSettings, enabled: false },
      drive: { ...driveSettings, enabled: false },
      crunch: { ...crunchSettings, enabled: false },
    };
  }
  return { outputStage: { ...outputStageSettings }, drive: { ...driveSettings }, crunch: { ...crunchSettings } };
}

/** Runs the enabled lo-fi stages (current settings) over a set of channels - thin wrapper around
 * the pure, worker-shareable applyLofiChain in outputstage.js. Used by the main-thread fallback
 * path; the worker calls the pure version directly with the same snapshot. */
function applyLofiChain(channels, sampleRate) {
  return applyLofiChainPure(channels, sampleRate, lofiSettingsSnapshot());
}

// ---------------------------------------------------------------------------
// Settings persistence (this browser only - a light convenience, not sync)
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
        chopIntoPieces,
        naming: namingSettings,
        exportSettings,
        detectSettings,
        timestretch: timestretchSettings,
        outputStage: outputStageSettings,
        drive: driveSettings,
        crunch: crunchSettings,
        applyProcessingToOneShots,
        keepUnprocessedCopy,
        splitSubfolders: splitSubfoldersCheckbox.checked,
      })
    );
  } catch (_) {
    /* best-effort only - private browsing, storage disabled, quota, etc. */
  }
  // Every settings mutation in this file funnels through here, which makes this the one place that
  // needs to know "did something that would change a stretch render just happen" - see
  // refreshStretchStaleIndicator(). Cheap (a string compare, no waveform rebuild) and a no-op
  // outside the STRETCH task.
  refreshStretchStaleIndicator();
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Task: CHOP / STRETCH / BOTH
//
// This replaced a Simple/Advanced toggle, which was the wrong axis. Simple/Advanced described how
// much of the UI you could see; it said nothing about what you came to do, it buried time-stretch
// as an optional panel inside a mode called "Advanced", and it made "Advanced" mean two unrelated
// things at once - reveal the settings AND switch the effects chain on. That conflation is why
// Simple needed a special rule to bypass effects.
//
// Task is the honest axis, and it maps onto state the app already had:
//
//   CHOP    cut it up, no processing        chopIntoPieces = true,  effects off
//   STRETCH process it whole, no cutting    chopIntoPieces = false, effects on
//   BOTH    everything                      chopIntoPieces = true,  effects on
//
// So there is no "bypass" special case any more: under CHOP there is simply no stretch stage.
// Each settings section declares which tasks it belongs to via data-tasks, and irrelevant ones
// are unmounted rather than shown-but-meaningless.
// ---------------------------------------------------------------------------

const TASK_STORAGE_KEY = "good-bits-task-v1";
const TASKS = ["chop", "stretch", "both"];
let task = "chop";

function applyTask(next, { persist = true } = {}) {
  task = TASKS.includes(next) ? next : "chop";
  document.documentElement.setAttribute("data-task", task);
  chopIntoPieces = task !== "stretch";
  taskSwitcherBtns.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.taskChoice === task);
  });
  updateDrumOptionsVisibility();
  updateNamingPreview();
  updateStretchTaskVisibility();
  updateStretchWorkspaceVisibility();
  if (task === "stretch") {
    renderStretchCharacterBrowser();
    renderStretchFileStrip();
    renderStretchActivePanes();
  } else {
    // Leaving STRETCH (or never having been there) - nothing in the workspace should keep sounding.
    stretchWorkspace.stopAllPlayback();
  }
  if (persist) {
    try {
      localStorage.setItem(TASK_STORAGE_KEY, task);
    } catch (_) {
      /* best-effort only */
    }
  }
  // Canvas-drawn waveforms don't reflow for free when the layout around them changes.
  requestAnimationFrame(repaintForTheme);
}

function loadTask() {
  try {
    return localStorage.getItem(TASK_STORAGE_KEY) || "chop";
  } catch (_) {
    return "chop";
  }
}

taskSwitcherBtns.forEach((btn) => {
  btn.addEventListener("click", () => applyTask(btn.dataset.taskChoice));
});

// The settings rail is disclosure, kept separate from task. It opens by default for every task -
// closing it used to be the default for CHOP/STRETCH, which hid controls (source material,
// naming, export settings) a first-time visitor had no way to know were there. It's still just a
// toggle: closing it is one click away, and the choice is remembered per-browser from then on.
const RAIL_STORAGE_KEY = "good-bits-rail-v1";

function applyRail(open, { persist = true } = {}) {
  document.documentElement.setAttribute("data-rail", open ? "open" : "closed");
  settingsToggleBtn.classList.toggle("is-active", open);
  settingsToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
  if (persist) {
    try {
      localStorage.setItem(RAIL_STORAGE_KEY, open ? "open" : "closed");
    } catch (_) {
      /* best-effort only */
    }
  }
  requestAnimationFrame(repaintForTheme);
}

function railIsOpen() {
  return document.documentElement.getAttribute("data-rail") === "open";
}

settingsToggleBtn.addEventListener("click", () => applyRail(!railIsOpen()));

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
  // chopIntoPieces is no longer stored: it is derived from the task, so a stale saved value would
  // fight applyTask() on load.
  if (saved.naming) {
    const mergedNaming = { ...saved.naming };
    delete mergedNaming.maxLen; // no longer a setting - drop it if present from an older save
    if (mergedNaming.chopPattern && LEGACY_PATTERN_MAP[mergedNaming.chopPattern]) {
      mergedNaming.chopPattern = LEGACY_PATTERN_MAP[mergedNaming.chopPattern];
    }
    Object.assign(namingSettings, mergedNaming);
    namingPatternInput.value = namingSettings.chopPattern;
    namingSeparatorSelect.value = namingSettings.separator;
    namingFolderTagCheckbox.checked = namingSettings.includeFolderTag;
  }
  if (saved.exportSettings) {
    Object.assign(exportSettings, saved.exportSettings);
    bitDepthSelect.value = String(exportSettings.bitDepth);
    fadeMsSlider.value = fadeMsNumber.value = String(exportSettings.fadeMs);
    zcMsSlider.value = zcMsNumber.value = String(exportSettings.zcSearchMs);
  }
  if (saved.detectSettings) {
    Object.assign(detectSettings, saved.detectSettings);
    detectKeyCheckbox.checked = detectSettings.key;
    detectTempoCheckbox.checked = detectSettings.tempo;
  }
  if (typeof saved.splitSubfolders === "boolean") {
    splitSubfoldersCheckbox.checked = saved.splitSubfolders;
  }
  if (saved.timestretch) {
    Object.assign(timestretchSettings, saved.timestretch);
    timestretchEnableCheckbox.checked = timestretchSettings.enabled;
    updateStretchTaskVisibility();
    timestretchModeSelect.value = timestretchSettings.mode;
    timestretchTargetBpmInput.value = timestretchTargetBpmNumber.value = String(timestretchSettings.targetBpm);
    timestretchRatioInput.value = timestretchRatioNumber.value = String(Math.round(timestretchSettings.ratio * 100));
    timestretchCharacterSelect.value = timestretchSettings.character;
    // A character id this version no longer recognises (stale save, hand-edited localStorage) leaves
    // the <select> with nothing chosen - fall back to "clean" in both the setting and the control
    // rather than silently rendering an empty dropdown. resolveCharacter() already falls back the
    // same way for the DSP side, so this just keeps the UI in sync with what would actually render.
    if (timestretchCharacterSelect.value !== timestretchSettings.character) {
      timestretchSettings.character = "clean";
      timestretchCharacterSelect.value = "clean";
    }
    updateTimestretchModeVisibility();
    updateCharacterUI();
  }
  if (saved.outputStage) {
    Object.assign(outputStageSettings, saved.outputStage);
    outputstageEnableCheckbox.checked = outputStageSettings.enabled;
    outputstageOptions.hidden = !outputStageSettings.enabled;
    outputstageModeSelect.value = outputStageSettings.mode;
    outputstageMixSlider.value = outputstageMixNumber.value = String(outputStageSettings.mixPct);
    outputstageIntensitySlider.value = outputstageIntensityNumber.value = String(outputStageSettings.intensityPct);
  }
  if (saved.drive) {
    Object.assign(driveSettings, saved.drive);
    driveEnableCheckbox.checked = driveSettings.enabled;
    driveOptions.hidden = !driveSettings.enabled;
    driveTypeSelect.value = driveSettings.type;
    driveAmountSlider.value = driveAmountNumber.value = String(driveSettings.amountPct);
  }
  if (saved.crunch) {
    Object.assign(crunchSettings, saved.crunch);
    crunchEnableCheckbox.checked = crunchSettings.enabled;
    crunchOptions.hidden = !crunchSettings.enabled;
    crunchBitsSlider.value = crunchBitsNumber.value = String(crunchSettings.bits);
    crunchRateSlider.value = crunchRateNumber.value = String(crunchSettings.rateDivide);
  }
  if (typeof saved.applyProcessingToOneShots === "boolean") {
    applyProcessingToOneShots = saved.applyProcessingToOneShots;
    oneshotProcessingCheckbox.checked = applyProcessingToOneShots;
  }
  if (typeof saved.keepUnprocessedCopy === "boolean") {
    keepUnprocessedCopy = saved.keepUnprocessedCopy;
    keepCleanCopyCheckbox.checked = keepUnprocessedCopy;
  }
  updateDrumOptionsVisibility();
  // applyTask() (which runs before this, in init()) already rendered the character browser once
  // with whatever timestretchSettings held at the time - defaults, for a returning visitor, since
  // saved.timestretch is merged in above. Re-render now that it reflects the actual saved settings.
  if (task === "stretch") {
    renderStretchCharacterBrowser();
    updateStretchDetectedReadouts();
  }
}

// ---------------------------------------------------------------------------
// Folder queue UI
// ---------------------------------------------------------------------------

function renderFolderList() {
  folderList.innerHTML = "";
  if (sourceFolders.length === 0 && pendingReconnectFolders.length === 0) {
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
      ? `${folder.files.length} file(s) - output goes to ${folder.destinationLabel || "a chosen folder"}`
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
      if (folder.kind === "fsa" && !folder.isLoose) forgetFolder(folder.name);
      renderFolderList();
      updateProcessButton();
    });

    row.appendChild(info);
    row.appendChild(removeBtn);
    folderList.appendChild(row);
  }

  // Folders remembered from a previous session, waiting on a user-gesture click to re-grant
  // permission (browsers never persist the permission grant itself, only the handle).
  for (const pending of pendingReconnectFolders) {
    const row = document.createElement("div");
    row.className = "folder-row folder-row--pending";

    const info = document.createElement("div");
    info.className = "folder-row-info";
    const nameEl = document.createElement("div");
    nameEl.className = "folder-row-name";
    nameEl.textContent = pending.name;
    const countEl = document.createElement("div");
    countEl.className = "folder-row-count";
    countEl.textContent = "Remembered from a previous session - reconnect to use it again";
    info.appendChild(nameEl);
    info.appendChild(countEl);

    const actions = document.createElement("div");
    actions.className = "folder-row-pending-actions";
    const reconnectBtn = document.createElement("button");
    reconnectBtn.className = "btn btn--ghost btn--small";
    reconnectBtn.textContent = "Reconnect";
    reconnectBtn.addEventListener("click", async () => {
      reconnectBtn.disabled = true;
      reconnectBtn.textContent = "Reconnecting…";
      try {
        const ok = await ensureReadWritePermission(pending.handle);
        if (ok) {
          const wasEmpty = sourceFolders.length === 0;
          const idx = pendingReconnectFolders.indexOf(pending);
          if (idx >= 0) pendingReconnectFolders.splice(idx, 1);
          if (!folderAlreadyQueued(pending.name)) {
            const files = await collectAudioFilesFSA(pending.handle);
            sourceFolders.push({ id: nextFolderId++, name: pending.name, kind: "fsa", handle: pending.handle, files });
          }
          renderFolderList();
          updateProcessButton();
          maybeAutoProcessInitialBatch(wasEmpty);
        } else {
          reconnectBtn.disabled = false;
          reconnectBtn.textContent = "Reconnect";
          log(`Permission for "${pending.name}" was denied - try again, or remove it below.`);
        }
      } catch (err) {
        reconnectBtn.disabled = false;
        reconnectBtn.textContent = "Reconnect";
        log(`Couldn't reconnect "${pending.name}": ${err.message || err}`);
      }
    });
    const forgetBtn = document.createElement("button");
    forgetBtn.className = "btn btn--icon";
    forgetBtn.textContent = "×";
    forgetBtn.title = "Forget this folder";
    forgetBtn.addEventListener("click", () => {
      const idx = pendingReconnectFolders.indexOf(pending);
      if (idx >= 0) pendingReconnectFolders.splice(idx, 1);
      forgetFolder(pending.name);
      renderFolderList();
    });
    actions.appendChild(reconnectBtn);
    actions.appendChild(forgetBtn);

    row.appendChild(info);
    row.appendChild(actions);
    folderList.appendChild(row);
  }
  updateStretchWorkspaceVisibility();
  // Keeps the workspace's file strip live even before Process runs: a newly-added file appears
  // immediately (as not-yet-processed), and a removed folder's files disappear from it too.
  rebuildStretchFileOrder();
  if (task === "stretch") {
    renderStretchFileStrip();
    renderStretchActivePanes();
  }
}

function updateProcessButton() {
  processBtn.disabled = processing || sourceFolders.length === 0;
  previewBtn.disabled = processing || sourceFolders.length === 0;
  cancelBtn.hidden = !processing;
}

/**
 * Runs a non-destructive Process pass the moment the batch goes from completely empty to holding
 * its first audio, so a new user sees chops/waveforms without a separate "now click Process" step.
 * Gated on `wasEmpty` (the queue's state *before* this add) rather than just "queue non-empty" so
 * it only ever fires on that one transition - adding a second folder, or files to an
 * already-processed batch, never re-triggers this, which is what keeps it from clobbering manual
 * edits sitting in analysisCache/the editor for files already on screen. Safe by construction: with
 * nothing in the queue before, there is by definition no analysis or editor state yet to lose.
 */
function maybeAutoProcessInitialBatch(wasEmpty) {
  if (!wasEmpty || processing || sourceFolders.length === 0) return;
  processBatch({ write: false });
}

function folderAlreadyQueued(name) {
  return sourceFolders.some((f) => f.kind === "fsa" && !f.isLoose && f.name === name);
}

/** Drops a name from the "needs reconnect" list, e.g. because it was just added normally instead. */
function clearPendingReconnect(name) {
  const idx = pendingReconnectFolders.findIndex((p) => p.name === name);
  if (idx >= 0) pendingReconnectFolders.splice(idx, 1);
}

/** providedHandle: when set (a folder dropped via drag-and-drop), skip the picker and use this
 * handle directly, but first make sure it actually has readwrite permission - a handle obtained
 * from a drop starts read-only in some browsers, unlike one from showDirectoryPicker(). autoProcess:
 * false lets the drop handler suppress this function's own auto-process trigger so it can apply its
 * own combined logic instead (see the drop handler - dropping into CHOP has its own long-standing
 * "just do it" full export, which would otherwise race with this). */
async function addFolderFSA(providedHandle, { autoProcess = true } = {}) {
  const handle = providedHandle || (await pickFolderFSA());
  if (!handle) return;
  if (providedHandle) {
    const ok = await ensureReadWritePermission(handle);
    if (!ok) {
      log(`Permission to write to "${handle.name}" was denied.`);
      return;
    }
  }
  const wasEmpty = sourceFolders.length === 0;

  if (splitSubfoldersCheckbox.checked) {
    const children = await discoverImmediateSourceChildren(handle);
    if (children.length > 0) {
      let added = 0;
      for (const child of children) {
        if (folderAlreadyQueued(child.name)) continue;
        const files = await collectAudioFilesFSA(child.handle);
        sourceFolders.push({ id: nextFolderId++, name: child.name, kind: "fsa", handle: child.handle, files });
        rememberFolder(child.name, child.handle);
        clearPendingReconnect(child.name);
        added++;
      }
      log(`Added ${added} subfolder(s) from "${handle.name}" as separate sources.`);
      renderFolderList();
      updateProcessButton();
      if (autoProcess) maybeAutoProcessInitialBatch(wasEmpty);
      return;
    }
    // No qualifying subfolders - fall through and treat the picked folder itself as one source.
  }

  if (folderAlreadyQueued(handle.name)) {
    log(`"${handle.name}" is already in the queue.`);
    return;
  }
  const files = await collectAudioFilesFSA(handle);
  sourceFolders.push({ id: nextFolderId++, name: handle.name, kind: "fsa", handle, files });
  rememberFolder(handle.name, handle);
  clearPendingReconnect(handle.name);
  renderFolderList();
  updateProcessButton();
  if (autoProcess) maybeAutoProcessInitialBatch(wasEmpty);
}

function addFolderLegacy() {
  legacyFolderInput.value = "";
  legacyFolderInput.click();
}

legacyFolderInput.addEventListener("change", () => {
  const wasEmpty = sourceFolders.length === 0;
  const groups = collectAudioFilesLegacy(legacyFolderInput.files, { splitSubfolders: splitSubfoldersCheckbox.checked });
  for (const g of groups) {
    sourceFolders.push({ id: nextFolderId++, name: g.rootName, kind: "legacy", files: g.files });
  }
  renderFolderList();
  updateProcessButton();
  maybeAutoProcessInitialBatch(wasEmpty);
});

/** providedHandles: when set (files dropped via drag-and-drop), skip the picker and use these
 * file handles directly - a dropped file's read permission is already implied by the drop itself.
 * autoProcess: see addFolderFSA - false lets the drop handler apply its own combined logic. */
async function addIndividualFilesFSA(providedHandles, { autoProcess = true } = {}) {
  const handles = providedHandles || (await pickFilesFSA());
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

  const wasEmpty = sourceFolders.length === 0;
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
  if (autoProcess) maybeAutoProcessInitialBatch(wasEmpty);
}

function addIndividualFilesLegacy() {
  legacyFilesInput.value = "";
  legacyFilesInput.click();
}

legacyFilesInput.addEventListener("change", () => {
  if (legacyFilesInput.files.length === 0) return;
  const wasEmpty = sourceFolders.length === 0;
  looseFileGroupCounter++;
  const group = collectIndividualFilesLegacy(legacyFilesInput.files, `Individual files ${looseFileGroupCounter}`);
  sourceFolders.push({ id: nextFolderId++, name: group.rootName, kind: "legacy", isLoose: true, files: group.files });
  renderFolderList();
  updateProcessButton();
  maybeAutoProcessInitialBatch(wasEmpty);
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

// ---------------------------------------------------------------------------
// Drag-and-drop: drop a folder or files anywhere on "2. Source folders & files" to add them,
// same effect as clicking "+ Add Source Folder" / "+ Add Individual Files". Two paths depending
// on what the browser can hand back from the drop itself: DataTransferItem.getAsFileSystemHandle()
// (Chrome/Edge) gives real read-write-capable handles, so a dropped folder gets written straight
// back into like any other FSA folder; everywhere else falls back to the older
// webkitGetAsEntry() entry-walk, which only ever produces a ZIP-fallback (read-only) source - see
// collectDroppedFolderLegacy in io-fs.js.
// ---------------------------------------------------------------------------

const folderDropZone = $("#folder-drop-zone");

["dragenter", "dragover"].forEach((evtName) => {
  folderDropZone.addEventListener(evtName, (ev) => {
    if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types || []).includes("Files")) return;
    ev.preventDefault();
    folderDropZone.classList.add("is-dragover");
  });
});
["dragleave", "dragend"].forEach((evtName) => {
  folderDropZone.addEventListener(evtName, (ev) => {
    if (evtName === "dragleave" && ev.relatedTarget && folderDropZone.contains(ev.relatedTarget)) return;
    folderDropZone.classList.remove("is-dragover");
  });
});

folderDropZone.addEventListener("drop", async (ev) => {
  if (!ev.dataTransfer) return;
  ev.preventDefault();
  folderDropZone.classList.remove("is-dragover");

  const items = ev.dataTransfer.items;
  if (!items || items.length === 0) return;
  const wasEmpty = sourceFolders.length === 0;

  // Handles/entries must be grabbed synchronously from the live DataTransferItemList, before any
  // await - it can be invalidated once the event handler yields.
  const fsaHandlePromises = [];
  const legacyEntries = [];
  let anyFsaCapableItem = false;
  for (const item of items) {
    if (item.kind !== "file") continue;
    if (FSA_SUPPORTED && typeof item.getAsFileSystemHandle === "function") {
      anyFsaCapableItem = true;
      fsaHandlePromises.push(item.getAsFileSystemHandle());
    } else if (typeof item.webkitGetAsEntry === "function") {
      const entry = item.webkitGetAsEntry();
      if (entry) legacyEntries.push(entry);
    }
  }

  try {
    if (anyFsaCapableItem) {
      const handles = (await Promise.all(fsaHandlePromises)).filter(Boolean);
      for (const dir of handles.filter((h) => h.kind === "directory")) {
        // autoProcess: false - this handler applies its own combined logic below, once every
        // dropped item has been added, rather than each call racing to trigger it independently.
        await addFolderFSA(dir, { autoProcess: false });
      }
      const fileHandles = handles.filter((h) => h.kind === "file");
      if (fileHandles.length > 0) await addIndividualFilesFSA(fileHandles, { autoProcess: false });
    } else if (legacyEntries.length > 0) {
      for (const dirEntry of legacyEntries.filter((e) => e.isDirectory)) {
        const groups = await collectDroppedFolderLegacy(dirEntry, { splitSubfolders: splitSubfoldersCheckbox.checked });
        for (const g of groups) {
          sourceFolders.push({ id: nextFolderId++, name: g.rootName, kind: "legacy", files: g.files });
        }
      }
      const fileEntries = legacyEntries.filter((e) => e.isFile);
      if (fileEntries.length > 0) {
        const files = await Promise.all(fileEntries.map((e) => new Promise((resolve, reject) => e.file(resolve, reject))));
        looseFileGroupCounter++;
        const group = collectIndividualFilesLegacy(files, `Individual files ${looseFileGroupCounter}`);
        sourceFolders.push({ id: nextFolderId++, name: group.rootName, kind: "legacy", isLoose: true, files: group.files });
      }
      renderFolderList();
      updateProcessButton();
    }
  } catch (err) {
    log(`Couldn't add the dropped item(s): ${err.message || err}`);
    console.error(err);
    return;
  }

  // Simple mode's whole pitch is "drop it and it's done" - a drop (as opposed to the Add
  // buttons) commits to running right away, using whatever's currently in the batch queue.
  // Dropping into CHOP is the "just do it" path, so it runs straight away (a full Export, not just
  // a preview). Every other case - STRETCH/BOTH drops, and any drop that isn't the very first
  // content this batch has seen - falls back to the same safe initial-Process-only behaviour as
  // the Add buttons (see maybeAutoProcessInitialBatch).
  if (task === "chop" && !processing && sourceFolders.length > 0) {
    processBatch();
  } else {
    maybeAutoProcessInitialBatch(wasEmpty);
  }
});

clearFoldersBtn.addEventListener("click", () => {
  sourceFolders.length = 0;
  pendingReconnectFolders.length = 0;
  looseDestinationHandle = null;
  forgetAllFolders();
  invalidateAnalysis();
  // renderFolderList() also calls updateStretchWorkspaceVisibility() (stops any preview playback and
  // hides the workspace, since sourceFolders is now empty) and rebuildStretchFileOrder() (empties the
  // file strip and clears stretchActiveKey, since there's nothing left to point at).
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
// Heavy-DSP worker: WSOLA stretch + the lo-fi chain + fades + WAV encode for a batch of
// already-sliced regions, run off the main thread so a big export doesn't freeze the page. Falls
// back to running the exact same pure functions inline on the main thread if a worker can't be
// created at all (very old browsers, or the page opened the unsupported file:// way).
// ---------------------------------------------------------------------------

let heavyDspWorker = null;
let heavyDspWorkerBroken = false;
let heavyDspRequestId = 0;
const heavyDspPending = new Map();

function getHeavyDspWorker() {
  if (heavyDspWorker || heavyDspWorkerBroken) return heavyDspWorker;
  try {
    heavyDspWorker = new Worker(new URL("./heavy-dsp-worker.js", import.meta.url), { type: "module" });
    heavyDspWorker.addEventListener("message", (ev) => {
      const { type, requestId } = ev.data || {};
      const pending = heavyDspPending.get(requestId);
      if (!pending) return;
      heavyDspPending.delete(requestId);
      if (type === "processRegionsResult") pending.resolve(ev.data.results);
      else pending.reject(new Error(ev.data.message || "worker error"));
    });
    heavyDspWorker.addEventListener("error", (ev) => {
      // A broken worker (failed to load its module, etc.) fails every request that's still
      // outstanding, then this whole session falls back to the main thread from here on.
      for (const pending of heavyDspPending.values()) pending.reject(new Error(ev.message || "worker error"));
      heavyDspPending.clear();
      heavyDspWorkerBroken = true;
      heavyDspWorker = null;
    });
  } catch (err) {
    heavyDspWorkerBroken = true;
    heavyDspWorker = null;
  }
  return heavyDspWorker;
}

/** Runs the worker's processRegions op, or the same logic inline on the main thread as a fallback. */
async function processRegionsHeavy({ sampleRate, bitDepth, fadeInSamples, fadeOutSamples, stretchRatio, character, macroValues, seed, regions }) {
  const lofi = lofiSettingsSnapshot();
  const worker = getHeavyDspWorker();
  if (worker) {
    try {
      const transferList = regions.flatMap((r) => r.channels.map((ch) => ch.buffer));
      return await new Promise((resolve, reject) => {
        const requestId = ++heavyDspRequestId;
        heavyDspPending.set(requestId, { resolve, reject });
        worker.postMessage({ type: "processRegions", requestId, sampleRate, bitDepth, fadeInSamples, fadeOutSamples, stretchRatio, character, macroValues, seed, lofi, regions }, transferList);
      });
    } catch (err) {
      console.error("heavy-dsp-worker failed, falling back to the main thread for the rest of this session:", err);
      heavyDspWorkerBroken = true;
      heavyDspWorker = null;
    }
  }

  // Main-thread fallback - identical logic to heavy-dsp-worker.js's onmessage handler.
  return regions.map(({ channels }) => {
    let sliced = channels;
    if (stretchRatio && stretchRatio !== 1) {
      sliced = stretchChannels(sliced, sampleRate, stretchRatio, character, { macroValues, seed });
    }
    sliced = applyLofiChainPure(sliced, sampleRate, lofi);
    applyFades(sliced, fadeInSamples || 0, fadeOutSamples || 0);
    const blob = encodeWav(sliced, sampleRate, bitDepth);
    return { blob, seconds: sliced[0].length / sampleRate };
  });
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
  // Preview runs the entire pipeline and skips exactly one thing: this. Every blob is still
  // produced, so the results panel gets real audio to audition and real waveforms to edit -
  // nothing reaches the disk until Export. This is the only place the app writes audio, which
  // is what makes the dry run trustworthy rather than a best-effort imitation.
  if (dryRun) return;
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
  // every numbered chop - see the "Output naming" panel for the options.
  // A valid cache entry means Preview already ran essentia over this file and nothing that would
  // move a cut point has changed since, so Export reuses that work instead of repeating it.
  const cached = cachedAnalysis(folder, fileInfo);
  const wantKey = detectSettings.key;
  const wantTempo = detectSettings.tempo;
  const kt = cached ? cached.kt : await analyzeKeyAndTempo(mono, buffer.sampleRate, { key: wantKey, tempo: wantTempo });
  if (cached) log(`    reusing the analysis from the last run`);
  const tag = buildKeyTempoTag(kt, namingSettings.separator);
  const taggedStem = buildTaggedStem(stem, tag);

  const keyText = kt.key ? `${kt.key} ${kt.scale || ""}`.trim() : kt.available ? "unknown" : "unavailable";
  const bpmText = kt.bpm ? `${Math.round(kt.bpm)} BPM` : kt.available ? "unclear" : "unavailable";

  if (chopIntoPieces && mode === "drums" && wantTempo && !kt.bpm) {
    const proceed = await resolveTempoWarning(fileInfo.name);
    if (!proceed) {
      log(`    skipped - no tempo detected`);
      renderSkippedFileResult(folderResultsEl, fileInfo.name, "no tempo detected");
      return 0;
    }
  }

  // Non-WAV sources get a full 24-bit WAV copy in wav/; true WAV sources are
  // analyzed and chopped in place, with nothing duplicated into wav/.
  if (fileInfo.ext !== ".wav") {
    const wavBlob = encodeWav(channels, buffer.sampleRate, 24);
    await writeOutput(folder, "wav", fileInfo.relativeDir, `${taggedStem}.wav`, wavBlob, zipBatch);
    log(`    converted to WAV (${method})`);
  }

  // Time-stretch and/or the lo-fi chain, when either is on, also produce a processed copy of the
  // FULL track (not just the chops) alongside the untouched original/converted wav/ copy above -
  // handy for dropping the whole recording into a sampler, or for using these stages standalone
  // with chopping turned off. Written regardless of source format or chopIntoPieces, since this is
  // a new derived file rather than a duplicate of the original.
  const fullStretchRatio = resolveStretchRatio(kt.bpm);
  const fullStretched = fullStretchRatio !== 1;
  const fullLofi = lofiActive();
  // STRETCH always needs this render for the workspace's Processed pane, even when it would end up
  // identical to Original (ratio 1, lo-fi off) - the whole point of the A/B view is showing that
  // clearly rather than showing nothing. CHOP/BOTH keep the original behaviour: only render (and
  // only ever write) a derived copy when it would actually differ from the source.
  let stretchProcessedForWorkspace = null;
  if (fullStretched || fullLofi || task === "stretch") {
    const [{ blob: derivedBlob }] = await processRegionsHeavy({
      sampleRate: buffer.sampleRate,
      bitDepth: 24,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      stretchRatio: fullStretchRatio,
      character: timestretchSettings.character,
      macroValues: timestretchSettings.macroValues,
      seed: timestretchSettings.seed,
      regions: [{ channels: channels.map((ch) => Float32Array.from(ch)) }],
    });
    if (fullStretched || fullLofi) {
      const derivedName = `${taggedStem}${fullStretched ? " stretched" : ""}${fullLofi ? " lofi" : ""}.wav`;
      await writeOutput(folder, "wav", fileInfo.relativeDir, derivedName, derivedBlob, zipBatch);
      log(`    wrote a full-length ${[fullStretched && "time-stretched", fullLofi && "lo-fi"].filter(Boolean).join(" + ")} copy`);
    }
    if (task === "stretch") {
      // Decoded back into raw samples for the workspace's waveform + playback - reuses the exact
      // WAV bytes Export would write rather than a second, possibly-diverging DSP path.
      const decoded = await getAudioContext().decodeAudioData(await derivedBlob.arrayBuffer());
      const processedChannels = bufferChannels(decoded);
      stretchProcessedForWorkspace = {
        mono: toMono(processedChannels),
        sampleRate: decoded.sampleRate,
        duration: decoded.length / decoded.sampleRate,
        characterLabel: resolveCharacter(timestretchSettings.character).label,
        ratio: fullStretchRatio,
        signature: currentStretchSignature(),
      };
    }
  }

  const editContext = { folder, fileInfo, stem, tag, taggedStem, detectedBpm: kt.bpm };
  let chopRows = [];
  let chopMarkers = [];
  let oneShotRows = [];
  let oneShotMarkers = [];

  let chopRegions = null;
  let chopRegionsBaseline = null;
  let oneShotRegions = null;
  let oneShotRegionsBaseline = null;

  if (chopIntoPieces) {
    const modeParams = activeParams();
    let regions;
    if (cached && cached.chopRegions) {
      // The current canonical regions, including any manual edit or re-chop made since the last
      // fresh detection - reused as-is rather than re-detected, and NOT a new baseline.
      regions = cached.chopRegions;
      chopRegionsBaseline = cached.chopRegionsBaseline || regions.map((r) => [...r]);
    } else if (mode === "drums") {
      regions = computeDrumRegions(mono, buffer.sampleRate, drumBars, kt.bpm);
    } else {
      regions = phraseRegions(mono, buffer.sampleRate, modeParams[mode]).regions;
    }
    chopRegions = regions;
    if (!chopRegionsBaseline) chopRegionsBaseline = regions.map((r) => [...r]);

    log(`    key: ${keyText} | tempo: ${bpmText} | ${regions.length} candidate phrase(s)`);

    ({ chopRows, chopMarkers } = await exportChopsForRegions({
      folder,
      fileInfo,
      regions,
      stem,
      tag,
      taggedStem,
      buffer,
      channels,
      mono,
      zipBatch,
      detectedBpm: kt.bpm,
    }));

    log(`    created ${chopRows.length} chop(s)`);

    // A file's one-shots can be dropped individually from the preview, for when the extraction
    // found nothing worth keeping on that particular break.
    const includeOneShots = !cached || cached.includeOneShots !== false;
    if (mode === "drums" && extractOneShots && includeOneShots) {
      if (cached && cached.oneShotRegions) {
        oneShotRegions = cached.oneShotRegions;
        oneShotRegionsBaseline = cached.oneShotRegionsBaseline || oneShotRegions.map((r) => [...r]);
      } else {
        oneShotRegions = detectOneShotRegions(mono, buffer.sampleRate);
        oneShotRegionsBaseline = oneShotRegions.map((r) => [...r]);
      }
      const extracted = await writeOneShotRegions({
        folder,
        fileInfo,
        taggedStem,
        regions: oneShotRegions,
        channels,
        mono,
        sampleRate: buffer.sampleRate,
        zipBatch,
        detectedBpm: kt.bpm,
      });
      oneShotRows = extracted.rows;
      oneShotMarkers = extracted.markers;
      log(`    extracted ${oneShotRows.length} one-shot hit(s)`);
    } else if (mode === "drums" && extractOneShots) {
      log(`    one-shots excluded for this file`);
    }
  } else {
    log(`    key: ${keyText} | tempo: ${bpmText} | chop into pieces is off - whole file processed`);
  }

  // Remember what this run worked out. This is the canonical region state: the editor writes
  // every edit straight back in here (see mountEditor's onChange in renderFileResult), so Export
  // always cuts where the editor currently shows, with no separate "commit" step required.
  // *RegionsBaseline is a separate, edit-proof snapshot of the last fresh detection/re-chop, kept
  // only so Revert has something honest to revert to.
  const key = analysisKey(folder, fileInfo);
  const previous = analysisCache.get(key);
  analysisCache.set(key, {
    signature: detectionSignature(),
    kt,
    chopRegions,
    chopRegionsBaseline,
    oneShotRegions: oneShotRegions || (previous && previous.oneShotRegions) || null,
    oneShotRegionsBaseline: oneShotRegionsBaseline || (previous && previous.oneShotRegionsBaseline) || null,
    includeOneShots: previous ? previous.includeOneShots !== false : true,
    // Only ever freshly computed for the STRETCH task (see above) - a CHOP/BOTH run for this same
    // file doesn't touch either of these, same fallback pattern as oneShotRegions above. Without the
    // fallback, switching to CHOP/BOTH and hitting Process would silently wipe out whatever the
    // Stretch workspace had already shown for this file, even though nothing about the stretch
    // render actually changed.
    stretchOriginal:
      task === "stretch"
        ? { mono, sampleRate: buffer.sampleRate, duration: mono.length / buffer.sampleRate, bpmText, keyText }
        : (previous && previous.stretchOriginal) || null,
    stretchProcessed: task === "stretch" ? stretchProcessedForWorkspace : (previous && previous.stretchProcessed) || null,
  });

  if (task === "stretch") {
    // No chop-oriented card for this task any more - the workspace (file strip + Original/Processed)
    // is the whole UI. See js/stretch-workspace.js and the "Stretch workspace" section above.
    if (!stretchActiveKey) stretchActiveKey = key;
    renderStretchFileStrip();
    if (stretchActiveKey === key) renderStretchActivePanes();
    return 0;
  }

  const state = {
    fileName: fileInfo.name,
    keyText,
    bpmText,
    chopRows,
    chopMarkers,
    oneShotRows,
    oneShotMarkers,
    chopSkipped: !chopIntoPieces,
    peaks: computePeaks(mono, 400),
    duration: mono.length / buffer.sampleRate,
    mono,
    sampleRate: buffer.sampleRate,
    editContext,
    analysisKey: key,
    hasOneShots: mode === "drums" && extractOneShots,
  };
  const block = renderFileResult(state);
  folderResultsEl.appendChild(block);
  return chopRows.length;
}

/**
 * Writes chops for a set of [start,end] second regions against an already-decoded file, applying
 * zero-crossing snap, optional time-stretch (main chops only), and fades. Shared by the initial
 * auto-detected pass and by the manual chop editor's "Save & re-export".
 */
async function exportChopsForRegions({ folder, fileInfo, regions, stem, tag, taggedStem, buffer, channels, mono, zipBatch, detectedBpm }) {
  const relPath = `${fileInfo.relativeDir ? fileInfo.relativeDir + "/" : ""}${taggedStem}`;
  const fadeInSamples = Math.round((exportSettings.fadeMs / 1000) * buffer.sampleRate);
  const fadeOutSamples = fadeInSamples;
  const zcWindow = Math.round((exportSettings.zcSearchMs / 1000) * buffer.sampleRate);
  const stretchRatio = resolveStretchRatio(detectedBpm);
  const processingActive = stretchRatio !== 1 || lofiActive();
  const wantCleanCopy = keepUnprocessedCopy && processingActive;

  // Deleting the previous run's chops is a write too, so a preview must not do it either.
  if (folder.kind === "fsa" && !dryRun) {
    await clearOldChopsFSA(folder.handle, fileInfo.relativeDir, taggedStem);
    // Cleared unconditionally (same idempotent-rerun logic as above) so a "chops clean/" left
    // behind from a previous run with the toggle on doesn't linger once it's turned off.
    await clearOldNumberedFilesFSA(folder.handle, "chops clean", fileInfo.relativeDir, taggedStem);
  }

  const sortedRegions = [...regions].sort((a, b) => a[0] - b[0]);
  // Snap boundaries first (cheap, main-thread) so the worker only ever sees the heavy part:
  // WSOLA stretch, the lo-fi chain, fades, and WAV encoding for each already-sliced region.
  const regionDefs = [];
  const cleanBlobs = wantCleanCopy ? [] : null;
  for (const [s, e] of sortedRegions) {
    let startSample = Math.max(0, Math.round(s * buffer.sampleRate));
    let endSample = Math.min(mono.length, Math.round(e * buffer.sampleRate));
    if (zcWindow > 0) {
      startSample = findNearestZeroCrossing(mono, startSample, zcWindow);
      endSample = findNearestZeroCrossing(mono, endSample, zcWindow);
    }
    if (endSample <= startSample) continue;
    // sliceChannels always allocates fresh buffers, so slicing the same region twice (once for
    // the worker, which may transfer/detach its copy, once for the untouched "clean" copy here)
    // never lets the two alias each other.
    regionDefs.push({ startSample, endSample, channels: sliceChannels(channels, startSample, endSample) });
    if (wantCleanCopy) {
      const rawSliced = sliceChannels(channels, startSample, endSample);
      applyFades(rawSliced, fadeInSamples, fadeOutSamples);
      cleanBlobs.push(encodeWav(rawSliced, buffer.sampleRate, exportSettings.bitDepth));
    }
  }

  const heavyResults =
    regionDefs.length > 0
      ? await processRegionsHeavy({
          sampleRate: buffer.sampleRate,
          bitDepth: exportSettings.bitDepth,
          fadeInSamples,
          fadeOutSamples,
          stretchRatio,
          character: timestretchSettings.character,
          macroValues: timestretchSettings.macroValues,
          seed: timestretchSettings.seed,
          regions: regionDefs,
        })
      : [];

  const chopRows = [];
  const chopMarkers = [];
  for (let i = 0; i < regionDefs.length; i++) {
    const { startSample, endSample } = regionDefs[i];
    const { blob, seconds } = heavyResults[i];
    const fileName = buildChopFileName(stem, tag, i + 1);
    await writeOutput(folder, "chops", relPath, fileName, blob, zipBatch);
    if (wantCleanCopy) {
      await writeOutput(folder, "chops clean", relPath, fileName, cleanBlobs[i], zipBatch);
    }
    chopRows.push({ fileName, blob, seconds });
    chopMarkers.push([startSample / buffer.sampleRate, endSample / buffer.sampleRate]);
  }
  return { chopRows, chopMarkers };
}

/** Re-decodes a source file and re-exports its main chops from a manually-edited region list. */
async function reExportSingleFile(editContext, editedRegions) {
  const { folder, fileInfo, stem, tag, taggedStem, detectedBpm } = editContext;
  const file = fileInfo.fsaHandle ? await fileInfo.fsaHandle.getFile() : fileInfo.legacyFile;
  const { buffer } = await decodeFile(file, fileInfo.ext);
  const channels = bufferChannels(buffer);
  const mono = toMono(channels);
  const zipBatch = folder.kind === "fsa" || dryRun ? null : new ZipBatch();

  const { chopRows, chopMarkers } = await exportChopsForRegions({
    folder,
    fileInfo,
    regions: editedRegions,
    stem,
    tag,
    taggedStem,
    buffer,
    channels,
    mono,
    zipBatch,
    detectedBpm,
  });

  if (zipBatch) {
    await zipBatch.downloadAs(`${taggedStem}_re-exported.zip`);
  }

  return { chopRows, chopMarkers, peaks: computePeaks(mono, 400), duration: mono.length / buffer.sampleRate };
}

/**
 * Exports exactly one chop at its current (possibly edited) boundaries, alongside whatever chops
 * are already on disk, without deleting or rewriting the rest of the set. Deliberately does NOT
 * call exportChopsForRegions - that helper clears the whole numbered chop directory first, which is
 * correct for a full re-export but would silently wipe every other exported chop here. Instead it
 * calls processRegionsHeavy directly: the same stretch/lo-fi/fade/encode path a full export uses,
 * just for a single region, then writes straight to the position-correct filename so it overwrites
 * only that one chop.
 */
async function exportSelectedChop(editContext, region, index) {
  const { folder, fileInfo, stem, tag, taggedStem, detectedBpm } = editContext;
  const file = fileInfo.fsaHandle ? await fileInfo.fsaHandle.getFile() : fileInfo.legacyFile;
  const { buffer } = await decodeFile(file, fileInfo.ext);
  const channels = bufferChannels(buffer);
  const mono = toMono(channels);

  const fadeInSamples = Math.round((exportSettings.fadeMs / 1000) * buffer.sampleRate);
  const fadeOutSamples = fadeInSamples;
  const zcWindow = Math.round((exportSettings.zcSearchMs / 1000) * buffer.sampleRate);
  const stretchRatio = resolveStretchRatio(detectedBpm);

  let startSample = Math.max(0, Math.round(region[0] * buffer.sampleRate));
  let endSample = Math.min(mono.length, Math.round(region[1] * buffer.sampleRate));
  if (zcWindow > 0) {
    startSample = findNearestZeroCrossing(mono, startSample, zcWindow);
    endSample = findNearestZeroCrossing(mono, endSample, zcWindow);
  }
  if (endSample <= startSample) throw new Error("selected chop has no length");

  const [{ blob }] = await processRegionsHeavy({
    sampleRate: buffer.sampleRate,
    bitDepth: exportSettings.bitDepth,
    fadeInSamples,
    fadeOutSamples,
    stretchRatio,
    character: timestretchSettings.character,
    macroValues: timestretchSettings.macroValues,
    seed: timestretchSettings.seed,
    regions: [{ channels: sliceChannels(channels, startSample, endSample) }],
  });

  const relPath = `${fileInfo.relativeDir ? fileInfo.relativeDir + "/" : ""}${taggedStem}`;
  const fileName = buildChopFileName(stem, tag, index + 1);

  if (folder.kind === "fsa") {
    const ok = await ensureReadWritePermission(folder.handle);
    if (!ok) throw new Error("permission to write to this folder was denied");
    await writeFileFSA(folder.handle, "chops", relPath, fileName, blob);
  } else {
    // No on-disk chops/ directory to slot into outside FSA - hand back a standalone download
    // instead of silently doing nothing.
    const singleZip = new ZipBatch();
    singleZip.addFile(folder.name, "chops", relPath, fileName, blob);
    await singleZip.downloadAs(`${taggedStem}_${fileName.replace(/\.wav$/i, "")}.zip`);
  }

  return { fileName, blob };
}

function renderSkippedFileResult(folderSection, fileName, reason) {
  const block = document.createElement("div");
  block.className = "result-file result-file--skipped";
  block.innerHTML = `<span class="result-file-name">${escapeHtml(fileName)}</span> <span class="result-file-meta">skipped - ${escapeHtml(
    reason
  )}</span>`;
  folderSection.appendChild(block);
}

/**
 * Finds candidate one-shot hits by onset + band-energy classification, purely to dedupe repeats
 * of the same sound (see dedupeHits) - the label itself isn't reliable enough to trust in a
 * filename, so it's discarded after dedupe. Returns [start, end] second pairs, sorted by start.
 */
function detectOneShotRegions(mono, sampleRate) {
  const { times, vals } = computeRmsEnvelope(mono, sampleRate, 20, 10);
  if (!vals.length) return [];
  const { diffs } = multiBandOnsetStrengthCurve(mono, sampleRate, 20, 10, { times, vals });
  const onsets = pickOnsets(times, diffs, 0.65, 0.08);
  const windows = findOneShotWindows(mono, sampleRate, onsets);

  const candidates = windows.map(([s, e]) => {
    const startSample = Math.max(0, Math.round(s * sampleRate));
    const endSample = Math.min(mono.length, Math.round(e * sampleRate));
    const { low, mid, high } = bandEnergies(mono, sampleRate, startSample, endSample);
    const label = classifyHit({ low, mid, high, durationSec: e - s });
    const peak = peakAbs(mono, startSample, endSample);
    const fingerprint = hitFingerprint(mono, sampleRate, startSample, endSample);
    return { start: s, end: e, startSample, endSample, low, mid, high, peak, label, fingerprint };
  });

  return dedupeHits(candidates)
    .map((hit) => [hit.start, hit.end])
    .sort((a, b) => a[0] - b[0]);
}

/**
 * Writes one-shot files for a set of [start,end] second regions - plain sequential numbering
 * (01.wav, 02.wav, ...) rather than the heuristic kick/snare/hat label, since that label is a
 * rough sort, not something reliable enough to bake into a filename. Shared by the initial
 * auto-detected pass and by the manual one-shot editor's "Save & re-export".
 */
async function writeOneShotRegions({ folder, fileInfo, taggedStem, regions, channels, mono, sampleRate, zipBatch, detectedBpm }) {
  if (regions.length === 0) return { rows: [], markers: [] };

  const relPath = `${fileInfo.relativeDir ? fileInfo.relativeDir + "/" : ""}${taggedStem}`;
  // One-shots are raw by default (untouched hits for a sampler) - the stretch/lo-fi chain only
  // touches them when the "also apply to one-shots" scope toggle is on.
  const stretchRatio = applyProcessingToOneShots ? resolveStretchRatio(detectedBpm) : 1;
  const processingActive = applyProcessingToOneShots && (stretchRatio !== 1 || lofiActive());
  const wantCleanCopy = keepUnprocessedCopy && processingActive;

  if (folder.kind === "fsa" && !dryRun) {
    await clearOldOneShotsFSA(folder.handle, fileInfo.relativeDir, taggedStem);
    await clearOldNumberedFilesFSA(folder.handle, "one shots clean", fileInfo.relativeDir, taggedStem);
  }

  const zcWindow = Math.round((exportSettings.zcSearchMs / 1000) * sampleRate);
  const fadeOutSamples = Math.round(0.008 * sampleRate); // short tail fade only - a full fade-in would blunt the transient
  const sortedRegions = [...regions].sort((a, b) => a[0] - b[0]);
  const rows = [];
  const markers = [];
  const regionDefs = [];
  const cleanBlobs = wantCleanCopy ? [] : null;

  for (const [s, e] of sortedRegions) {
    let startSample = Math.max(0, Math.round(s * sampleRate));
    let endSample = Math.min(mono.length, Math.round(e * sampleRate));
    if (zcWindow > 0) {
      startSample = findNearestZeroCrossing(mono, startSample, zcWindow);
      endSample = findNearestZeroCrossing(mono, endSample, zcWindow);
    }
    if (endSample <= startSample) continue;
    regionDefs.push({ startSample, endSample, channels: sliceChannels(channels, startSample, endSample) });
    if (wantCleanCopy) {
      const rawSliced = sliceChannels(channels, startSample, endSample);
      applyFades(rawSliced, 0, fadeOutSamples);
      cleanBlobs.push(encodeWav(rawSliced, sampleRate, exportSettings.bitDepth));
    }
  }

  let heavyResults;
  if (applyProcessingToOneShots && regionDefs.length > 0) {
    heavyResults = await processRegionsHeavy({
      sampleRate,
      bitDepth: exportSettings.bitDepth,
      fadeInSamples: 0,
      fadeOutSamples,
      stretchRatio,
      character: timestretchSettings.character,
      macroValues: timestretchSettings.macroValues,
      seed: timestretchSettings.seed,
      regions: regionDefs,
    });
  } else {
    // Not processing one-shots this run: skip the worker round-trip and just fade+encode each
    // slice directly - regionDefs' channels were never transferred anywhere, so they're safe to
    // mutate here.
    heavyResults = regionDefs.map(({ channels: regionChannels, startSample, endSample }) => {
      applyFades(regionChannels, 0, fadeOutSamples);
      const blob = encodeWav(regionChannels, sampleRate, exportSettings.bitDepth);
      return { blob, seconds: (endSample - startSample) / sampleRate };
    });
  }

  for (let i = 0; i < regionDefs.length; i++) {
    const { startSample, endSample } = regionDefs[i];
    const { blob, seconds } = heavyResults[i];
    const fileName = `${String(i + 1).padStart(2, "0")}.wav`;
    await writeOutput(folder, "one shots", relPath, fileName, blob, zipBatch);
    if (wantCleanCopy) {
      await writeOutput(folder, "one shots clean", relPath, fileName, cleanBlobs[i], zipBatch);
    }
    rows.push({ fileName, blob, seconds });
    markers.push([startSample / sampleRate, endSample / sampleRate]);
  }
  return { rows, markers };
}


/** Re-decodes a source file and re-exports its one-shots from a manually-edited region list. */
async function reExportOneShots(editContext, editedRegions) {
  const { folder, fileInfo, taggedStem, detectedBpm } = editContext;
  const file = fileInfo.fsaHandle ? await fileInfo.fsaHandle.getFile() : fileInfo.legacyFile;
  const { buffer } = await decodeFile(file, fileInfo.ext);
  const channels = bufferChannels(buffer);
  const mono = toMono(channels);
  const zipBatch = folder.kind === "fsa" || dryRun ? null : new ZipBatch();

  const { rows, markers } = await writeOneShotRegions({
    folder,
    fileInfo,
    taggedStem,
    regions: editedRegions,
    channels,
    mono,
    sampleRate: buffer.sampleRate,
    zipBatch,
    detectedBpm,
  });

  if (zipBatch) {
    await zipBatch.downloadAs(`${taggedStem} one-shots_re-exported.zip`);
  }

  return { rows, markers, peaks: computePeaks(mono, 400), duration: mono.length / buffer.sampleRate };
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

/**
 * The exported-audio list under the waveform. `onPick` links a row back to the waveform, so
 * selection works in both directions: click a slice on the waveform to light up its row, or click
 * a row to select that slice.
 */
function renderChopList(chopRows, onPick) {
  const list = document.createElement("div");
  list.className = "chop-list";
  chopRows.forEach((chop, idx) => {
    const row = document.createElement("div");
    row.className = "chop-row";
    row.dataset.index = String(idx);
    const label = document.createElement("span");
    label.className = "chop-name";
    label.textContent = `${chop.fileName} (${chop.seconds.toFixed(1)}s)`;
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = URL.createObjectURL(chop.blob);
    row.appendChild(label);
    row.appendChild(audio);
    if (onPick) {
      // the audio element has its own controls, so only the label area selects
      label.addEventListener("click", () => onPick(idx));
      label.style.cursor = "pointer";
    }
    list.appendChild(row);
  });
  return list;
}

/** Reads a CSS custom property's current value, falling back if unset. */
function themeColor(varName, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}

// Waveforms are canvas-drawn, so they don't reflow or recolor for free the way CSS-styled elements
// do - each drawn canvas registers a small repaint closure here, and applyTask() replays them all
// after a density switch changes their width. Entries for canvases no longer in the document are
// dropped the next time it runs.
const themeRepaints = [];
function registerThemeRepaint(canvas, run) {
  themeRepaints.push({ canvas, run });
}
function repaintForTheme() {
  for (let i = themeRepaints.length - 1; i >= 0; i--) {
    const { canvas, run } = themeRepaints[i];
    if (!canvas.isConnected) {
      themeRepaints.splice(i, 1);
      continue;
    }
    run();
  }
}



/**
 * Renders one processed file's card.
 *
 * The waveform here is the interactive one, always - there is no separate "edit mode" to enter any
 * more. Zooming to look at a transient, auditioning a slice and nudging a cut point were all three
 * clicks deep behind an Edit button, and the audition played the exported file, so hearing an edit
 * meant re-processing first. Now the waveform is live from the moment a file appears: select a
 * slice on it and the matching row below highlights, so "delete number six" doesn't involve
 * counting.
 *
 * Every edit - drag a boundary, add a slice, delete one, re-chop - writes straight into
 * analysisCache as it happens, which is what Export reads. There is no separate commit step: what
 * the waveform shows is what Export cuts, always. "Update previews" (formerly "Apply") only
 * re-renders the audio players below the waveform so you can audition the exact edited audio
 * in-browser; it has no bearing on what Export produces, since Export always re-slices from the
 * live regions anyway. "Revert" discards edits back to the last fresh detection or re-chop, using
 * the separate *RegionsBaseline snapshot in analysisCache (never overwritten by edits) - it cannot
 * just reload analysisCache's current regions, because those ARE the edits.
 */
function renderFileResult(state) {
  const { fileName, keyText, bpmText, chopRows, oneShotRows, duration, editContext, chopSkipped } = state;

  const block = document.createElement("div");
  block.className = "result-file";

  const header = document.createElement("div");
  header.className = "result-file-header";
  const nameEl = document.createElement("span");
  nameEl.className = "result-file-name";
  nameEl.textContent = fileName;
  const metaEl = document.createElement("span");
  metaEl.className = "result-file-meta";
  metaEl.textContent = `key: ${keyText} · tempo: ${bpmText} · ${chopSkipped ? "whole file processed" : `${chopRows.length} chop(s)`}${
    oneShotRows.length ? ` · ${oneShotRows.length} one-shot(s)` : ""
  }`;
  const titleGroup = document.createElement("div");
  titleGroup.className = "result-file-title-group";
  titleGroup.appendChild(nameEl);
  titleGroup.appendChild(metaEl);
  header.appendChild(titleGroup);

  const actionsGroup = document.createElement("div");
  actionsGroup.className = "result-file-header-actions";

  // Which set of slices the waveform edits. Gated on whether chopping/one-shot extraction was
  // part of THIS file's scope (chopSkipped/hasOneShots), not on the current region COUNT - a
  // manual "Clear (manual)" re-chop legitimately leaves 0 regions, and the editor needs to stay
  // mounted (empty, ready for + Add) rather than disappearing the moment the count hits zero.
  const hasChops = Boolean(editContext) && !chopSkipped;
  const hasShots = Boolean(editContext) && !chopSkipped && state.hasOneShots;
  let editing = hasChops ? "chops" : hasShots ? "oneshots" : null;

  let setPicker = null;
  if (hasChops && hasShots) {
    setPicker = document.createElement("div");
    setPicker.className = "seg seg--small";
    for (const [key, label] of [
      ["chops", "Chops"],
      ["oneshots", "One-shots"],
    ]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "seg-btn" + (key === editing ? " is-active" : "");
      b.textContent = label;
      b.addEventListener("click", () => {
        if (editing === key) return;
        editing = key;
        [...setPicker.children].forEach((c) => c.classList.toggle("is-active", c === b));
        mountEditor();
      });
      setPicker.appendChild(b);
    }
    actionsGroup.appendChild(setPicker);
  }

  // Per-file opt-out: one-shot extraction is a heuristic, and on some breaks it just returns junk.
  // Rather than making that an all-or-nothing batch setting, each file can drop its own.
  if (state.hasOneShots && state.analysisKey) {
    const entry = analysisCache.get(state.analysisKey);
    const incLabel = document.createElement("label");
    incLabel.className = "check check--inline result-oneshot-toggle";
    incLabel.title = "Untick to leave this file's one-shots out of the export";
    const incBox = document.createElement("input");
    incBox.type = "checkbox";
    incBox.checked = !entry || entry.includeOneShots !== false;
    const incText = document.createElement("span");
    incText.textContent = "export one-shots";
    incLabel.appendChild(incBox);
    incLabel.appendChild(incText);
    incBox.addEventListener("change", () => {
      const e = analysisCache.get(state.analysisKey);
      if (e) e.includeOneShots = incBox.checked;
      log(`  ${state.fileName}: one-shots ${incBox.checked ? "will be" : "will NOT be"} exported`);
    });
    actionsGroup.appendChild(incLabel);
  }

  if (actionsGroup.childElementCount) header.appendChild(actionsGroup);
  block.appendChild(header);

  const editorHost = document.createElement("div");
  editorHost.className = "result-file-editor";
  block.appendChild(editorHost);

  // Re-chop: an explicit, per-file, intentionally destructive way to throw away the current chop
  // regions and generate a new set - see section 4 of the backlog. Chop-only: bars/count don't mean
  // anything for a one-shot set, which has its own separate include/exclude toggle above.
  const rechopRow = document.createElement("div");
  rechopRow.className = "result-rechop-row";
  const rechopCountInput = document.createElement("input");
  rechopCountInput.type = "number";
  rechopCountInput.min = "1";
  rechopCountInput.max = "200";
  rechopCountInput.value = "8";
  rechopCountInput.className = "rechop-count-input";
  rechopCountInput.title = "Target number of slices";
  rechopCountInput.setAttribute("aria-label", "Target number of slices");
  const rechopCountBtn = document.createElement("button");
  rechopCountBtn.className = "btn btn--ghost btn--small";
  rechopCountBtn.textContent = "Re-chop by count";
  rechopCountBtn.title = "Replace every current chop with this many equal-length slices.";
  const rechopBarsSelect = document.createElement("select");
  rechopBarsSelect.className = "rechop-bars-select";
  rechopBarsSelect.setAttribute("aria-label", "Bar length for re-chop");
  for (const bars of BAR_OPTIONS) {
    const opt = document.createElement("option");
    opt.value = String(bars);
    opt.textContent = `${bars} bar${bars === 1 ? "" : "s"}`;
    rechopBarsSelect.appendChild(opt);
  }
  rechopBarsSelect.value = String(drumBars);
  const rechopBarsBtn = document.createElement("button");
  rechopBarsBtn.className = "btn btn--ghost btn--small";
  rechopBarsBtn.textContent = "Re-chop by bars";
  rechopBarsBtn.title = "Replace every current chop with break-sized loops of this bar length.";
  const rechopAlignLabel = document.createElement("label");
  rechopAlignLabel.className = "check check--inline";
  const rechopAlignCheckbox = document.createElement("input");
  rechopAlignCheckbox.type = "checkbox";
  rechopAlignCheckbox.checked = true;
  const rechopAlignText = document.createElement("span");
  rechopAlignText.textContent = "align to audible start";
  rechopAlignLabel.title = "Skip leading silence so the first slice starts where the audio actually begins.";
  rechopAlignLabel.append(rechopAlignCheckbox, rechopAlignText);
  const rechopClearBtn = document.createElement("button");
  rechopClearBtn.className = "btn btn--ghost btn--small";
  rechopClearBtn.textContent = "Clear (manual)";
  rechopClearBtn.title = "Remove every chop so you can build your own from scratch with + Add.";
  rechopRow.append(rechopCountInput, rechopCountBtn, rechopBarsSelect, rechopBarsBtn, rechopAlignLabel, rechopClearBtn);
  block.appendChild(rechopRow);

  const applyRow = document.createElement("div");
  applyRow.className = "result-apply-row";
  const applyNote = document.createElement("span");
  applyNote.className = "result-apply-note";
  applyNote.textContent = "Edits apply immediately - Export uses these boundaries.";
  const revertBtn = document.createElement("button");
  revertBtn.className = "btn btn--ghost btn--small";
  revertBtn.textContent = "Revert to last chop";
  revertBtn.title = "Discard edits and restore the regions from the last detection or re-chop.";
  const exportSelectedBtn = document.createElement("button");
  exportSelectedBtn.className = "btn btn--ghost btn--small";
  exportSelectedBtn.textContent = "Export selected";
  exportSelectedBtn.title = "Export just the selected chop, using its current boundaries.";
  exportSelectedBtn.disabled = true;
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn btn--primary btn--small";
  applyBtn.textContent = "Update previews";
  applyBtn.title = "Re-render the audio players below from the current edits, so you can audition them here.";
  applyRow.append(applyNote, revertBtn, exportSelectedBtn, applyBtn);
  block.appendChild(applyRow);

  const staticArea = document.createElement("div");
  staticArea.className = "result-file-static";
  block.appendChild(staticArea);

  let editor = null;
  let chopListEl = null;
  let shotListEl = null;

  /** Highlights the row matching the slice selected on the waveform. */
  function highlightRow(idx) {
    for (const list of [chopListEl, shotListEl]) {
      if (!list) continue;
      const active = (editing === "chops" && list === chopListEl) || (editing === "oneshots" && list === shotListEl);
      [...list.querySelectorAll(".chop-row")].forEach((row, i) => {
        row.classList.toggle("is-selected", active && i === idx);
      });
    }
  }

  function updateExportSelectedState() {
    exportSelectedBtn.disabled = editing !== "chops" || !editor || editor.getSelected() == null;
  }

  function renderLists() {
    staticArea.innerHTML = "";
    chopListEl = null;
    shotListEl = null;
    if (chopRows.length) {
      const h = document.createElement("div");
      h.className = "result-subheading";
      h.textContent = "Chops";
      chopListEl = renderChopList(chopRows, (i) => editor && editing === "chops" && editor.select(i));
      staticArea.append(h, chopListEl);
    }
    if (oneShotRows.length) {
      const h = document.createElement("div");
      h.className = "result-subheading";
      h.textContent = "One-shots";
      shotListEl = renderChopList(oneShotRows, (i) => editor && editing === "oneshots" && editor.select(i));
      staticArea.append(h, shotListEl);
    }
  }

  function mountEditor() {
    if (editor) editor.destroy();
    editorHost.innerHTML = "";
    editor = null;
    rechopRow.hidden = editing !== "chops";
    applyRow.hidden = !editing;
    if (!editing) return;
    editor = createEditableWaveform({
      mono: state.mono,
      sampleRate: state.sampleRate,
      duration,
      initialRegions: editing === "chops" ? state.chopMarkers : state.oneShotMarkers,
      noun: editing === "chops" ? "chop" : "one-shot",
      zcSearchMs: exportSettings.zcSearchMs,
      color: themeColor,
      // The canonical region state lives in analysisCache, and it's updated the moment a slice
      // changes - not on some later "Apply" click. This is what makes Export always cut where the
      // waveform currently shows, whether or not "Update previews" was ever clicked.
      onChange: () => {
        const regions = editor.getRegions();
        const entry = state.analysisKey ? analysisCache.get(state.analysisKey) : null;
        if (editing === "chops") {
          if (entry) entry.chopRegions = regions;
          state.chopMarkers = regions;
        } else {
          if (entry) entry.oneShotRegions = regions;
          state.oneShotMarkers = regions;
        }
      },
      onSelect: (idx) => {
        highlightRow(idx);
        updateExportSelectedState();
      },
    });
    editorHost.appendChild(editor.el);
    registerThemeRepaint(editor.el, () => editor && editor.redraw());
    updateExportSelectedState();
  }

  /** Replaces the canonical chop regions wholesale (re-chop, or a manual clear-to-start-fresh). */
  function applyNewChopRegions(newRegions) {
    const cloned = newRegions.map((r) => [...r]);
    const entry = state.analysisKey ? analysisCache.get(state.analysisKey) : null;
    if (entry) {
      entry.chopRegions = cloned.map((r) => [...r]);
      entry.chopRegionsBaseline = cloned.map((r) => [...r]);
    }
    state.chopMarkers = cloned;
    if (editor && editing === "chops") {
      editor.setRegions(cloned);
      updateExportSelectedState();
    }
  }

  revertBtn.addEventListener("click", () => {
    const entry = state.analysisKey ? analysisCache.get(state.analysisKey) : null;
    if (!entry) return;
    if (editing === "chops") {
      const baseline = (entry.chopRegionsBaseline || []).map((r) => [...r]);
      entry.chopRegions = baseline.map((r) => [...r]);
      state.chopMarkers = baseline;
      if (editor) editor.setRegions(baseline);
    } else {
      const baseline = (entry.oneShotRegionsBaseline || []).map((r) => [...r]);
      entry.oneShotRegions = baseline.map((r) => [...r]);
      state.oneShotMarkers = baseline;
      if (editor) editor.setRegions(baseline);
    }
    updateExportSelectedState();
    log(`  ${state.fileName}: ${editing === "chops" ? "chops" : "one-shots"} reverted to the last detection/re-chop.`);
  });

  // Re-renders this file's audio players from the current (already-canonical) edited boundaries,
  // purely so they can be auditioned here. Export doesn't need this - it always re-slices from the
  // live regions in analysisCache regardless of whether this was ever clicked.
  async function regeneratePreviews() {
    applyBtn.disabled = true;
    revertBtn.disabled = true;
    const previousLabel = applyBtn.textContent;
    applyBtn.textContent = "Updating…";
    const wasDryRun = dryRun;
    dryRun = true;
    try {
      const regions = editor.getRegions();
      if (editing === "chops") {
        const result = await reExportSingleFile(state.editContext, regions);
        state.chopRows = result.chopRows;
        state.chopMarkers = result.chopMarkers;
        log(`  ${state.editContext.fileInfo.name}: previewed ${result.chopRows.length} chop(s).`);
      } else {
        const result = await reExportOneShots(state.editContext, regions);
        state.oneShotRows = result.rows;
        state.oneShotMarkers = result.markers;
        log(`  ${state.editContext.fileInfo.name}: previewed ${result.rows.length} one-shot(s).`);
      }
      block.replaceWith(renderFileResult(state));
    } catch (err) {
      log(`  ERROR updating previews for ${state.editContext.fileInfo.name}: ${err.message || err}`);
      console.error(err);
      applyBtn.disabled = false;
      revertBtn.disabled = false;
      applyBtn.textContent = previousLabel;
    } finally {
      dryRun = wasDryRun;
    }
  }

  applyBtn.addEventListener("click", () => regeneratePreviews());

  rechopCountBtn.addEventListener("click", () => {
    const n = Math.max(1, Math.min(200, parseInt(rechopCountInput.value, 10) || 1));
    const offset = rechopAlignCheckbox.checked ? findAudibleStart(state.mono, state.sampleRate) : 0;
    applyNewChopRegions(equalSliceRegions(offset, duration, n));
    log(`  ${state.fileName}: re-chopped into ${n} equal slice(s)${offset > 0 ? " aligned to audible start" : ""}.`);
    regeneratePreviews();
  });

  rechopBarsBtn.addEventListener("click", () => {
    const bars = parseInt(rechopBarsSelect.value, 10);
    const offset = rechopAlignCheckbox.checked ? findAudibleStart(state.mono, state.sampleRate) : 0;
    const offsetSample = Math.round(offset * state.sampleRate);
    const subMono = offsetSample > 0 ? state.mono.subarray(offsetSample) : state.mono;
    const bpm = state.editContext ? state.editContext.detectedBpm : null;
    const regions = computeDrumRegions(subMono, state.sampleRate, bars, bpm).map(([s, e]) => [s + offset, e + offset]);
    applyNewChopRegions(regions);
    log(`  ${state.fileName}: re-chopped by ${bars} bar(s)${offset > 0 ? " aligned to audible start" : ""}.`);
    regeneratePreviews();
  });

  rechopClearBtn.addEventListener("click", () => {
    applyNewChopRegions([]);
    log(`  ${state.fileName}: chops cleared - build your own with + Add.`);
    regeneratePreviews();
  });

  // Exports exactly the selected slice at its current (possibly edited) boundaries, alongside
  // whatever's already on disk from a previous Export All, without touching or re-writing any
  // other chop. Reuses the same DSP/render path as a full export (processRegionsHeavy) rather than
  // exportChopsForRegions, since that helper clears and rewrites the WHOLE numbered chop set - fine
  // for a full re-export, but it would silently delete every other already-exported chop here.
  exportSelectedBtn.addEventListener("click", async () => {
    const idx = editor ? editor.getSelected() : null;
    if (idx == null) return;
    const region = editor.getRegions()[idx];
    exportSelectedBtn.disabled = true;
    const previousLabel = exportSelectedBtn.textContent;
    exportSelectedBtn.textContent = "Exporting…";
    try {
      const { fileName } = await exportSelectedChop(state.editContext, region, idx);
      log(`  ${state.editContext.fileInfo.name}: exported ${fileName} (chop ${idx + 1} only).`);
    } catch (err) {
      log(`  ERROR exporting the selected chop: ${err.message || err}`);
      console.error(err);
    } finally {
      exportSelectedBtn.textContent = previousLabel;
      updateExportSelectedState();
    }
  });

  renderLists();
  mountEditor();
  return block;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Preview
//
// Preview used to audition six seconds of the first file through the stretch/lo-fi chain, which
// answered a question nobody was asking: the useful thing to see before committing is where the
// cuts landed. It now runs the real batch with writing switched off, so you get every waveform,
// every chop and one-shot with a player, and the region editor - and then decide whether to
// Export. Reviewing chops only after they had already been written to disk was backwards.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

/** Shows/hides and updates the progress bar under Process Batch. total<=0 hides it. */
function updateProgress(done, total, label) {
  if (total <= 0) {
    progressRow.hidden = true;
    return;
  }
  progressRow.hidden = false;
  const pct = Math.min(100, Math.round((done / total) * 100));
  progressBarFill.style.width = `${pct}%`;
  progressLabel.textContent = label || `${done} / ${total} file(s)`;
}

/** Runs the batch. `write: false` is Preview - identical work, nothing saved. */
async function processBatch({ write = true } = {}) {
  processing = true;
  dryRun = !write;
  cancelRequested = false;
  cancelBtn.disabled = false;
  cancelBtn.textContent = "Cancel";
  updateProcessButton();
  clearLog();
  resultsPanel.innerHTML = "";
  drumTempoSkipPolicy = null;
  log(write ? "Exporting…" : "Processing. Nothing is saved until you hit Export.");

  if (task === "stretch") {
    // Usually a no-op (renderFolderList() already keeps this current as files are added/removed) -
    // reasserted here so processing order always matches the queue even if something upstream
    // changed it without going through that path.
    rebuildStretchFileOrder();
    renderStretchFileStrip();
  }

  const zipBatch = FSA_SUPPORTED || dryRun ? null : new ZipBatch();
  let totalChops = 0;
  let processedFolders = 0;
  const totalFiles = sourceFolders.reduce((sum, f) => sum + f.files.length, 0);
  let filesDone = 0;
  updateProgress(0, totalFiles);

  outer: for (const folder of sourceFolders) {
    log(`Folder: ${folder.name}`);
    if (folder.files.length === 0) {
      log("  No source audio found, skipped");
      continue;
    }

    // Only ask for write access when we're actually going to write - a preview shouldn't put a
    // permission prompt in front of someone who just wants to see where the cuts landed.
    if (folder.kind === "fsa" && !dryRun) {
      const ok = await ensureReadWritePermission(folder.handle);
      if (!ok) {
        log("  Permission to write to this folder was denied, skipped");
        continue;
      }
    }

    // STRETCH has no per-folder results section any more - the workspace shows one active file at a
    // time regardless of which folder it came from. See processOneFile()'s task === "stretch" branch.
    const folderSection = task === "stretch" ? null : renderFolderResultSection(folder);

    for (const fileInfo of folder.files) {
      if (cancelRequested) {
        log("Batch cancelled.");
        break outer;
      }
      updateProgress(filesDone, totalFiles, `${fileInfo.name} (${filesDone + 1}/${totalFiles})`);
      try {
        totalChops += await processOneFile(folder, fileInfo, zipBatch, folderSection);
      } catch (err) {
        log(`  ERROR on ${fileInfo.name}: ${err.message || err} - skipping this file, batch continues`);
        console.error(err);
      }
      filesDone++;
      updateProgress(filesDone, totalFiles);
      // Yield to the event loop so the log/UI/progress bar stay responsive during a big batch,
      // and so a Cancel click actually gets a chance to register between files.
      await new Promise((r) => setTimeout(r, 0));
    }
    processedFolders++;
  }

  if (zipBatch) {
    log(cancelRequested ? "Building ZIP for download (partial - batch was cancelled)…" : "Building ZIP for download…");
    await zipBatch.downloadAs("auto_sample_chopper_output.zip");
    log("ZIP download started.");
  }

  if (task === "stretch") {
    const status = cancelRequested ? "Cancelled." : "Done.";
    log(dryRun ? `${status} Processed ${filesDone} file(s). Adjust anything you want, then hit Export to save.` : `${status} Exported ${filesDone} file(s).`);
  } else if (dryRun) {
    log(
      `${cancelRequested ? "Cancelled." : "Done."} ${totalChops} chop(s) from ${processedFolders} folder(s). ` +
        `Adjust anything you want, then hit Export to save.`
    );
  } else {
    log(`${cancelRequested ? "Cancelled." : "Done."} Exported ${totalChops} chop(s) from ${processedFolders} folder(s).`);
  }
  processing = false;
  dryRun = false;
  cancelRequested = false;
  updateProcessButton();
  progressRow.hidden = true;
}

processBtn.addEventListener("click", () => {
  if (!processing) processBatch({ write: true });
});

previewBtn.addEventListener("click", () => {
  if (!processing) processBatch({ write: false });
});

cancelBtn.addEventListener("click", () => {
  if (!processing || cancelRequested) return;
  cancelRequested = true;
  cancelBtn.disabled = true;
  cancelBtn.textContent = "Cancelling…";
  log("Cancelling after the current file finishes…");
});

// ---------------------------------------------------------------------------
// Export / detection settings wiring
// ---------------------------------------------------------------------------

bitDepthSelect.addEventListener("change", () => {
  exportSettings.bitDepth = parseInt(bitDepthSelect.value, 10);
  saveSettings();
});
bindSliderNumber(fadeMsSlider, fadeMsNumber, (v) => {
  exportSettings.fadeMs = v;
  saveSettings();
});
bindSliderNumber(zcMsSlider, zcMsNumber, (v) => {
  exportSettings.zcSearchMs = v;
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
  applyTask(loadTask(), { persist: false });
  const savedRail = (() => {
    try {
      return localStorage.getItem(RAIL_STORAGE_KEY);
    } catch (_) {
      return null;
    }
  })();
  applyRail(savedRail ? savedRail === "open" : true, { persist: false });
  applySettings(loadSettings());
  updateNamingPreview(); // outside applySettings so it also runs for first-time visitors with nothing saved yet
  updateCharacterUI(); // same - first-time visitors need the character hint/macros shown for the default character too

  outputBanner.textContent = FSA_SUPPORTED
    ? "Chops are saved straight into each folder's wav/ and chops/ subfolders."
    : "This browser can't write directly to folders, so the whole batch will be bundled into one ZIP for you to download and unzip wherever you like.";
  outputBanner.className = FSA_SUPPORTED ? "banner banner--good" : "banner banner--info";

  if (!FSA_FILE_PICKER_SUPPORTED && FSA_SUPPORTED) {
    addFilesBtn.title = "This browser supports folder writing but not the individual-file picker - falling back to a plain file chooser.";
  }

  renderParamsPanel();
  renderFolderList();
  updateProcessButton();

  essentiaAvailable().then((available) => {
    essentiaStatus.textContent = available
      ? "Key & tempo detection ready."
      : "Key & tempo detection unavailable (couldn't load essentia.js) - chopping still works normally.";
    essentiaStatus.className = available ? "essentia-status essentia-status--ok" : "essentia-status essentia-status--warn";
  });

  loadRememberedFolders();
}

/**
 * Loads folders remembered from a previous session (IndexedDB, see folder-store.js) and either
 * auto-adds them (permission was already silently re-granted - queryPermission never prompts) or
 * lists them as pending a Reconnect click. FSA-only; a no-op fallback browser never has anything
 * remembered here. Runs after the first render, same pattern as the essentiaAvailable() check
 * above, so it doesn't hold up the rest of init().
 */
async function loadRememberedFolders() {
  if (!FSA_SUPPORTED) return;
  const wasEmpty = sourceFolders.length === 0;
  const remembered = await listRememberedFolders();
  for (const { name, handle } of remembered) {
    if (folderAlreadyQueued(name)) continue;
    try {
      const perm = await handle.queryPermission({ mode: "readwrite" });
      if (perm === "granted") {
        const files = await collectAudioFilesFSA(handle);
        sourceFolders.push({ id: nextFolderId++, name, kind: "fsa", handle, files });
      } else {
        pendingReconnectFolders.push({ name, handle });
      }
    } catch (err) {
      // The handle references a folder that's gone (moved/deleted) or something else broke -
      // stop remembering it rather than showing a permanently-broken reconnect row.
      forgetFolder(name);
    }
  }
  if (remembered.length) {
    renderFolderList();
    updateProcessButton();
    maybeAutoProcessInitialBatch(wasEmpty);
  }
}

init();

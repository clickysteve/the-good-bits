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
  multiBandOnsetStrengthCurve,
  computeRmsEnvelope,
  pickOnsets,
  computePeaks,
  computePeaksInRange,
} from "./dsp.js";
import { wsolaStretchChannels, ratioForTargetTempo } from "./timestretch.js";
import { OUTPUT_STAGES, DRIVE_TYPES, applyLofiChain as applyLofiChainPure } from "./outputstage.js";
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
let previewRunning = false;
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
const timestretchSettings = { enabled: false, mode: "target-tempo", targetBpm: 120, ratio: 1.0, character: "clean" };

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
const THEME_STORAGE_KEY = "good-bits-theme-v1";
const THEMES = ["classic", "terminal", "console"];

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
const themeSwitcherBtns = document.querySelectorAll("#theme-switcher .theme-switcher-btn");
const uiModeSwitcherBtns = document.querySelectorAll("#ui-mode-switcher .theme-switcher-btn");
const uiModeHint = $("#ui-mode-hint");
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
const chopEnabledCheckbox = $("#chop-enabled-checkbox");
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
const previewAudio = $("#preview-audio");
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

chopEnabledCheckbox.addEventListener("change", () => {
  chopIntoPieces = chopEnabledCheckbox.checked;
  updateDrumOptionsVisibility();
  saveSettings();
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

timestretchEnableCheckbox.addEventListener("change", () => {
  timestretchSettings.enabled = timestretchEnableCheckbox.checked;
  timestretchOptions.hidden = !timestretchSettings.enabled;
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
  saveSettings();
});

/** ratio to pass to wsolaStretchChannels for this file, or 1 (no-op) if stretching doesn't apply. */
function resolveStretchRatio(detectedBpm) {
  if (!timestretchSettings.enabled) return 1;
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

/** true if any lo-fi stage is switched on. */
function lofiActive() {
  return outputStageSettings.enabled || driveSettings.enabled || crunchSettings.enabled;
}

/** Runs the enabled lo-fi stages (current settings) over a set of channels - thin wrapper around
 * the pure, worker-shareable applyLofiChain in outputstage.js. Used by the main-thread fallback
 * path and by the Preview feature; the worker calls the pure version directly. */
function applyLofiChain(channels, sampleRate) {
  return applyLofiChainPure(channels, sampleRate, { outputStage: outputStageSettings, drive: driveSettings, crunch: crunchSettings });
}

/** Plain snapshot of the current lo-fi settings, safe to structured-clone into a worker message. */
function lofiSettingsSnapshot() {
  return { outputStage: { ...outputStageSettings }, drive: { ...driveSettings }, crunch: { ...crunchSettings } };
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
// UI theme switcher (Classic / Terminal / Console) - a cosmetic skin only,
// swaps CSS custom properties via [data-theme] on <html>. Canvas-drawn
// waveforms read their colors from those same properties (see themeColor()
// and registerThemeRepaint() below), so switching themes recolors already-
// rendered results too, not just future ones.
// ---------------------------------------------------------------------------

function applyTheme(theme, { persist = true } = {}) {
  const safeTheme = THEMES.includes(theme) ? theme : "classic";
  if (safeTheme === "classic") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", safeTheme);
  }
  themeSwitcherBtns.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.themeChoice === safeTheme);
  });
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, safeTheme);
    } catch (_) {
      /* best-effort only */
    }
  }
  repaintForTheme();
}

function loadTheme() {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) || "classic";
  } catch (_) {
    return "classic";
  }
}

themeSwitcherBtns.forEach((btn) => {
  btn.addEventListener("click", () => applyTheme(btn.dataset.themeChoice));
});

// ---------------------------------------------------------------------------
// Simple / Advanced mode - a view-only toggle (Simple hides everything except Mode, Source,
// Process and Results via the .advanced-only CSS class), not a separate settings profile: the
// underlying settings (naming, detection params, time-stretch, lo-fi, ...) keep whatever they
// were, Simple mode just stops showing the knobs for them. Persisted the same way as the theme.
// ---------------------------------------------------------------------------

const UI_MODE_STORAGE_KEY = "good-bits-ui-mode-v1";
const UI_MODES = ["simple", "advanced"];
const UI_MODE_HINTS = {
  simple: "Drop a folder or file below and it processes immediately with sensible defaults - switch to Advanced for full control over naming, detection, time-stretch and lo-fi.",
  advanced: "Every option is available below: output naming, detection parameters, time-stretch and lo-fi processing.",
};

function applyUiMode(uiMode, { persist = true } = {}) {
  const safeMode = UI_MODES.includes(uiMode) ? uiMode : "simple";
  document.documentElement.setAttribute("data-ui-mode", safeMode);
  uiModeSwitcherBtns.forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.uiModeChoice === safeMode);
  });
  uiModeHint.textContent = UI_MODE_HINTS[safeMode];
  if (persist) {
    try {
      localStorage.setItem(UI_MODE_STORAGE_KEY, safeMode);
    } catch (_) {
      /* best-effort only */
    }
  }
}

function loadUiMode() {
  try {
    return localStorage.getItem(UI_MODE_STORAGE_KEY) || "simple";
  } catch (_) {
    return "simple";
  }
}

uiModeSwitcherBtns.forEach((btn) => {
  btn.addEventListener("click", () => applyUiMode(btn.dataset.uiModeChoice));
});

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
  if (typeof saved.chopIntoPieces === "boolean") {
    chopIntoPieces = saved.chopIntoPieces;
    chopEnabledCheckbox.checked = chopIntoPieces;
  }
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
    timestretchOptions.hidden = !timestretchSettings.enabled;
    timestretchModeSelect.value = timestretchSettings.mode;
    timestretchTargetBpmInput.value = timestretchTargetBpmNumber.value = String(timestretchSettings.targetBpm);
    timestretchRatioInput.value = timestretchRatioNumber.value = String(Math.round(timestretchSettings.ratio * 100));
    timestretchCharacterSelect.value = timestretchSettings.character;
    updateTimestretchModeVisibility();
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
          const idx = pendingReconnectFolders.indexOf(pending);
          if (idx >= 0) pendingReconnectFolders.splice(idx, 1);
          if (!folderAlreadyQueued(pending.name)) {
            const files = await collectAudioFilesFSA(pending.handle);
            sourceFolders.push({ id: nextFolderId++, name: pending.name, kind: "fsa", handle: pending.handle, files });
          }
          renderFolderList();
          updateProcessButton();
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
}

function updateProcessButton() {
  processBtn.disabled = processing || sourceFolders.length === 0;
  previewBtn.disabled = processing || previewRunning || sourceFolders.length === 0;
  cancelBtn.hidden = !processing;
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
 * from a drop starts read-only in some browsers, unlike one from showDirectoryPicker(). */
async function addFolderFSA(providedHandle) {
  const handle = providedHandle || (await pickFolderFSA());
  if (!handle) return;
  if (providedHandle) {
    const ok = await ensureReadWritePermission(handle);
    if (!ok) {
      log(`Permission to write to "${handle.name}" was denied.`);
      return;
    }
  }

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

/** providedHandles: when set (files dropped via drag-and-drop), skip the picker and use these
 * file handles directly - a dropped file's read permission is already implied by the drop itself. */
async function addIndividualFilesFSA(providedHandles) {
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
        await addFolderFSA(dir);
      }
      const fileHandles = handles.filter((h) => h.kind === "file");
      if (fileHandles.length > 0) await addIndividualFilesFSA(fileHandles);
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
  if (document.documentElement.getAttribute("data-ui-mode") === "simple" && !processing && sourceFolders.length > 0) {
    processBatch();
  }
});

clearFoldersBtn.addEventListener("click", () => {
  sourceFolders.length = 0;
  pendingReconnectFolders.length = 0;
  looseDestinationHandle = null;
  forgetAllFolders();
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
async function processRegionsHeavy({ sampleRate, bitDepth, fadeInSamples, fadeOutSamples, stretchRatio, character, regions }) {
  const lofi = lofiSettingsSnapshot();
  const worker = getHeavyDspWorker();
  if (worker) {
    try {
      const transferList = regions.flatMap((r) => r.channels.map((ch) => ch.buffer));
      return await new Promise((resolve, reject) => {
        const requestId = ++heavyDspRequestId;
        heavyDspPending.set(requestId, { resolve, reject });
        worker.postMessage({ type: "processRegions", requestId, sampleRate, bitDepth, fadeInSamples, fadeOutSamples, stretchRatio, character, lofi, regions }, transferList);
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
      sliced = wsolaStretchChannels(sliced, sampleRate, stretchRatio, character);
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
  const wantKey = detectSettings.key;
  const wantTempo = detectSettings.tempo;
  const kt = await analyzeKeyAndTempo(mono, buffer.sampleRate, { key: wantKey, tempo: wantTempo });
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
  if (fullStretched || fullLofi) {
    const [{ blob: derivedBlob }] = await processRegionsHeavy({
      sampleRate: buffer.sampleRate,
      bitDepth: 24,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      stretchRatio: fullStretchRatio,
      character: timestretchSettings.character,
      regions: [{ channels: channels.map((ch) => Float32Array.from(ch)) }],
    });
    const derivedName = `${taggedStem}${fullStretched ? " stretched" : ""}${fullLofi ? " lofi" : ""}.wav`;
    await writeOutput(folder, "wav", fileInfo.relativeDir, derivedName, derivedBlob, zipBatch);
    log(`    wrote a full-length ${[fullStretched && "time-stretched", fullLofi && "lo-fi"].filter(Boolean).join(" + ")} copy`);
  }

  const editContext = { folder, fileInfo, stem, tag, taggedStem, detectedBpm: kt.bpm };
  let chopRows = [];
  let chopMarkers = [];
  let oneShotRows = [];
  let oneShotMarkers = [];

  if (chopIntoPieces) {
    const modeParams = activeParams();
    let regions;
    if (mode === "drums") {
      const barsSec = barsToSeconds(drumBars, kt.bpm);
      const drumParams = { ...modeParams.drums };
      if (barsSec) {
        drumParams.preferred = barsSec;
        drumParams.minLen = Math.max(0.4, barsSec * 0.5);
        drumParams.maxLen = barsSec * 1.5;
      } // else: no confident tempo - fall back to the fixed preferred/minLen/maxLen above
      const snapBpm = drumParams.snapToTempo ? kt.bpm : null;
      regions = drumRegions(mono, buffer.sampleRate, drumParams, snapBpm).regions;
    } else {
      regions = phraseRegions(mono, buffer.sampleRate, modeParams[mode]).regions;
    }

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

    if (mode === "drums" && extractOneShots) {
      const extracted = await extractAndWriteOneShots(folder, fileInfo, taggedStem, mono, channels, buffer.sampleRate, zipBatch, kt.bpm);
      oneShotRows = extracted.rows;
      oneShotMarkers = extracted.markers;
      log(`    extracted ${oneShotRows.length} one-shot hit(s)`);
    }
  } else {
    log(`    key: ${keyText} | tempo: ${bpmText} | chop into pieces is off - whole file processed`);
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

  if (folder.kind === "fsa") {
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
  const zipBatch = folder.kind === "fsa" ? null : new ZipBatch();

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
    return { start: s, end: e, startSample, endSample, low, mid, high, peak, label };
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

  if (folder.kind === "fsa") {
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

/** Finds, dedupes and writes one-shot hits for a drum-mode source file's initial auto pass. Returns {rows, markers}. */
async function extractAndWriteOneShots(folder, fileInfo, taggedStem, mono, channels, sampleRate, zipBatch, detectedBpm) {
  const regions = detectOneShotRegions(mono, sampleRate);
  return writeOneShotRegions({ folder, fileInfo, taggedStem, regions, channels, mono, sampleRate, zipBatch, detectedBpm });
}

/** Re-decodes a source file and re-exports its one-shots from a manually-edited region list. */
async function reExportOneShots(editContext, editedRegions) {
  const { folder, fileInfo, taggedStem, detectedBpm } = editContext;
  const file = fileInfo.fsaHandle ? await fileInfo.fsaHandle.getFile() : fileInfo.legacyFile;
  const { buffer } = await decodeFile(file, fileInfo.ext);
  const channels = bufferChannels(buffer);
  const mono = toMono(channels);
  const zipBatch = folder.kind === "fsa" ? null : new ZipBatch();

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

/** Reads a CSS custom property's current value (theme-dependent), falling back if unset. */
function themeColor(varName, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  return v || fallback;
}

// Waveforms are canvas-drawn, so switching themes doesn't recolor them for free the way CSS-styled
// elements do - each drawn canvas registers a small repaint closure here, and applyTheme() replays
// them all. Entries for canvases no longer in the document are dropped the next time it runs.
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

/** Draws a waveform-with-markers preview. Sized to the canvas's actual rendered width for crispness. */
function drawWaveform(canvas, peaks, duration, chopMarkers, oneShotMarkers) {
  const rectWidth = Math.max(200, Math.round(canvas.getBoundingClientRect().width || 600));
  canvas.width = rectWidth;
  canvas.height = 72;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const mid = h / 2;

  ctx.clearRect(0, 0, w, h);

  const barWidth = w / peaks.length;
  ctx.fillStyle = themeColor("--wave-fill", "rgba(139, 124, 255, 0.55)");
  for (let i = 0; i < peaks.length; i++) {
    const amp = Math.max(1, peaks[i] * (h * 0.46));
    const x = i * barWidth;
    ctx.fillRect(x, mid - amp, Math.max(1, barWidth - 0.4), amp * 2);
  }

  if (duration > 0) {
    ctx.strokeStyle = themeColor("--wave-line", "rgba(237, 238, 243, 0.5)");
    ctx.lineWidth = 1;
    for (const [s, e] of chopMarkers || []) {
      for (const t of [s, e]) {
        const x = (t / duration) * w;
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
        ctx.stroke();
      }
    }

    ctx.fillStyle = themeColor("--wave-marker", "#56d0c8");
    for (const [s] of oneShotMarkers || []) {
      const x = (s / duration) * w;
      ctx.beginPath();
      ctx.moveTo(x - 3, 0);
      ctx.lineTo(x + 3, 0);
      ctx.lineTo(x, 6);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/**
 * Interactive version of the waveform preview: existing chop-boundary handles can be dragged
 * (pointer events, so mouse/touch/pen all work), new regions can be inserted with "+ Add region",
 * and any region can be removed from the chip list under the waveform. Returns {canvas, getRegions,
 * destroy}.
 */
function formatEditorTime(t) {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2);
  return m > 0 ? `${m}:${s.padStart(5, "0")}` : `${s}s`;
}

/**
 * Draggable waveform region editor: start/end handles per region, mouse-wheel zoom (centered on
 * the cursor) plus Zoom in/out/Fit buttons, click-drag panning once zoomed in, and a dragged
 * handle snaps to the nearest zero-crossing when released so edited cuts stay click-free just
 * like the auto-exported ones. `mono`/`sampleRate` are optional - without them (shouldn't happen
 * in normal use) zoom just shows a flat waveform and snapping is skipped.
 */
function createEditableWaveform({ mono, sampleRate, duration, initialRegions }) {
  const wrap = document.createElement("div");
  wrap.className = "editable-waveform";

  const toolbar = document.createElement("div");
  toolbar.className = "editable-waveform-toolbar";
  const zoomOutBtn = document.createElement("button");
  zoomOutBtn.type = "button";
  zoomOutBtn.className = "btn btn--ghost btn--small";
  zoomOutBtn.textContent = "Zoom out";
  const zoomInBtn = document.createElement("button");
  zoomInBtn.type = "button";
  zoomInBtn.className = "btn btn--ghost btn--small";
  zoomInBtn.textContent = "Zoom in";
  const fitBtn = document.createElement("button");
  fitBtn.type = "button";
  fitBtn.className = "btn btn--ghost btn--small";
  fitBtn.textContent = "Fit";
  const addRegionBtn = document.createElement("button");
  addRegionBtn.type = "button";
  addRegionBtn.className = "btn btn--ghost btn--small";
  addRegionBtn.textContent = "+ Add region";
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "editable-waveform-zoom-label";
  toolbar.append(zoomOutBtn, zoomInBtn, fitBtn, addRegionBtn, zoomLabel);
  wrap.appendChild(toolbar);

  const canvas = document.createElement("canvas");
  canvas.className = "waveform-canvas waveform-canvas--editable";
  wrap.appendChild(canvas);
  registerThemeRepaint(canvas, () => redraw());

  const regionList = document.createElement("div");
  regionList.className = "editable-waveform-region-list";
  wrap.appendChild(regionList);

  const regions = initialRegions.map(([s, e]) => ({ s, e }));
  const MIN_GAP_SEC = 0.03;
  const MIN_VIEW_SEC = Math.min(Math.max(duration, 0.001), 0.25);
  const BIN_COUNT = 600;
  let viewStart = 0;
  let viewDuration = Math.max(duration, MIN_VIEW_SEC);
  let dragging = null; // { kind: 'handle', idx, which: 's'|'e' } or { kind: 'pan', startClientX, startViewStart }

  function xToTime(xRelative, rectWidth) {
    return rectWidth > 0 ? viewStart + (xRelative / rectWidth) * viewDuration : viewStart;
  }
  function timeToX(t, w) {
    return viewDuration > 0 ? ((t - viewStart) / viewDuration) * w : 0;
  }

  function setView(newStart, newDuration) {
    viewDuration = Math.max(MIN_VIEW_SEC, Math.min(duration, newDuration));
    viewStart = Math.max(0, Math.min(Math.max(0, duration - viewDuration), newStart));
    redraw();
  }

  function zoomAt(anchorTime, factor) {
    const newDuration = viewDuration / factor;
    const ratio = viewDuration > 0 ? (anchorTime - viewStart) / viewDuration : 0.5;
    setView(anchorTime - ratio * newDuration, newDuration);
  }

  function snapToZeroCrossing(t) {
    if (!mono || !sampleRate) return t;
    const windowSamples = Math.max(1, Math.round((exportSettings.zcSearchMs / 1000) * sampleRate));
    const sampleIndex = Math.round(t * sampleRate);
    return findNearestZeroCrossing(mono, sampleIndex, windowSamples) / sampleRate;
  }

  function redraw() {
    const rectWidth = Math.max(200, Math.round(canvas.getBoundingClientRect().width || 600));
    canvas.width = rectWidth;
    canvas.height = 84;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const mid = h / 2;
    ctx.clearRect(0, 0, w, h);

    if (duration <= 0) {
      zoomLabel.textContent = "";
      return;
    }

    const peaks = mono ? computePeaksInRange(mono, viewStart * sampleRate, (viewStart + viewDuration) * sampleRate, BIN_COUNT) : null;
    if (peaks) {
      const barWidth = w / peaks.length;
      ctx.fillStyle = themeColor("--wave-fill", "rgba(139, 124, 255, 0.55)");
      for (let i = 0; i < peaks.length; i++) {
        const amp = Math.max(1, peaks[i] * (h * 0.46));
        ctx.fillRect(i * barWidth, mid - amp, Math.max(1, barWidth - 0.4), amp * 2);
      }
    }

    const regionColorA = themeColor("--wave-region-a", "rgba(86, 208, 200, 0.1)");
    const regionColorB = themeColor("--wave-region-b", "rgba(139, 124, 255, 0.1)");
    regions.forEach((r, idx) => {
      const x0 = Math.max(0, timeToX(r.s, w));
      const x1 = Math.min(w, timeToX(r.e, w));
      if (x1 <= x0) return; // region isn't in the visible window
      ctx.fillStyle = idx % 2 === 0 ? regionColorA : regionColorB;
      ctx.fillRect(x0, 0, x1 - x0, h);
    });
    const handleColor = themeColor("--wave-handle", "#edeef3");
    regions.forEach((r) => {
      for (const t of [r.s, r.e]) {
        const x = timeToX(t, w);
        if (x < -6 || x > w + 6) continue;
        ctx.strokeStyle = handleColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, mid, 5, 0, Math.PI * 2);
        ctx.fillStyle = handleColor;
        ctx.fill();
      }
    });

    const zoomX = viewDuration > 0 ? (duration / viewDuration).toFixed(1) : "1.0";
    zoomLabel.textContent = `${zoomX}x - ${formatEditorTime(viewStart)} to ${formatEditorTime(viewStart + viewDuration)}`;
    zoomOutBtn.disabled = viewDuration >= duration - 1e-6;
    zoomInBtn.disabled = viewDuration <= MIN_VIEW_SEC + 1e-6;
    fitBtn.disabled = zoomOutBtn.disabled;
  }

  // Lazily-created shared AudioContext for auditioning a region's current edited boundaries
  // straight from the in-memory mono downmix - no re-export/file-write needed, so it stays in
  // sync with drags/adds/removes as you make them. Mono only (this editor never has the full
  // stereo buffer around), which is plenty for judging a cut point.
  let audioCtx = null;
  let currentSource = null;

  function stopPreview() {
    if (currentSource) {
      try {
        currentSource.stop();
      } catch (_) {
        /* already stopped */
      }
      currentSource = null;
    }
  }

  function playRegionPreview(r, playBtn) {
    if (!mono || !sampleRate) return;
    stopPreview();
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    } catch (_) {
      return; // no Web Audio support - button silently does nothing rather than throwing
    }
    const startSample = Math.max(0, Math.round(r.s * sampleRate));
    const endSample = Math.min(mono.length, Math.round(r.e * sampleRate));
    if (endSample <= startSample) return;
    const buffer = audioCtx.createBuffer(1, endSample - startSample, sampleRate);
    buffer.getChannelData(0).set(mono.subarray(startSample, endSample));
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    playBtn.classList.add("is-playing");
    source.onended = () => {
      playBtn.classList.remove("is-playing");
      if (currentSource === source) currentSource = null;
    };
    source.start();
    currentSource = source;
  }

  /** Rebuilds the row of small "start-end [x]" chips under the canvas from the current `regions`. */
  function renderRegionList() {
    regionList.innerHTML = "";
    regions.forEach((r, idx) => {
      const chip = document.createElement("span");
      chip.className = "editable-waveform-region-chip";
      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "editable-waveform-region-play";
      playBtn.textContent = "▶";
      playBtn.title = "Preview this region";
      playBtn.addEventListener("click", () => playRegionPreview(r, playBtn));
      const label = document.createElement("span");
      label.textContent = `${idx + 1}: ${formatEditorTime(r.s)} to ${formatEditorTime(r.e)}`;
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.textContent = "×";
      removeBtn.title = "Remove this region";
      removeBtn.addEventListener("click", () => removeRegionAt(idx));
      chip.appendChild(playBtn);
      chip.appendChild(label);
      chip.appendChild(removeBtn);
      regionList.appendChild(chip);
    });
    if (regions.length === 0) {
      const empty = document.createElement("span");
      empty.className = "editable-waveform-region-chip";
      empty.textContent = "No regions - use “+ Add region” or Cancel";
      regionList.appendChild(empty);
    }
  }

  /** Inserts a new region centered in the current view, snapped to zero-crossings like a dragged handle. */
  function addRegionAtCenter() {
    const center = viewStart + viewDuration / 2;
    const defaultLen = Math.min(Math.max(duration, MIN_GAP_SEC), Math.max(0.05, viewDuration * 0.25));
    let s = Math.max(0, center - defaultLen / 2);
    let e = Math.min(duration, center + defaultLen / 2);
    if (mono) {
      s = snapToZeroCrossing(s);
      e = snapToZeroCrossing(e);
    }
    if (e - s < MIN_GAP_SEC) e = Math.min(duration, s + MIN_GAP_SEC);
    if (e - s < MIN_GAP_SEC) s = Math.max(0, e - MIN_GAP_SEC);
    regions.push({ s, e });
    regions.sort((a, b) => a.s - b.s);
    redraw();
    renderRegionList();
  }

  function removeRegionAt(idx) {
    regions.splice(idx, 1);
    redraw();
    renderRegionList();
  }

  addRegionBtn.addEventListener("click", addRegionAtCenter);

  function hitTest(clientX) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return null;
    const toleranceSec = (8 / rect.width) * viewDuration;
    const t = xToTime(clientX - rect.left, rect.width);
    let best = null;
    let bestDist = toleranceSec;
    regions.forEach((r, idx) => {
      for (const which of ["s", "e"]) {
        const d = Math.abs(r[which] - t);
        if (d < bestDist) {
          bestDist = d;
          best = { idx, which };
        }
      }
    });
    return best;
  }

  zoomInBtn.addEventListener("click", () => zoomAt(viewStart + viewDuration / 2, 1.8));
  zoomOutBtn.addEventListener("click", () => zoomAt(viewStart + viewDuration / 2, 1 / 1.8));
  fitBtn.addEventListener("click", () => setView(0, duration));

  canvas.addEventListener(
    "wheel",
    (ev) => {
      if (!mono || duration <= 0) return;
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchorTime = xToTime(ev.clientX - rect.left, rect.width);
      zoomAt(anchorTime, ev.deltaY < 0 ? 1.25 : 1 / 1.25);
    },
    { passive: false }
  );

  canvas.addEventListener("pointerdown", (ev) => {
    const hit = hitTest(ev.clientX);
    canvas.setPointerCapture(ev.pointerId);
    if (hit) {
      dragging = { kind: "handle", ...hit };
      canvas.classList.add("waveform-canvas--dragging");
    } else if (mono) {
      dragging = { kind: "pan", startClientX: ev.clientX, startViewStart: viewStart };
      canvas.classList.add("waveform-canvas--dragging");
    }
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    const rect = canvas.getBoundingClientRect();
    if (dragging.kind === "handle") {
      const r = regions[dragging.idx];
      let t = xToTime(ev.clientX - rect.left, rect.width);
      t = dragging.which === "s" ? Math.max(0, Math.min(r.e - MIN_GAP_SEC, t)) : Math.max(r.s + MIN_GAP_SEC, Math.min(duration, t));
      r[dragging.which] = t;
      redraw();
    } else if (dragging.kind === "pan") {
      const dxPx = ev.clientX - dragging.startClientX;
      const dtSec = -(dxPx / Math.max(1, rect.width)) * viewDuration;
      setView(dragging.startViewStart + dtSec, viewDuration);
    }
  });
  function endDrag() {
    if (dragging) canvas.classList.remove("waveform-canvas--dragging");
    if (dragging && dragging.kind === "handle") {
      const r = regions[dragging.idx];
      const snapped = snapToZeroCrossing(r[dragging.which]);
      r[dragging.which] =
        dragging.which === "s" ? Math.max(0, Math.min(r.e - MIN_GAP_SEC, snapped)) : Math.max(r.s + MIN_GAP_SEC, Math.min(duration, snapped));
      redraw();
      renderRegionList();
    }
    dragging = null;
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  redraw();
  renderRegionList();
  window.addEventListener("resize", redraw);

  return {
    el: wrap,
    getRegions: () => regions.map((r) => [r.s, r.e]),
    destroy: () => {
      stopPreview();
      window.removeEventListener("resize", redraw);
    },
  };
}

/** Swaps a result-file block into edit mode: draggable waveform + Save/Cancel, replacing the static view. */
/**
 * Swaps a result-file block into edit mode for either its chops or its one-shots (`kind`),
 * replacing the static view with a draggable waveform + Save/Cancel. Saving mutates just that
 * half of `state` (chopRows/chopMarkers or oneShotRows/oneShotMarkers) and re-renders the whole
 * card from it, so editing one never discards the other's already-exported results.
 */
function enterEditMode(block, state, staticArea, editBtn, kind) {
  const isChops = kind === "chops";
  staticArea.hidden = true;
  editBtn.disabled = true;

  const editorWrap = document.createElement("div");
  editorWrap.className = "chop-editor";

  const hint = document.createElement("p");
  hint.className = "chop-editor-hint";
  hint.textContent = `Drag the white handles to adjust cut points (they snap to the nearest zero-crossing when you let go), scroll to zoom, drag the waveform to pan. Use “+ Add region” to insert a new ${
    isChops ? "chop" : "one-shot"
  }, or the × on a chip below the waveform to remove one. Save re-exports.`;
  editorWrap.appendChild(hint);

  const editor = createEditableWaveform({
    mono: state.mono,
    sampleRate: state.sampleRate,
    duration: state.duration,
    initialRegions: isChops ? state.chopMarkers : state.oneShotMarkers,
  });
  editorWrap.appendChild(editor.el);

  const actions = document.createElement("div");
  actions.className = "modal-actions chop-editor-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn btn--ghost";
  cancelBtn.textContent = "Cancel";
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn--primary";
  saveBtn.textContent = "Save & re-export";
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  editorWrap.appendChild(actions);

  block.insertBefore(editorWrap, staticArea);

  function exit() {
    editor.destroy();
    editorWrap.remove();
    staticArea.hidden = false;
    editBtn.disabled = false;
  }

  cancelBtn.addEventListener("click", exit);
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    saveBtn.textContent = "Re-exporting…";
    try {
      const regions = editor.getRegions();
      if (isChops) {
        const result = await reExportSingleFile(state.editContext, regions);
        state.chopRows = result.chopRows;
        state.chopMarkers = result.chopMarkers;
        log(`  ${state.editContext.fileInfo.name}: re-exported ${result.chopRows.length} chop(s) with edited boundaries`);
      } else {
        const result = await reExportOneShots(state.editContext, regions);
        state.oneShotRows = result.rows;
        state.oneShotMarkers = result.markers;
        log(`  ${state.editContext.fileInfo.name}: re-exported ${result.rows.length} one-shot(s) with edited boundaries`);
      }
      const newBlock = renderFileResult(state);
      block.replaceWith(newBlock);
    } catch (err) {
      log(`  ERROR re-exporting ${state.editContext.fileInfo.name}: ${err.message || err}`);
      console.error(err);
      saveBtn.disabled = false;
      cancelBtn.disabled = false;
      saveBtn.textContent = "Save & re-export";
    }
  });
}

/**
 * Renders one processed file's result card from a mutable state object:
 * { fileName, keyText, bpmText, chopRows, chopMarkers, oneShotRows, oneShotMarkers, peaks,
 *   duration, mono, sampleRate, editContext }. The state object (not just the rendered DOM) is
 * what the chop/one-shot editors mutate on save, so re-exporting one of the two never discards
 * the other's already-exported rows - see enterEditMode.
 */
function renderFileResult(state) {
  const { fileName, keyText, bpmText, chopRows, oneShotRows, peaks, duration, chopMarkers, oneShotMarkers, editContext, chopSkipped } = state;

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
  let editChopsBtn = null;
  if (editContext && chopRows.length) {
    editChopsBtn = document.createElement("button");
    editChopsBtn.className = "btn btn--ghost btn--small";
    editChopsBtn.textContent = "Edit chops";
    actionsGroup.appendChild(editChopsBtn);
  }
  let editOneShotsBtn = null;
  if (editContext && oneShotRows.length) {
    editOneShotsBtn = document.createElement("button");
    editOneShotsBtn.className = "btn btn--ghost btn--small";
    editOneShotsBtn.textContent = "Edit one-shots";
    actionsGroup.appendChild(editOneShotsBtn);
  }
  if (actionsGroup.childElementCount) header.appendChild(actionsGroup);
  block.appendChild(header);

  const staticArea = document.createElement("div");
  staticArea.className = "result-file-static";

  if (peaks && peaks.length) {
    const canvas = document.createElement("canvas");
    canvas.className = "waveform-canvas";
    staticArea.appendChild(canvas);
    // Draw after layout so getBoundingClientRect reports the real rendered width.
    requestAnimationFrame(() => drawWaveform(canvas, peaks, duration, chopMarkers, oneShotMarkers));
    registerThemeRepaint(canvas, () => drawWaveform(canvas, peaks, duration, chopMarkers, oneShotMarkers));
  }

  staticArea.appendChild(renderChopList(chopRows));

  if (oneShotRows.length) {
    const oneShotHeading = document.createElement("div");
    oneShotHeading.className = "result-subheading";
    oneShotHeading.textContent = "One-shots";
    staticArea.appendChild(oneShotHeading);
    staticArea.appendChild(renderChopList(oneShotRows));
  }

  block.appendChild(staticArea);

  if (editChopsBtn) {
    editChopsBtn.addEventListener("click", () => enterEditMode(block, state, staticArea, editChopsBtn, "chops"));
  }
  if (editOneShotsBtn) {
    editOneShotsBtn.addEventListener("click", () => enterEditMode(block, state, staticArea, editOneShotsBtn, "oneshots"));
  }

  return block;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------------
// Preview: audition the current time-stretch/lo-fi settings on a short excerpt of the first
// queued file, without running a full export or writing any files.
// ---------------------------------------------------------------------------

let previewObjectUrl = null;
const PREVIEW_LEN_SEC = 6;

function firstPreviewTarget() {
  for (const folder of sourceFolders) {
    if (folder.files.length > 0) return folder.files[0];
  }
  return null;
}

async function runPreview() {
  const fileInfo = firstPreviewTarget();
  if (!fileInfo) return;

  previewRunning = true;
  updateProcessButton();
  previewStatus.textContent = "Generating preview…";
  try {
    const file = fileInfo.fsaHandle ? await fileInfo.fsaHandle.getFile() : fileInfo.legacyFile;
    const { buffer } = await decodeFile(file, fileInfo.ext);
    const channels = bufferChannels(buffer);
    const mono = toMono(channels);
    const duration = mono.length / buffer.sampleRate;

    // Tempo is only needed if "match a target tempo" is the active stretch mode - skip essentia
    // entirely otherwise so a quick preview stays quick.
    let detectedBpm = null;
    if (timestretchSettings.enabled && timestretchSettings.mode === "target-tempo") {
      const kt = await analyzeKeyAndTempo(mono, buffer.sampleRate, { key: false, tempo: true });
      detectedBpm = kt.bpm;
    }

    const previewLen = Math.min(PREVIEW_LEN_SEC, duration);
    let startSample = duration > previewLen ? Math.round(((duration - previewLen) / 2) * buffer.sampleRate) : 0;
    let endSample = Math.min(mono.length, startSample + Math.round(previewLen * buffer.sampleRate));
    const zcWindow = Math.round((exportSettings.zcSearchMs / 1000) * buffer.sampleRate);
    if (zcWindow > 0) {
      startSample = findNearestZeroCrossing(mono, startSample, zcWindow);
      endSample = findNearestZeroCrossing(mono, endSample, zcWindow);
    }
    if (endSample <= startSample) endSample = Math.min(mono.length, startSample + 1);

    const stretchRatio = resolveStretchRatio(detectedBpm);
    const [{ blob, seconds }] = await processRegionsHeavy({
      sampleRate: buffer.sampleRate,
      bitDepth: exportSettings.bitDepth,
      fadeInSamples: Math.round(0.01 * buffer.sampleRate),
      fadeOutSamples: Math.round(0.01 * buffer.sampleRate),
      stretchRatio,
      character: timestretchSettings.character,
      regions: [{ channels: sliceChannels(channels, startSample, endSample) }],
    });

    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = URL.createObjectURL(blob);
    previewAudio.src = previewObjectUrl;
    previewAudio.hidden = false;
    const appliedBits = [];
    if (stretchRatio !== 1) appliedBits.push("time-stretch");
    if (lofiActive()) appliedBits.push("lo-fi");
    previewStatus.textContent = `Previewing "${fileInfo.name}" - ${seconds.toFixed(1)}s excerpt${
      appliedBits.length ? ` with ${appliedBits.join(" + ")}` : " (no processing enabled)"
    }.`;
    await previewAudio.play().catch(() => {
      /* autoplay can still be blocked in some contexts - the controls are there regardless */
    });
  } catch (err) {
    previewStatus.textContent = `Couldn't generate a preview: ${err.message || err}`;
    console.error(err);
  } finally {
    previewRunning = false;
    updateProcessButton();
  }
}

previewBtn.addEventListener("click", runPreview);

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

async function processBatch() {
  processing = true;
  cancelRequested = false;
  cancelBtn.disabled = false;
  cancelBtn.textContent = "Cancel";
  updateProcessButton();
  clearLog();
  resultsPanel.innerHTML = "";
  drumTempoSkipPolicy = null;

  const zipBatch = FSA_SUPPORTED ? null : new ZipBatch();
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

    if (folder.kind === "fsa") {
      const ok = await ensureReadWritePermission(folder.handle);
      if (!ok) {
        log("  Permission to write to this folder was denied, skipped");
        continue;
      }
    }

    const folderSection = renderFolderResultSection(folder);

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

  log(`${cancelRequested ? "Cancelled." : "Done."} Processed ${processedFolders} folder(s), created ${totalChops} candidate chop(s).`);
  processing = false;
  cancelRequested = false;
  updateProcessButton();
  progressRow.hidden = true;
}

processBtn.addEventListener("click", () => {
  if (!processing) processBatch();
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
  applyTheme(loadTheme(), { persist: false });
  applyUiMode(loadUiMode(), { persist: false });
  applySettings(loadSettings());
  updateNamingPreview(); // outside applySettings so it also runs for first-time visitors with nothing saved yet

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
  }
}

init();

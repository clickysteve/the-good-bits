// controller.js
//
// FLIP: give me this loop back, but wrong.
//
// Drop in one musically coherent loop; FLIP proposes alternative interpretations of it. Not a
// slicer, not a pad instrument, not a sequencer - the user supplies the musical intent and this
// supplies the accidents. Every control on screen exists because it changes the CHARACTER of what
// gets proposed; anything that would only let you specify an individual edit was deliberately left
// out, because specifying edits is what a DAW is for.
//
// PIPELINE, in four separable stages, each its own module:
//
//   analyse source   js/essentia-bridge.js (shared with the rest of the app - FLIP does not have
//                    its own tempo detector) + a manual correction, exactly as STRETCH does it
//   slice map        js/flip/slice-map.js      where the cuts are, and what each one means musically
//   recipe           js/flip/recipe.js + operations.js + styles.js   what to do, as instructions
//   render           js/flip/render.js         instructions -> samples, once, into exact-length buffers
//
// This file owns none of that. It owns SESSION STATE and the screen: what's loaded, what's been
// generated, what's playing, what's stale, and what gets written when you press Export.
//
// WHY ITS OWN STATE, like PLAY NICE and unlike STRETCH: FLIP works on one loop, not on the shared
// source queue, and it has its own settings, its own results and its own export destination. Adding
// a dozen more module-level variables to js/app.js to describe a workflow that shares nothing with
// the batch pipeline would put CHOP/STRETCH/BOTH at risk for no benefit.
//
// EIGHT RENDERED VARIATIONS, NOT EIGHT LAZY ONES. Rendering a recipe is array copying - a four-bar
// loop takes single-digit milliseconds - so the whole batch is rendered up front and held as plain
// Float32Arrays. Auditioning is then instant and identical to export, there is no "render on first
// play" stall in the middle of clicking down the list, and the export path has nothing to re-derive.
// Generating a new batch destroys the previous one's players and drops its buffers first.
import { createSliceMap, sliceMapReadiness, describeSliceMap, SUBDIVISIONS, DEFAULT_SUBDIVISION, resolveSubdivision } from "./slice-map.js";
import { generateRecipe, describeRecipe, recipePattern, recipeDeparture } from "./recipe.js";
import { renderVariationAudio } from "./render.js";
import { STYLES, DEFAULT_STYLE, resolveStyle, describeIntensity } from "./styles.js";
import { variationFileName, batchFolderName, uniqueName } from "./naming.js";
import { createVariationRow } from "./variation-row.js";
import { makeRng } from "../dsp/stretch/rng.js";
import { toMono } from "../dsp.js";
import { encodeWav } from "../audio-codec.js";
import { sanitizeSourceBpm, resolveEffectiveTempo, formatBpmText } from "../tempo-override.js";
import { AUDIO_EXTS } from "../io-fs.js";
import { readJSON, writeJSON } from "../local-storage.js";

const STORAGE_KEY = "good-bits-flip-v1";
const DEFAULT_BATCH_SIZE = 8;
const BATCH_SIZES = [4, 8, 12, 16];
const DEFAULT_BIT_DEPTH = 24;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function extOf(name) {
  const dot = String(name || "").lastIndexOf(".");
  return dot === -1 ? "" : String(name).slice(dot).toLowerCase();
}

function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.container
 * @param {HTMLElement} deps.chromeContainer   where the fixed bottom bar mounts (the app shell)
 * @param {(file:File, ext:string) => Promise<{buffer:object}>} deps.decodeFile
 * @param {(mono:Float32Array, sampleRate:number, want:object) => Promise<object>} deps.analyze
 * @param {() => AudioContext} deps.getAudioContext
 * @param {(name:string, fallback:string) => string} deps.color
 * @param {(msg:string) => void} deps.log
 * @param {(msg:string) => void} deps.logWarn
 * @param {(msg:string) => void} deps.logSuccess
 * @param {object} deps.io  {supportsFSA, pickFiles, pickFolder, ensurePermission, writeFile, ZipBatch}
 */
export function createFlip(deps) {
  const { container, chromeContainer, decodeFile, analyze, getAudioContext, color, log, logWarn, logSuccess, io } = deps;

  const state = {
    file: null,
    name: "",
    audio: null, // {channels, mono, sampleRate, duration}
    detected: null, // {bpm, key, scale}
    bpmOverride: null,
    analysisAvailable: false,
    status: "empty", // empty | decoding | analysing | ready | error
    error: null,
    subdivision: DEFAULT_SUBDIVISION,
    intensity: 45,
    style: DEFAULT_STYLE,
    // A musical preference, not a law - see the checkbox in the controls panel.
    keepDownbeats: true,
    batchSize: DEFAULT_BATCH_SIZE,
    bitDepth: DEFAULT_BIT_DEPTH,
    looping: true,
    variations: [],
    exportDir: null,
    busy: false,
    progress: null,
  };

  restore();

  // The ONLY non-deterministic thing in FLIP. Seeds have to come from somewhere, and once minted
  // every downstream decision is a pure function of (source, settings, seed) - so a variation is
  // reproducible forever from the number printed on its row and in its filename. Deliberately not
  // scattered Math.random() calls inside the remix algorithms, which would make a result that
  // sounded good impossible to get back.
  const seedSource = makeRng((Date.now() ^ 0x5f3759df) >>> 0);
  function mintSeed() {
    return Math.floor(seedSource.next() * 900000000) + 1000;
  }

  let generation = 0; // bumped whenever a batch is superseded, so an in-flight one can bail
  let nextRowId = 1;

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  const root = el("div", "flip");
  container.appendChild(root);

  // ---- source ------------------------------------------------------------

  const sourcePanel = el("section", "flip-panel flip-source");
  const sourceHead = el("div", "flip-panel-head");
  sourceHead.appendChild(el("h2", "flip-panel-title", "Loop"));
  const sourceSummary = el("span", "flip-source-summary");
  sourceHead.appendChild(sourceSummary);
  sourcePanel.appendChild(sourceHead);

  const dropzone = el("div", "flip-dropzone");
  const dropCopy = el("div", "flip-dropzone-copy");
  dropCopy.appendChild(el("strong", null, "Drop a loop here"));
  dropCopy.appendChild(el("span", null, "one musical loop - a bar, two bars, four bars. FLIP gives it back to you wrong."));
  const dropActions = el("div", "flip-dropzone-actions");
  const addBtn = el("button", "btn btn--primary", "Add a loop");
  addBtn.type = "button";
  const replaceBtn = el("button", "btn btn--ghost btn--small", "Replace");
  replaceBtn.type = "button";
  dropActions.appendChild(addBtn);
  dropzone.append(dropCopy, dropActions);
  sourcePanel.appendChild(dropzone);

  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.accept = [...AUDIO_EXTS].join(",");
  fileInput.hidden = true;
  sourcePanel.appendChild(fileInput);

  const loaded = el("div", "flip-loaded");
  loaded.hidden = true;
  const loadedHead = el("div", "flip-loaded-head");
  const loadedName = el("span", "flip-loaded-name");
  const loadedActions = el("div", "flip-loaded-actions");
  loadedActions.appendChild(replaceBtn);
  const clearBtn = el("button", "btn btn--ghost btn--small", "×");
  clearBtn.type = "button";
  clearBtn.title = "Remove this loop and everything generated from it";
  loadedActions.appendChild(clearBtn);
  loadedHead.append(loadedName, loadedActions);
  loaded.appendChild(loadedHead);

  const sourceStatus = el("p", "flip-source-status");
  loaded.appendChild(sourceStatus);

  // Tempo correction - the same ANALYSIS PROPOSES, USER OVERRIDES split the rest of the app uses
  // (js/tempo-override.js). It matters more here than anywhere else: the tempo IS the slice grid,
  // so a half-time detection doesn't just mislabel the file, it halves the resolution of every
  // variation you generate from it.
  const tempoRow = el("div", "flip-tempo-row");
  tempoRow.appendChild(el("span", "flip-tempo-label", "Tempo"));
  const bpmInput = el("input", "flip-bpm-input");
  bpmInput.type = "number";
  bpmInput.min = "20";
  bpmInput.max = "400";
  bpmInput.step = "0.01";
  bpmInput.title = "The tempo the slice grid is built from. Correct it if detection got it wrong.";
  const halveBtn = el("button", "btn btn--ghost btn--small", "½");
  halveBtn.type = "button";
  halveBtn.title = "Half-time - detection heard double";
  const doubleBtn = el("button", "btn btn--ghost btn--small", "×2");
  doubleBtn.type = "button";
  doubleBtn.title = "Double-time - detection heard half";
  const resetBpmBtn = el("button", "btn btn--ghost btn--small", "Reset");
  resetBpmBtn.type = "button";
  resetBpmBtn.title = "Back to what was detected";
  const tempoNote = el("span", "flip-tempo-note");
  tempoRow.append(bpmInput, halveBtn, doubleBtn, resetBpmBtn, tempoNote);
  loaded.appendChild(tempoRow);
  sourcePanel.appendChild(loaded);
  root.appendChild(sourcePanel);

  // ---- controls ----------------------------------------------------------

  const controlsPanel = el("section", "flip-panel flip-controls");
  const controlsHead = el("div", "flip-panel-head");
  controlsHead.appendChild(el("h2", "flip-panel-title", "How wrong"));
  const gridSummary = el("span", "flip-grid-summary");
  controlsHead.appendChild(gridSummary);
  controlsPanel.appendChild(controlsHead);

  const sliceField = el("div", "field flip-field");
  sliceField.appendChild(el("label", null, "Slice size"));
  const sliceSeg = el("div", "seg flip-seg");
  sliceSeg.setAttribute("role", "group");
  sliceSeg.setAttribute("aria-label", "Slice size");
  const sliceButtons = new Map();
  for (const sub of SUBDIVISIONS) {
    const btn = el("button", "seg-btn", sub.label);
    btn.type = "button";
    btn.title = `Cut on ${sub.hint}`;
    btn.addEventListener("click", () => setSubdivision(sub.key));
    sliceSeg.appendChild(btn);
    sliceButtons.set(sub.key, btn);
  }
  sliceField.appendChild(sliceSeg);
  controlsPanel.appendChild(sliceField);

  const intensityField = el("div", "field flip-field");
  const intensityLabel = el("label", null, "Intensity");
  intensityLabel.htmlFor = "flip-intensity";
  intensityField.appendChild(intensityLabel);
  const intensityRow = el("div", "slider-row");
  const intensitySlider = el("input");
  intensitySlider.id = "flip-intensity";
  intensitySlider.type = "range";
  intensitySlider.min = "0";
  intensitySlider.max = "100";
  intensitySlider.step = "1";
  const intensityNumber = el("input", "slider-number");
  intensityNumber.type = "number";
  intensityNumber.min = "0";
  intensityNumber.max = "100";
  intensityNumber.step = "1";
  const intensityWord = el("span", "flip-intensity-word");
  intensityRow.append(intensitySlider, intensityNumber, intensityWord);
  intensityField.appendChild(intensityRow);
  intensityField.appendChild(el("p", "mod-note", "Low keeps most of the phrase and edits around the downbeats. High restructures freely and starts cutting below the slice size."));
  controlsPanel.appendChild(intensityField);

  const styleField = el("div", "field flip-field");
  styleField.appendChild(el("label", null, "Style"));
  const styleChips = el("div", "flip-chips");
  const styleButtons = new Map();
  for (const style of STYLES) {
    const chip = el("button", "flip-chip", style.label);
    chip.type = "button";
    chip.title = style.blurb;
    chip.addEventListener("click", () => setStyle(style.key));
    styleChips.appendChild(chip);
    styleButtons.set(style.key, chip);
  }
  styleField.appendChild(styleChips);
  const styleBlurb = el("p", "mod-note flip-style-blurb");
  styleField.appendChild(styleBlurb);
  controlsPanel.appendChild(styleField);

  // Downbeat preservation. On by default because it is what makes most results sound intentional,
  // and switchable because "give me this loop back, but wrong" is a poor reason to refuse to touch
  // the strong beats. Off, edits stop being weighted away from strong positions AND stop being
  // anchored to the beat grid at all - see generateRecipe() and groupLen()/jumpDistance().
  const downbeatField = el("label", "check flip-check");
  const downbeatCheckbox = el("input");
  downbeatCheckbox.type = "checkbox";
  downbeatCheckbox.addEventListener("change", () => {
    state.keepDownbeats = downbeatCheckbox.checked;
    save();
    markStale();
    render();
  });
  downbeatField.append(downbeatCheckbox, el("span", null, "Keep downbeats"));
  controlsPanel.appendChild(downbeatField);
  controlsPanel.appendChild(
    el(
      "p",
      "mod-note flip-check-note",
      "On, edits land on the beat and mostly leave the strong beats alone. Off, FLIP cuts wherever it likes - groups and jumps stop being whole numbers of beats, so things land off the grid and the phrase drags out of phase."
    )
  );

  const gridWarning = el("p", "flip-warning");
  gridWarning.hidden = true;
  controlsPanel.appendChild(gridWarning);

  root.appendChild(controlsPanel);

  // ---- results -----------------------------------------------------------

  const listPanel = el("section", "flip-panel flip-results");
  const listHead = el("div", "flip-panel-head");
  listHead.appendChild(el("h2", "flip-panel-title", "Variations"));
  const listSummary = el("span", "flip-list-summary");
  listHead.appendChild(listSummary);
  listPanel.appendChild(listHead);

  const emptyNote = el("p", "flip-empty");
  listPanel.appendChild(emptyNote);

  const rowList = el("div", "flip-row-list");
  listPanel.appendChild(rowList);
  root.appendChild(listPanel);

  // The original always sits at the top of the same list, in the same shape as the variations, so
  // ORIGINAL -> FLIP 1 -> FLIP 2 is one continuous click-down rather than a comparison you have to
  // set up. A/B is the whole point of generating alternatives.
  const originalRow = createVariationRow({
    id: "ORIGINAL",
    isOriginal: true,
    getAudioContext,
    color,
    loop: state.looping,
  });
  rowList.appendChild(originalRow.el);

  // ---- bottom bar --------------------------------------------------------

  const bar = el("div", "flip-bar");
  bar.hidden = true;
  const barInner = el("div", "flip-bar-inner");

  const generateBtn = el("button", "flip-generate", "GENERATE 8");
  generateBtn.type = "button";
  generateBtn.title = "Throw away this batch and propose a fresh one";
  generateBtn.addEventListener("click", () => void generateBatch());

  const sizeSelect = el("select", "flip-size-select");
  sizeSelect.title = "How many variations per batch";
  for (const n of BATCH_SIZES) {
    const opt = el("option", null, `${n} at a time`);
    opt.value = String(n);
    sizeSelect.appendChild(opt);
  }
  sizeSelect.addEventListener("change", () => {
    state.batchSize = Number(sizeSelect.value) || DEFAULT_BATCH_SIZE;
    save();
    render();
  });

  const loopBtn = el("button", "btn btn--ghost btn--small flip-loop-btn", "Loop");
  loopBtn.type = "button";
  loopBtn.title = "Repeat while auditioning, so you can hear whether it works as an actual loop";
  loopBtn.addEventListener("click", () => {
    state.looping = !state.looping;
    for (const row of allRows()) row.setLoop(state.looping);
    save();
    render();
  });

  const depthSelect = el("select", "flip-depth-select");
  depthSelect.title = "Export bit depth";
  for (const depth of [24, 16]) {
    const opt = el("option", null, `${depth}-bit`);
    opt.value = String(depth);
    depthSelect.appendChild(opt);
  }
  depthSelect.addEventListener("change", () => {
    state.bitDepth = Number(depthSelect.value) || DEFAULT_BIT_DEPTH;
    save();
  });

  const exportAllBtn = el("button", "btn btn--small", "Export all");
  exportAllBtn.type = "button";
  exportAllBtn.title = "Write every variation in this batch";
  exportAllBtn.addEventListener("click", () => void exportAll());

  const status = el("span", "flip-bar-status");

  const barControls = el("div", "flip-bar-controls");
  barControls.append(generateBtn, sizeSelect, loopBtn);
  const barActions = el("div", "flip-bar-actions");
  barActions.append(depthSelect, exportAllBtn);
  barInner.append(barControls, status, barActions);
  bar.appendChild(barInner);
  chromeContainer.appendChild(bar);

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  intensitySlider.addEventListener("input", () => setIntensity(Number(intensitySlider.value)));
  intensityNumber.addEventListener("change", () => setIntensity(Number(intensityNumber.value)));

  function setSubdivision(key) {
    if (state.subdivision === key) return;
    state.subdivision = resolveSubdivision(key).key;
    save();
    markStale();
    render();
  }

  function setIntensity(value) {
    const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    if (state.intensity === v) return;
    state.intensity = v;
    save();
    markStale();
    render();
  }

  function setStyle(key) {
    if (state.style === key) return;
    state.style = resolveStyle(key).key;
    save();
    markStale();
    render();
  }

  function save() {
    writeJSON(STORAGE_KEY, {
      subdivision: state.subdivision,
      intensity: state.intensity,
      style: state.style,
      batchSize: state.batchSize,
      bitDepth: state.bitDepth,
      looping: state.looping,
      keepDownbeats: state.keepDownbeats,
    });
  }

  function restore() {
    const saved = readJSON(STORAGE_KEY);
    if (!saved) return;
    if (saved.subdivision) state.subdivision = resolveSubdivision(saved.subdivision).key;
    if (Number.isFinite(saved.intensity)) state.intensity = Math.max(0, Math.min(100, Math.round(saved.intensity)));
    if (saved.style) state.style = resolveStyle(saved.style).key;
    if (BATCH_SIZES.includes(saved.batchSize)) state.batchSize = saved.batchSize;
    if (saved.bitDepth === 16 || saved.bitDepth === 24) state.bitDepth = saved.bitDepth;
    if (typeof saved.looping === "boolean") state.looping = saved.looping;
    if (typeof saved.keepDownbeats === "boolean") state.keepDownbeats = saved.keepDownbeats;
  }

  // -------------------------------------------------------------------------
  // Source
  // -------------------------------------------------------------------------

  addBtn.addEventListener("click", () => void pickFile());
  replaceBtn.addEventListener("click", () => void pickFile());
  clearBtn.addEventListener("click", () => clearSource());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = "";
    if (file) void loadFile(file);
  });

  async function pickFile() {
    if (io.supportsFSA) {
      try {
        // io.pickFiles() hands back FileSystemFileHandles, not Files - same as PLAY NICE.
        const handles = await io.pickFiles({ multiple: false });
        if (!handles || !handles.length) return; // cancelled
        const files = await Promise.all(handles.map((h) => h.getFile()));
        if (files.length) void loadFile(files[0]);
        return;
      } catch (err) {
        logWarn(`File picker failed: ${err.message || err}`);
        return;
      }
    }
    fileInput.click();
  }

  wireDropZone(root, (files) => {
    const audio = files.filter((f) => AUDIO_EXTS.has(extOf(f.name)));
    if (!audio.length) {
      logWarn("FLIP takes one audio loop - that wasn't audio.");
      return;
    }
    if (audio.length > 1) log(`FLIP works on one loop at a time - using "${audio[0].name}".`);
    void loadFile(audio[0]);
  });

  async function loadFile(file) {
    // A new source invalidates everything: the seeds still reproduce their recipes, but a recipe
    // against different audio is a different piece of music, so keeping the old batch on screen
    // would be a lie about what you are listening to.
    clearVariations();
    stopAllPlayback();
    state.file = file;
    state.name = file.name;
    state.audio = null;
    state.detected = null;
    state.bpmOverride = null;
    state.analysisAvailable = false;
    state.error = null;
    state.status = "decoding";
    render();

    try {
      const { buffer } = await decodeFile(file, extOf(file.name));
      const channels = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
      if (!channels.length || !channels[0].length) throw new Error("there's no audio in that file");
      state.audio = { channels, mono: toMono(channels), sampleRate: buffer.sampleRate, duration: channels[0].length / buffer.sampleRate };
      originalRow.setAudio(state.audio);
      log(`FLIP loaded ${file.name} - ${state.audio.duration.toFixed(2)}s, ${channels.length === 1 ? "mono" : `${channels.length} ch`}, ${buffer.sampleRate} Hz.`);

      state.status = "analysing";
      render();
      await yieldToUi();

      // Key is analysed as well as tempo purely so the log line matches what the rest of the app
      // reports about a file. Only the tempo is used - FLIP rearranges time, it doesn't transpose.
      const result = await analyze(state.audio.mono, state.audio.sampleRate, { key: true, tempo: true });
      state.detected = { bpm: result.bpm ?? null, key: result.key ?? null, scale: result.scale ?? null };
      state.analysisAvailable = !!result.available;
      state.status = "ready";
      log(`  ${file.name}: ${state.detected.bpm ? `${Math.round(state.detected.bpm)} BPM` : state.analysisAvailable ? "no confident tempo" : "tempo detection unavailable"}.`);
    } catch (err) {
      state.status = "error";
      state.error = err.message || String(err);
      logWarn(`FLIP couldn't use "${file.name}": ${state.error}`);
    }
    render();
  }

  function clearSource() {
    stopAllPlayback();
    clearVariations();
    state.file = null;
    state.name = "";
    state.audio = null;
    state.detected = null;
    state.bpmOverride = null;
    state.status = "empty";
    state.error = null;
    originalRow.setAudio(null);
    render();
  }

  bpmInput.addEventListener("change", () => {
    const sanitized = sanitizeSourceBpm(bpmInput.value);
    if (sanitized == null) {
      render(); // invalid - put the current value back rather than silently accepting nonsense
      return;
    }
    state.bpmOverride = sanitized;
    markStale();
    render();
  });
  halveBtn.addEventListener("click", () => nudgeTempo(0.5));
  doubleBtn.addEventListener("click", () => nudgeTempo(2));
  resetBpmBtn.addEventListener("click", () => {
    state.bpmOverride = null;
    markStale();
    render();
  });

  function nudgeTempo(factor) {
    const current = effectiveBpm();
    if (current == null) return;
    const sanitized = sanitizeSourceBpm(current * factor);
    if (sanitized == null) return;
    state.bpmOverride = sanitized;
    markStale();
    render();
  }

  function effectiveBpm() {
    return resolveEffectiveTempo(state.bpmOverride, state.detected && state.detected.bpm);
  }

  /** The slice map for the current source and settings, or null when there's nothing to slice. */
  function currentMap() {
    if (!state.audio) return null;
    return createSliceMap({
      totalSamples: state.audio.channels[0].length,
      sampleRate: state.audio.sampleRate,
      bpm: effectiveBpm(),
      subdivision: state.subdivision,
    });
  }

  /** Everything a generated variation depends on besides its own seed. */
  function settingsSignature() {
    const map = currentMap();
    return JSON.stringify([state.name, state.subdivision, state.intensity, state.style, state.keepDownbeats, map ? map.count : 0, map ? Math.round((map.bpm || 0) * 100) : 0]);
  }

  /** Flag the on-screen batch as generated under settings that have since changed. */
  function markStale() {
    const signature = settingsSignature();
    for (const variation of state.variations) variation.stale = variation.signature !== signature;
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  function allRows() {
    return [originalRow, ...state.variations.map((v) => v.row)];
  }

  function stopAllPlayback() {
    for (const row of allRows()) row.stop();
  }

  /** Destroy the batch's players and drop its buffers, so a new batch doesn't pile up on the old. */
  function clearVariations() {
    for (const variation of state.variations) {
      variation.row.destroy();
      variation.audio = null;
      variation.recipe = null;
    }
    state.variations.length = 0;
  }

  async function generateBatch() {
    if (state.busy) return; // rapid clicking generates one batch, not five overlapping ones
    const map = currentMap();
    const readiness = sliceMapReadiness(map);
    if (!map || !readiness.ok) {
      logWarn(readiness.reason || "FLIP needs a loop first.");
      render();
      return;
    }

    const myGeneration = ++generation;
    state.busy = true;
    stopAllPlayback();
    clearVariations();
    render();

    const signature = settingsSignature();
    const count = state.batchSize;
    const styleLabel = resolveStyle(state.style).label;
    log(`FLIP generating ${count} variations - ${describeSliceMap(map)}, ${styleLabel}, intensity ${state.intensity} (${describeIntensity(state.intensity)})${state.keepDownbeats ? "" : ", downbeats unprotected"}.`);

    for (let i = 0; i < count; i++) {
      if (myGeneration !== generation) break; // superseded - stop rather than filling a stale list
      state.progress = `generating ${i + 1}/${count}`;
      renderBar();
      const variation = buildVariation({ map, signature, index: i + 1, seed: mintSeed() });
      state.variations.push(variation);
      rowList.appendChild(variation.row.el);
      refreshVariationRow(variation);
      // Yield between variations so rows appear as they land rather than all at once at the end -
      // on a long loop at 1/32 that's the difference between "working" and "frozen".
      await yieldToUi();
    }

    state.progress = null;
    state.busy = false;
    if (myGeneration === generation) {
      logSuccess(`FLIP proposed ${state.variations.length} variation${state.variations.length === 1 ? "" : "s"}.`);
    }
    render();
  }

  /** Generate + render one variation. Pure inputs -> everything the row needs. */
  function buildVariation({ map, signature, index, seed }) {
    const recipe = generateRecipe({ map, style: state.style, intensity: state.intensity, seed, keepDownbeats: state.keepDownbeats });
    const audio = renderVariationAudio({
      recipe,
      map,
      channels: state.audio.channels,
      sampleRate: state.audio.sampleRate,
    });
    return {
      id: nextRowId++,
      index,
      seed: recipe.seed,
      recipe,
      audio,
      signature,
      stale: false,
      row: createVariationRow({
        id: `FLIP ${String(index).padStart(2, "0")}`,
        getAudioContext,
        color,
        loop: state.looping,
        onSeedChange: (value) => regenerate(index, value),
        onRegenerate: () => regenerate(index, mintSeed()),
        onExport: () => exportOne(index),
      }),
    };
  }

  /**
   * Replace a single variation in place, keeping its position in the list. This is what makes a
   * batch worth sitting with: seven good ones and one dud is a one-click fix, not a reason to
   * throw the whole batch away and lose the seven.
   */
  function regenerate(index, seed) {
    const slot = state.variations.findIndex((v) => v.index === index);
    if (slot === -1 || state.busy) return;
    const map = currentMap();
    const readiness = sliceMapReadiness(map);
    if (!map || !readiness.ok) {
      logWarn(readiness.reason || "Nothing to regenerate from.");
      return;
    }
    const old = state.variations[slot];
    const wasPlaying = old.row.isPlaying();
    old.row.stop();

    const recipe = generateRecipe({ map, style: state.style, intensity: state.intensity, seed, keepDownbeats: state.keepDownbeats });
    old.recipe = recipe;
    old.seed = recipe.seed;
    old.audio = renderVariationAudio({ recipe, map, channels: state.audio.channels, sampleRate: state.audio.sampleRate });
    old.signature = settingsSignature();
    old.stale = false;
    refreshVariationRow(old);
    if (wasPlaying) old.row.play();
    render();
  }

  function refreshVariationRow(variation) {
    variation.row.setAudio(variation.audio);
    const departure = Math.round(recipeDeparture(variation.recipe) * 100);
    variation.row.setInfo({
      seed: variation.seed,
      description: `${describeRecipe(variation.recipe)} · ${departure}% changed`,
      stale: variation.stale,
      title: recipePattern(variation.recipe),
    });
    variation.row.setLoop(state.looping);
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  function encode(variation) {
    return encodeWav(variation.audio.channels, variation.audio.sampleRate, state.bitDepth);
  }

  function exportOne(index) {
    const variation = state.variations.find((v) => v.index === index);
    if (!variation) return;
    const name = variationFileName(state.name, variation.index, variation.seed);
    downloadBlob(encode(variation), name);
    logSuccess(`Exported ${name}`);
  }

  async function exportAll() {
    if (state.busy) return;
    if (!state.variations.length) {
      logWarn("Nothing generated yet.");
      return;
    }

    const folder = batchFolderName(state.name);
    let dirHandle = null;
    if (io.supportsFSA) {
      // Asked once per session and remembered, the same way PLAY NICE's Export All does it.
      dirHandle = state.exportDir;
      if (!dirHandle) {
        dirHandle = await io.pickFolder();
        if (!dirHandle) return; // cancelled
        if (!(await io.ensurePermission(dirHandle))) {
          logWarn("No write permission for that folder, so nothing was exported.");
          return;
        }
        state.exportDir = dirHandle;
      }
    }

    state.busy = true;
    render();

    const zip = dirHandle ? null : new io.ZipBatch();
    const taken = new Set();
    let written = 0;
    let failed = 0;
    let index = 0;

    for (const variation of state.variations) {
      state.progress = `exporting ${++index}/${state.variations.length}`;
      renderBar();
      const name = uniqueName(variationFileName(state.name, variation.index, variation.seed), taken);
      try {
        const blob = encode(variation);
        if (dirHandle) await io.writeFile(dirHandle, folder, "", name, blob);
        else zip.addFile(folder, "", "", name, blob);
        written++;
      } catch (err) {
        failed++;
        logWarn(`Couldn't write "${name}": ${err.message || err}`);
      }
      await yieldToUi();
    }

    state.progress = null;
    if (zip && written > 0) await zip.downloadAs(`${folder}.zip`);
    state.busy = false;
    render();
    if (written) logSuccess(`Exported ${written} variation${written === 1 ? "" : "s"} to ${dirHandle ? `${folder}/` : `${folder}.zip`}.`);
    if (failed) logWarn(`${failed} variation${failed === 1 ? "" : "s"} couldn't be exported.`);
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  function render() {
    const hasSource = !!state.audio;
    const map = currentMap();
    const readiness = sliceMapReadiness(map);

    dropzone.hidden = hasSource || state.status === "decoding" || state.status === "analysing";
    loaded.hidden = !state.file;
    loadedName.textContent = state.name || "";

    if (state.status === "error") {
      sourceStatus.textContent = state.error || "That file couldn't be used.";
      sourceStatus.classList.add("is-error");
    } else {
      sourceStatus.classList.remove("is-error");
      if (state.status === "decoding") sourceStatus.textContent = "Decoding…";
      else if (state.status === "analysing") sourceStatus.textContent = "Detecting tempo…";
      else if (hasSource) {
        const ch = state.audio.channels.length === 1 ? "mono" : state.audio.channels.length === 2 ? "stereo" : `${state.audio.channels.length} ch`;
        sourceStatus.textContent = `${state.audio.duration.toFixed(2)}s · ${ch} · ${state.audio.sampleRate} Hz`;
      } else sourceStatus.textContent = "";
    }

    tempoRow.hidden = !hasSource;
    const bpm = effectiveBpm();
    if (document.activeElement !== bpmInput) bpmInput.value = bpm != null ? String(Math.round(bpm * 100) / 100) : "";
    tempoNote.textContent = formatBpmText(bpm, state.bpmOverride != null, state.analysisAvailable);
    resetBpmBtn.disabled = state.bpmOverride == null;
    halveBtn.disabled = bpm == null;
    doubleBtn.disabled = bpm == null;

    sourceSummary.textContent = hasSource && map ? describeSliceMap(map) : "";
    gridSummary.textContent = map ? `${map.count} slices` : "";

    for (const [key, btn] of sliceButtons) btn.classList.toggle("is-active", key === state.subdivision);
    for (const [key, chip] of styleButtons) chip.classList.toggle("is-active", key === state.style);
    styleBlurb.textContent = resolveStyle(state.style).blurb;
    if (document.activeElement !== intensitySlider) intensitySlider.value = String(state.intensity);
    if (document.activeElement !== intensityNumber) intensityNumber.value = String(state.intensity);
    intensityWord.textContent = describeIntensity(state.intensity);
    downbeatCheckbox.checked = state.keepDownbeats;

    const warning = hasSource ? readiness.reason || readiness.warning : null;
    gridWarning.hidden = !warning;
    gridWarning.textContent = warning || "";
    gridWarning.classList.toggle("is-error", !!(hasSource && readiness.reason));

    originalRow.setInfo({ description: hasSource ? "your loop, untouched" : "no loop loaded yet" });
    originalRow.el.hidden = !hasSource;
    emptyNote.hidden = state.variations.length > 0;
    emptyNote.textContent = hasSource ? "Nothing generated yet - press GENERATE and start listening." : "Load a loop above, then press GENERATE.";
    listSummary.textContent = state.variations.length ? `${state.variations.length} in this batch` : "";
    for (const variation of state.variations) variation.row.setInfo({ stale: variation.stale });

    sizeSelect.value = String(state.batchSize);
    depthSelect.value = String(state.bitDepth);
    renderBar();
  }

  function renderBar() {
    const canGenerate = !!state.audio && !state.busy && sliceMapReadiness(currentMap()).ok;
    generateBtn.textContent = state.variations.length ? `GENERATE ${state.batchSize} MORE` : `GENERATE ${state.batchSize}`;
    generateBtn.disabled = !canGenerate;
    exportAllBtn.disabled = !state.variations.length || state.busy;
    sizeSelect.disabled = state.busy;
    loopBtn.classList.toggle("is-active", state.looping);
    loopBtn.setAttribute("aria-pressed", state.looping ? "true" : "false");
    status.textContent = state.progress || (state.busy ? "working…" : "");
    status.classList.toggle("is-working", !!state.progress);
  }

  render();

  return {
    element: root,
    /** FLIP is on screen (or not) - the bottom bar follows. */
    setActive(active) {
      bar.hidden = !active;
      if (!active) stopAllPlayback();
      else requestAnimationFrame(() => {
        for (const row of allRows()) row.redraw();
      });
    },
    stopAllPlayback,
    hasContent() {
      return !!state.file || state.variations.length > 0;
    },
    /** Wipe the session - what New Session calls. */
    reset() {
      generation++;
      clearSource();
      state.exportDir = null;
      state.busy = false;
      state.progress = null;
      render();
    },
    redraw() {
      for (const row of allRows()) row.redraw();
    },
  };
}

/**
 * Drag and drop onto the whole FLIP workspace. Its own copy rather than an import from
 * js/play-nice/target-panel.js: that one exists to let an INNER zone win over an outer one via
 * stopPropagation, which is a PLAY NICE layout problem. FLIP has exactly one target - anywhere.
 */
function wireDropZone(zone, onFiles) {
  ["dragenter", "dragover"].forEach((name) => {
    zone.addEventListener(name, (ev) => {
      if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types || []).includes("Files")) return;
      ev.preventDefault();
      zone.classList.add("is-dragover");
    });
  });
  ["dragleave", "dragend", "drop"].forEach((name) => {
    zone.addEventListener(name, (ev) => {
      if (name === "dragleave" && ev.relatedTarget && zone.contains(ev.relatedTarget)) return;
      zone.classList.remove("is-dragover");
    });
  });
  zone.addEventListener("drop", (ev) => {
    if (!ev.dataTransfer) return;
    ev.preventDefault();
    const files = Array.from(ev.dataTransfer.files || []);
    if (files.length) onFiles(files);
  });
}

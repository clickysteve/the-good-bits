// controller.js
//
// PLAY NICE's orchestration layer: owns the session state, drives analysis, keeps every
// loop's conform plan current, and runs preview/export. The UI modules beside it
// (target-panel.js, loop-card.js) are renderers over what this holds; the pure modules
// (conform.js, key-matching.js, target-context.js, methods.js, naming.js) hold the rules.
// Nothing musical is decided in here.
//
// WHY PLAY NICE OWNS ITS OWN STATE, unlike STRETCH (whose state lives in app.js): STRETCH
// operates on the shared source queue, so it has to. PLAY NICE doesn't - it takes loose
// loops, has its own target, its own per-item settings and its own export destination.
// Keeping that here rather than adding another dozen module-level variables to app.js
// means the existing CHOP/STRETCH/BOTH behaviour is untouched by this feature, which was
// a hard requirement.
//
// RESPONSIVENESS: analysis and rendering both yield between files, and rendering happens
// in js/heavy-dsp-worker.js. One unreadable or undecodable file marks itself failed and
// the batch carries on - see analyzeItem()'s catch.
import { createTargetContext, sanitizeTargetBpm, targetFromReference, targetReadiness, formatTarget } from "./target-context.js";
import { planConform } from "./conform.js";
import { renderConform, predictedDuration } from "./render.js";
import { resolveMethodKey, describeMethod, methodGroups, DEFAULT_METHOD, METHOD_INHERIT } from "./methods.js";
import { normalizeMode, isNote, formatKey, DEFAULT_TRANSPOSE_STRATEGY } from "./key-matching.js";
import { conformedFileName, batchFolderName, uniqueName, PLAY_NICE_OUTPUT_DIR } from "./naming.js";
import { resolveRole, DEFAULT_ROLE } from "./roles.js";
import { createTargetPanel, wireDropZone } from "./target-panel.js";
import { createLoopCard } from "./loop-card.js";
import { createMixPlayer } from "./mix-player.js";
import { integratedRmsDb, matchGain, formatLevel } from "./levels.js";
import { spectralFlatness, looksPercussive } from "./percussion.js";
import { gridAlignmentOffset } from "./downbeat.js";
import { TIME_FEELS, DEFAULT_TIME_FEEL, formatTimeFeel } from "./time-feel.js";
import { toMono } from "../dsp.js";
import { sanitizeSourceBpm, resolveEffectiveTempo, formatBpmText } from "../tempo-override.js";
import { AUDIO_EXTS } from "../io-fs.js";
import { showConfirmDialog } from "../confirm-dialog.js";
import { readJSON, writeJSON } from "../local-storage.js";

const DEFAULT_BIT_DEPTH = 24;

/**
 * Everything except the audio itself survives a reload, the same way CHOP's and STRETCH's
 * settings do. Losing your target and your method because you refreshed the page is exactly
 * the kind of small betrayal that makes a tool feel unfinished - and PLAY NICE was the only
 * task in the app that did it.
 *
 * Loops are deliberately NOT persisted: the audio isn't ours to keep, and a list of
 * filenames we can no longer read would be worse than an empty one.
 */
const STORAGE_KEY = "good-bits-play-nice-v1";
/**
 * Edge de-click on conformed output. Deliberately tiny: this exists to stop a hard splice
 * at the buffer boundary, not to shape the sound. A 2ms fade - the first value here - is
 * long enough to audibly soften a kick sitting on the downbeat, which is the one sample in
 * a loop that must not be softened, and long enough to dip the loop seam on every cycle.
 */
const CONFORM_FADE_MS = 0.4;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function extOf(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.container
 * @param {(file:File, ext:string) => Promise<{buffer:object}>} deps.decodeFile   app.js's decoder, reused as-is
 * @param {(mono:Float32Array, sampleRate:number, want:object) => Promise<object>} deps.analyze  essentia-bridge's analyzeKeyAndTempo
 * @param {() => AudioContext} deps.getAudioContext
 * @param {(name:string, fallback:string) => string} deps.color
 * @param {(msg:string) => void} deps.log
 * @param {(msg:string) => void} deps.logWarn
 * @param {(msg:string) => void} deps.logSuccess
 * @param {(job:object) => Promise<{blob:Blob, seconds:number}>} deps.runConform   worker-backed renderer, with a main-thread fallback
 * @param {object} deps.io   {supportsFSA, pickFiles, pickFolder, ensurePermission, writeFile, ZipBatch}
 */
export function createPlayNice(deps) {
  const { container, chromeContainer, decodeFile, analyze, getAudioContext, color, log, logWarn, logSuccess, runConform, io } = deps;

  const state = {
    target: createTargetContext(),
    sessionMethod: DEFAULT_METHOD,
    items: [], // every loaded input (loops today, one-shots later - see roles.js)
    // WHICH item is the reference, not a separate copy of one. The reference used to be a
    // parallel object loaded through its own drop zone, which meant a loop you'd already
    // dropped had to be loaded a SECOND time to follow it. One list plus a pointer makes
    // "use this one as the reference" a single click on any card, and switching reference
    // free - see setReferenceItem().
    referenceId: null,
    exportDir: null, // remembered FSA destination, so Export All only asks once per session
    mixSource: "conformed", // which version "Play all" plays: "original" | "conformed"
    keyStrategy: DEFAULT_TRANSPOSE_STRATEGY, // how a differing mode is reconciled - see key-matching.js
    // Derive each loop's tempo from its own length rather than trusting detection to the
    // last decimal. Without this a looping mix drifts apart - see snapTempoToLoopLength().
    snapToLoop: true,
    // Resolve half/double detection errors against the target automatically.
    autoOctave: true,
    // Rotate each loop so its attacks sit on the beat grid - see downbeat.js.
    alignDownbeat: true,
    // Balance what you HEAR so one loud loop can't bury the rest. Never touches exports.
    matchLevels: true,
    bitDepth: DEFAULT_BIT_DEPTH,
    soloId: null, // when set, only this loop is audible
    onlyNeedsAttention: false, // filter the list down to loops worth looking at
    busy: false,
  };

  restoreSession(state);

  let nextId = 1;
  let collapsedTargetOnce = false;
  const cards = new Map(); // item id -> loop card

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  const root = el("div", "play-nice");
  container.appendChild(root);

  const targetPanel = createTargetPanel({
    container: root,
    getAudioContext,
    color,
    onTargetChange: handleTargetChange,
    onModeChange: handleTargetModeChange,
    onPickReference: pickReference,
    onReferenceFiles: (files) => addFiles(files, { asReference: true }),
    onClearReference: clearReference,
    onResetReferenceDetection: resetReferenceDetection,
    onKeyStrategyChange: (strategy) => {
      state.keyStrategy = strategy;
      invalidateAllResults();
      saveSession();
      render();
    },
    onSnapChange: (enabled) => {
      state.snapToLoop = !!enabled;
      mixPlayer.stop();
      invalidateAllResults();
      saveSession();
      render();
    },
    onAlignChange: (enabled) => {
      state.alignDownbeat = !!enabled;
      mixPlayer.stop();
      invalidateAllResults();
      saveSession();
      render();
    },
    onBitDepthChange: (depth) => {
      state.bitDepth = depth;
      saveSession();
      // Only the exported file changes, so nothing needs re-rendering - but the cached
      // result was encoded at the old depth, so it does need redoing before it is written.
      for (const item of state.items) item.result = null;
      render();
    },
  });

  // ---- session method ------------------------------------------------------
  //
  // The default HOW for the whole session. Loops set to "Follow session" move with it;
  // loops given a method of their own keep it. That split is what makes "conform this
  // batch cleanly, except run those three through Shred" a two-click decision.

  const methodPanel = el("section", "pn-panel pn-method-panel");
  const methodRow = el("div", "pn-method-row");
  methodRow.appendChild(el("h2", "pn-panel-title", "Method"));
  const sessionMethodSelect = el("select", "pn-method-select");
  for (const group of methodGroups()) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const character of group.characters) {
      const opt = document.createElement("option");
      opt.value = character.key;
      opt.textContent = character.label;
      opt.title = character.description || "";
      optgroup.appendChild(opt);
    }
    sessionMethodSelect.appendChild(optgroup);
  }
  sessionMethodSelect.addEventListener("change", () => {
    state.sessionMethod = sessionMethodSelect.value;
    invalidateAllResults();
    saveSession();
    render();
  });
  const methodHint = el("p", "mod-note pn-method-hint");
  methodRow.append(sessionMethodSelect, methodHint);
  methodPanel.appendChild(methodRow);
  // The standing explanation ("it never changes how much stretch is needed...") was a
  // paragraph of permanent chrome above a list. It is a tooltip now; the hint beside the
  // select still describes whichever method is actually chosen.
  sessionMethodSelect.title = "How the stretch is performed. It never changes how much stretch is needed - that comes from the tempos alone. Individual loops can override this.";
  root.appendChild(methodPanel);

  // ---- loops ---------------------------------------------------------------

  const loopsPanel = el("section", "pn-panel pn-loops-panel");
  const loopsHead = el("div", "pn-panel-head");
  loopsHead.append(el("h2", "pn-panel-title", "Loops"));
  const loopsCount = el("span", "pn-target-summary");
  loopsHead.appendChild(loopsCount);
  loopsPanel.appendChild(loopsHead);

  const loopDrop = el("div", "pn-dropzone");
  const loopCopy = el("div", "dropzone-copy");
  loopCopy.append(el("strong", null, "Drop loops here"), el("span", null, "as many as you like - they're analysed as they arrive"));
  const loopActions = el("div", "dropzone-actions");
  const addLoopsBtn = el("button", "btn btn--primary", "Add loops");
  addLoopsBtn.type = "button";
  addLoopsBtn.addEventListener("click", pickLoops);
  const clearBtn = el("button", "btn btn--ghost", "Clear");
  clearBtn.type = "button";
  clearBtn.addEventListener("click", async () => {
    // "Clear" sits next to "Add loops" and wipes an analysed batch. Analysis is the slow
    // part of the workflow, so losing it to a mis-click is losing real time - and the app
    // already guards New Session exactly this way.
    if (state.items.length) {
      const { confirmed } = await showConfirmDialog({
        title: `Clear ${state.items.length} loop${state.items.length === 1 ? "" : "s"}?`,
        body: "Everything loaded here is removed, along with its analysis and anything processed. Your target and settings are kept.",
        confirmLabel: "Clear them",
        cancelLabel: "Keep them",
      });
      if (!confirmed) return;
    }
    clearLoops();
  });
  loopActions.append(addLoopsBtn, clearBtn);
  loopDrop.append(loopCopy, loopActions);
  loopsPanel.appendChild(loopDrop);
  wireDropZone(loopDrop, (files) => addFiles(files));

  // Scanning aid, not decoration: on a twenty-loop batch the job is finding the two that
  // need a correction, and this turns that from reading twenty rows into reading two.
  const filterRow = el("div", "pn-filter-row");
  const attentionBtn = el("button", "btn btn--small pn-attention-filter", "Needs a look");
  attentionBtn.type = "button";
  attentionBtn.addEventListener("click", () => {
    state.onlyNeedsAttention = !state.onlyNeedsAttention;
    render();
  });
  const filterNote = el("span", "pn-filter-note");
  filterRow.append(attentionBtn, filterNote);
  loopsPanel.appendChild(filterRow);

  const loopList = el("div", "pn-card-list");
  loopsPanel.appendChild(loopList);
  root.appendChild(loopsPanel);

  const legacyInput = el("input");
  legacyInput.type = "file";
  legacyInput.multiple = true;
  legacyInput.accept = [...AUDIO_EXTS].join(",");
  legacyInput.hidden = true;
  legacyInput.addEventListener("change", () => {
    const files = Array.from(legacyInput.files || []);
    legacyInput.value = "";
    if (files.length) {
      addFiles(files, { asReference: legacyInput.dataset.role === "reference" });
    }
  });
  root.appendChild(legacyInput);

  // The whole workspace is a drop target, not just the two zones - dropping a loop
  // anywhere in PLAY NICE should add it, the same way the CHOP stage behaves.
  wireDropZone(root, (files) => addFiles(files));

  // -------------------------------------------------------------------------
  // The mix
  //
  // Lives in a bar pinned to the bottom of the window rather than inline in the list -
  // see js/play-nice/mix-player.js. The controller owns WHAT is in the mix; the player
  // owns the transport and the waveform.
  // -------------------------------------------------------------------------

  const mixPlayer = createMixPlayer({
    getAudioContext,
    color,
    getTracks: () => mixTracks(),
    onSourceChange: (source) => {
      state.mixSource = source;
      saveSession();
    },
    getMixSource: () => state.mixSource,
    getTrackStates: () => mixTrackStates(),
    onBeforePlay: () => renderMissingForMix(),
    onPlayStart: () => {
      // The mix and a single card's own player are the same speakers; two at once is noise.
      for (const card of cards.values()) card.stopPlayback();
      targetPanel.stopPlayback();
    },
    onProcessAll: () => void processAll(),
    onExportAll: () => void exportAll(),
    onToggleLevels: () => {
      state.matchLevels = !state.matchLevels;
      mixPlayer.applyTrackStates();
      saveSession();
      render();
    },
    getLevelsMatched: () => state.matchLevels,
    // The grid the mix is judged against is the TARGET tempo - that's what everything in it
    // has been conformed to.
    getTargetBpm: () => (Number.isFinite(state.target.bpm) && state.target.bpm > 0 ? state.target.bpm : null),
  });
  // Into the app's own bottom chrome, in normal flex flow - NOT floated over the page. The
  // shell is already "fixed chrome top and bottom with one scrolling stage between", so a
  // position:fixed bar here just covered up whatever was underneath it (which is exactly
  // what happened to the log panel).
  (chromeContainer || document.body).appendChild(mixPlayer.element);

  /**
   * Loops currently eligible for the mix, in list order.
   *
   * `version` identifies the AUDIO, not the loop: re-rendering with a different stretch
   * method produces a different buffer of identical length, so the player needs something
   * that changes when the samples do or it will keep playing the old ones. The plan
   * signature is exactly that.
   */
  /**
   * Every ready loop, carrying BOTH variants. Muted loops are included with audible:false
   * rather than omitted - they stay in the graph so unmuting is a gain ramp instead of a
   * restart, which is what makes mute and solo seamless.
   */
  function mixTracks() {
    const tracks = [];
    for (const item of state.items) {
      if (item.status !== "ready") continue;
      tracks.push({
        id: item.id,
        sampleRate: item.audio.sampleRate,
        original: item.audio,
        conformed: item.result ? item.result.audio : null,
        gain: monitorGain(item),
        audible: audibleInMix(item),
        // Identifies the AUDIO, so a re-render with a different method (same length,
        // different samples) still reloads. Mute/solo/level deliberately are NOT in here -
        // they are applied live and must not force a reload.
        version: item.result ? item.result.signature : "unrendered",
      });
    }
    return tracks;
  }

  /** Just the live mute/solo/level state, pushed onto a running graph without reloading. */
  function mixTrackStates() {
    return state.items
      .filter((i) => i.status === "ready")
      .map((i) => ({ id: i.id, audible: audibleInMix(i), gain: monitorGain(i) }));
  }

  /** Solo wins over mute: soloing a muted loop hears it, which is what soloing is for. */
  function audibleInMix(item) {
    if (state.soloId != null) return state.soloId === item.id;
    return item.inMix;
  }

  /** Monitoring gain only - exports are never level-changed. See js/play-nice/levels.js. */
  function monitorGain(item) {
    return state.matchLevels ? matchGain(item.rmsDb) : 1;
  }

  function toggleSolo(item) {
    state.soloId = state.soloId === item.id ? null : item.id;
    // Live gain change on running sources - no restart, no re-attack, no lost position.
    mixPlayer.applyTrackStates();
    render();
  }

  /** Render whatever the conformed mix is missing, so pressing play doesn't yield a partial mix. */
  async function renderMissingForMix() {
    const missing = state.items.filter((i) => i.status === "ready" && i.inMix && !i.result);
    if (!missing.length) return;
    state.busy = true;
    render();
    for (const item of missing) {
      await processItem(item);
      await yieldToUi();
    }
    state.busy = false;
    render();
  }

  // -------------------------------------------------------------------------
  // Target
  // -------------------------------------------------------------------------

  function handleTargetChange(patch) {
    if ("bpm" in patch) {
      const bpm = sanitizeTargetBpm(patch.bpm);
      // Reject rather than store garbage, exactly as tempo-override.js does for sources:
      // a typo leaves the previous value in force instead of destroying it.
      if (bpm != null) state.target.bpm = bpm;
    }
    if ("key" in patch && isNote(patch.key)) state.target.key = patch.key;
    if ("keyMode" in patch) state.target.keyMode = normalizeMode(patch.keyMode) || state.target.keyMode;
    if ("pitchEnabled" in patch) state.target.pitchEnabled = !!patch.pitchEnabled;
    // The target changed, so every rendered result is now of the wrong thing.
    invalidateAllResults();
    saveSession();
    render();
  }

  function handleTargetModeChange(mode) {
    state.target.mode = mode === "reference" ? "reference" : "defined";
    // Provenance follows the mode, but the VALUES don't reset - switching to Defined after
    // following a reference keeps the numbers it found, which is the point of it being a
    // starting point rather than a lock.
    state.target.source = state.target.mode === "reference" && referenceItem() ? "reference" : "manual";
    invalidateAllResults();
    render();
  }

  /** The item currently acting as the reference, or null. */
  function referenceItem() {
    return state.referenceId == null ? null : state.items.find((i) => i.id === state.referenceId) || null;
  }

  /** Loading a reference means looking at it, so make sure the panel isn't shut. */
  function revealTarget() {
    targetPanel.setCollapsed(false);
  }

  async function pickReference() {
    revealTarget();
    const files = await pickAudioFiles({ multiple: false, role: "reference" });
    if (files.length) addFiles(files, { asReference: true });
  }

  /**
   * Make `item` the thing everything else follows: its detected tempo and key become the
   * target. Works on any loaded item, whether it arrived through the reference drop zone or
   * was already sitting in the batch - the two are the same thing now.
   *
   * The item stays in the list rather than being moved out of it. It conforms to itself
   * (a no-op) and exports as a plain copy, so a batch exported to one folder still contains
   * the loop everything was built around. Switching the reference to a different loop is
   * then just calling this again.
   */
  function setReferenceItem(item, { announce = true } = {}) {
    if (!item) return;
    revealTarget();
    state.referenceId = item.id;
    state.target.mode = "reference";
    targetPanel.stopPlayback();
    targetPanel.setReferenceAudio(item.audio || null);

    if (item.status !== "ready") {
      // Still decoding or analysing. applyReferenceDetection() runs again when it lands.
      render();
      return;
    }
    applyReferenceDetection(item, { announce });
  }

  /** Push a reference item's detection into the target, and snap the item itself onto it. */
  function applyReferenceDetection(item, { announce = true } = {}) {
    const detected = item.detected || {};
    state.target = targetFromReference(state.target, {
      name: item.name,
      bpm: detected.bpm,
      key: detected.key,
      scale: detected.scale,
      keyStrength: detected.keyStrength,
      durationSec: item.audio ? item.audio.duration : null,
    });

    // The target BPM is rounded to something typable, so the reference's own raw detected
    // tempo (116.99 against a target of 117) would otherwise ask for a pointless 0.01%
    // stretch of the very loop the target came FROM. Snapping the reference's interpreted
    // source values onto the target makes conforming it to itself exactly a no-op - and
    // leaves it free to conform normally if the user later moves the target by hand.
    item.overrides.bpm = state.target.bpm;
    if (state.target.pitchEnabled) {
      item.overrides.key = state.target.key;
      item.overrides.mode = state.target.keyMode;
      item.keyDisabled = false;
    }

    if (announce) {
      log(`Following "${item.name}": ${formatTarget(state.target)}${detected.bpm ? "" : " (no confident tempo - set one yourself)"}`);
      if (!state.target.pitchEnabled) {
        log("No clear key in the reference loop, so key conforming is off. Pick a target key yourself to turn it back on.");
      }
    }
    invalidateAllResults();
    render();
  }

  /** Stop following a reference. The target keeps its values; they're just no longer tied to a loop. */
  function clearReference() {
    targetPanel.stopPlayback();
    targetPanel.setReferenceAudio(null);
    state.referenceId = null;
    state.target.reference = null;
    state.target.source = "manual";
    render();
  }

  /** Put the reference's detection back in force after manual correction. */
  function resetReferenceDetection() {
    const item = referenceItem();
    if (!item || !item.detected) return;
    applyReferenceDetection(item, { announce: false });
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  async function pickLoops() {
    const files = await pickAudioFiles({ multiple: true, role: "loop" });
    if (files.length) addFiles(files);
  }

  /** Open whichever file picker this browser supports. FSA gives handles; everything else uses the hidden input. */
  async function pickAudioFiles({ multiple, role }) {
    if (io.supportsFSA) {
      try {
        const handles = await io.pickFiles({ multiple });
        return await Promise.all(handles.map((h) => h.getFile()));
      } catch (err) {
        logWarn(`File picker failed: ${err.message || err}`);
        return [];
      }
    }
    legacyInput.dataset.role = role;
    legacyInput.multiple = !!multiple;
    legacyInput.click();
    return [];
  }

  function addFiles(files, { asReference = false } = {}) {
    const audio = files.filter((f) => AUDIO_EXTS.has(extOf(f.name)));
    const rejected = files.length - audio.length;
    if (rejected > 0) logWarn(`Ignored ${rejected} file${rejected === 1 ? "" : "s"} that ${rejected === 1 ? "isn't" : "aren't"} audio.`);
    if (!audio.length) return;

    let first = null;
    for (const file of audio) {
      const item = createItem(file);
      state.items.push(item);
      mountCard(item);
      if (!first) first = item;
    }
    // Dropped on the reference zone: the first file becomes what everything follows. It is
    // still an ordinary item in the list, so it can be un-referenced, re-referenced or
    // replaced by any other loop without reloading anything.
    if (asReference && first) {
      revealTarget();
      setReferenceItem(first, { announce: false });
    }
    log(`Added ${audio.length} ${asReference ? "reference loop" : `loop${audio.length === 1 ? "" : "s"}`}. Analysing…`);
    // Once there are loops, attention belongs on the list. The target stays one line away.
    if (!collapsedTargetOnce) {
      collapsedTargetOnce = true;
      targetPanel.setCollapsed(true);
    }
    render();
    // Deliberately sequential rather than Promise.all: analysis is WASM on the main
    // thread, so twenty at once would freeze the page for as long as all twenty take.
    // One at a time with a yield between keeps cards updating as they land.
    void analyzeQueue();
  }

  function createItem(file) {
    return {
      id: nextId++,
      role: DEFAULT_ROLE,
      name: file.name,
      file,
      status: "queued", // queued | decoding | analysing | ready | error
      error: null,
      busy: false,
      audio: null,
      detected: null,
      analysisAvailable: false,
      rmsDb: null, // integrated loudness, for level matching - see levels.js
      flatness: null, // spectral flatness, for percussion detection - see percussion.js
      percussive: false,
      timeFeel: DEFAULT_TIME_FEEL, // conform to a multiple of the target - see time-feel.js
      // Manual corrections. null means "no correction, use detection" - the same
      // override-vs-detected split js/tempo-override.js defines for the CHOP/STRETCH path.
      overrides: { bpm: null, key: null, mode: null },
      keyDisabled: false,
      inMix: true, // included when "Play all" builds the mix
      pending: null, // in-flight render, so two callers can't race the same item
      pendingSignature: null,
      tempoFit: true,
      pitchFit: true,
      method: METHOD_INHERIT,
      result: null, // {audio, blob, planSignature}
      renderError: null,
    };
  }

  async function analyzeQueue() {
    for (const item of state.items) {
      if (item.status !== "queued") continue;
      await analyzeItem(item);
      await yieldToUi();
    }
    render();
  }

  async function analyzeItem(item) {
    const role = resolveRole(item.role);
    try {
      item.status = "decoding";
      renderItem(item);
      await yieldToUi();
      item.audio = await decodeToAudio(item.file);

      const card = cards.get(item.id);
      if (card) card.setOriginalAudio(item.audio);
      // The reference pane shows the followed loop's own waveform, so it needs the audio as
      // soon as there is any - not only once analysis finishes.
      if (state.referenceId === item.id) targetPanel.setReferenceAudio(item.audio);

      item.status = "analysing";
      renderItem(item);
      await yieldToUi();

      const want = { key: role.analyzeKey, tempo: role.analyzeTempo };
      const result = want.key || want.tempo ? await analyze(item.audio.mono, item.audio.sampleRate, want) : { available: false };
      item.detected = { bpm: result.bpm ?? null, key: result.key ?? null, scale: normalizeMode(result.scale), keyStrength: result.keyStrength ?? null };
      // One extra pass over audio already in memory, and the difference between a mix you
      // can judge and one where the loudest loop decides everything.
      item.rmsDb = integratedRmsDb(item.audio.mono, item.audio.sampleRate);

      // Does this look like percussion? If so, key matching has nothing to match and is
      // switched off for this loop by default - the user can turn it straight back on with
      // the same "No key" checkbox they would otherwise have had to find themselves.
      item.flatness = spectralFlatness(item.audio.mono, item.audio.sampleRate);
      const grid = item.detected.bpm ? gridAlignmentOffset(item.audio.mono, item.audio.sampleRate, item.detected.bpm) : null;
      item.percussive = looksPercussive(item.flatness, grid ? grid.confidence : null);
      if (item.percussive) item.keyDisabled = true;
      // No key detected at all is the other reason to skip key matching.
      if (!item.detected.key) item.keyDisabled = true;
      item.analysisAvailable = !!result.available;
      item.status = "ready";
      // A running per-file record, the same way CHOP reports what it found. Without it the
      // log sits empty through the slowest part of the workflow and there is nowhere to see
      // what analysis actually decided about a file.
      log(`  ${item.name}: ${describeDetection(item)}`);
      // Referenced before its analysis finished (the usual case when it was dropped on the
      // reference zone) - now that there are numbers, they become the target.
      if (state.referenceId === item.id) applyReferenceDetection(item);
    } catch (err) {
      // One broken file must never take the batch with it.
      item.status = "error";
      item.error = err.message || String(err);
      logWarn(`Skipped "${item.name}": ${item.error}`);
    }
    renderItem(item);
  }

  /** "136 BPM / A minor" / "no confident tempo, no clear key" - one file's analysis as a log line. */
  function describeDetection(item) {
    const d = item.detected || {};
    const tempo = d.bpm ? `${Math.round(d.bpm)} BPM` : item.analysisAvailable ? "no confident tempo" : "tempo unavailable";
    const key = d.key ? formatKey(d.key, d.scale) : item.analysisAvailable ? "no clear key" : "key unavailable";
    return `${tempo} / ${key}${item.percussive ? " · looks like percussion, key matching off" : ""}`;
  }

  function removeItem(item) {
    const card = cards.get(item.id);
    if (card) {
      card.destroy();
      cards.delete(item.id);
    }
    releaseResult(item);
    const idx = state.items.indexOf(item);
    if (idx !== -1) state.items.splice(idx, 1);
    // Removing the loop everything was following leaves the target values in place but no
    // longer tied to anything - a dangling referenceId would render an empty reference pane.
    if (state.referenceId === item.id) clearReference();
    render();
  }

  function clearLoops() {
    mixPlayer.stop();
    for (const item of state.items) {
      const card = cards.get(item.id);
      if (card) card.destroy();
      releaseResult(item);
    }
    cards.clear();
    state.items.length = 0;
    if (state.referenceId != null) clearReference();
    render();
  }

  // -------------------------------------------------------------------------
  // Effective analysis + plans
  // -------------------------------------------------------------------------

  /**
   * The effective source characteristics for an item: manual corrections win over
   * detection, always. Everything downstream reads this and never the raw detection -
   * the same rule resolveEffectiveTempo() enforces for the CHOP/STRETCH path.
   */
  function effectiveSource(item) {
    const detected = item.detected || {};
    return {
      bpm: resolveEffectiveTempo(item.overrides.bpm, detected.bpm),
      key: item.keyDisabled ? null : item.overrides.key || detected.key || null,
      mode: item.keyDisabled ? null : item.overrides.mode || detected.scale || null,
      // Exact, unlike everything else here - it's a sample count. Bar-snapping uses it to
      // correct a fraction of a percent of tempo-detection error.
      durationSec: item.audio ? item.audio.duration : null,
      // Gates automatic half/double correction: a tempo the user set is never overruled.
      bpmIsManual: item.overrides.bpm != null,
    };
  }

  function planFor(item) {
    return planConform({
      role: item.role,
      source: effectiveSource(item),
      target: state.target,
      tempoFit: item.tempoFit,
      pitchFit: item.pitchFit,
      method: item.method,
      sessionMethod: state.sessionMethod,
      strategy: state.keyStrategy,
      snapToLoop: state.snapToLoop,
      autoOctave: state.autoOctave,
      alignDownbeat: state.alignDownbeat,
      timeFeel: item.timeFeel,
    });
  }

  /**
   * A short string identifying everything a rendered result depends on. If it stops
   * matching, the result on screen is of something the user has since changed, and the
   * card says so rather than quietly presenting stale audio as current.
   */
  function planSignature(plan) {
    return [
      plan.method.key,
      plan.tempo.applied ? plan.tempo.ratio.toFixed(6) : "-",
      plan.pitch.applied ? plan.pitch.semitones.toFixed(4) : "-",
      plan.align.enabled ? "a" : "-",
      String(state.bitDepth),
      plan.tempo.timeFeel || "normal",
    ].join("|");
  }

  /** Debounced so dragging the BPM field doesn't write to localStorage on every tick. */
  let saveTimer = null;
  function saveSession() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeJSON(STORAGE_KEY, {
        target: { bpm: state.target.bpm, key: state.target.key, keyMode: state.target.keyMode, pitchEnabled: state.target.pitchEnabled },
        sessionMethod: state.sessionMethod,
        keyStrategy: state.keyStrategy,
        snapToLoop: state.snapToLoop,
        alignDownbeat: state.alignDownbeat,
        matchLevels: state.matchLevels,
        bitDepth: state.bitDepth,
        mixSource: state.mixSource,
      });
    }, 400);
  }

  function invalidateAllResults({ reprocess = true } = {}) {
    if (reprocess) scheduleAutoProcessForRendered();
    // Results aren't thrown away - a stale one is still audible while the new one
    // renders, and re-rendering an unchanged plan is a no-op because the signature still
    // matches. render() marks whatever no longer matches.
    render();
  }

  function releaseResult(item) {
    item.result = null;
  }

  // -------------------------------------------------------------------------
  // Rendering audio
  // -------------------------------------------------------------------------

  /**
   * Render one item's conformed audio, unless an identical result is already in hand.
   *
   * Concurrent calls for the same item share one render. Auto-processing and an explicit
   * Process all can genuinely overlap - auto-process only checks state.busy once, before
   * its loop, so a render it has already awaited cannot be called off by a batch starting
   * afterwards - and without this both would render the same loop and race to write
   * item.result, leaving whichever finished last in place regardless of which plan was
   * current.
   */
  async function processItem(item, { force = false } = {}) {
    if (item.status !== "ready") return null;
    const plan = planFor(item);
    const signature = planSignature(plan);
    if (!force && item.result && item.result.signature === signature) return item.result;

    // Already rendering this exact plan - wait for that one rather than starting a second.
    if (item.pending && item.pendingSignature === signature && !force) return item.pending;

    const run = renderItemAudio(item, plan, signature);
    item.pending = run;
    item.pendingSignature = signature;
    try {
      return await run;
    } finally {
      if (item.pending === run) {
        item.pending = null;
        item.pendingSignature = null;
      }
    }
  }

  async function renderItemAudio(item, plan, signature) {
    item.busy = true;
    item.renderError = null;
    renderItem(item);
    try {
      const fadeSamples = Math.round((CONFORM_FADE_MS / 1000) * item.audio.sampleRate);
      const { blob, seconds, alignment } = await runConform({
        channels: item.audio.channels,
        sampleRate: item.audio.sampleRate,
        bitDepth: state.bitDepth,
        plan,
        seed: item.id,
        fadeInSamples: fadeSamples,
        fadeOutSamples: fadeSamples,
      });
      const decoded = await getAudioContext().decodeAudioData(await blob.arrayBuffer());
      const channels = bufferChannels(decoded);
      item.result = {
        signature,
        plan,
        blob,
        seconds,
        alignment: alignment || null,
        audio: { channels, mono: toMono(channels), sampleRate: decoded.sampleRate, duration: channels[0].length / decoded.sampleRate },
      };
      const card = cards.get(item.id);
      if (card) card.setConformedAudio(item.result.audio);
    } catch (err) {
      item.renderError = err.message || String(err);
      logWarn(`Couldn't conform "${item.name}": ${item.renderError}`);
    } finally {
      item.busy = false;
      renderItem(item);
    }
    return item.result;
  }

  async function processAll() {
    if (state.busy) return;
    const ready = state.items.filter((i) => i.status === "ready");
    if (!ready.length) return;
    state.busy = true;
    render();
    log(`Processing ${ready.length} loop${ready.length === 1 ? "" : "s"} to ${formatTarget(state.target)}…`);
    let done = 0;
    for (const item of ready) {
      // Conforming twenty long loops is minutes of work; "working…" with no sense of how
      // far along is the kind of silence that makes people reload the page.
      mixPlayer.setProgress(`processing ${done + 1}/${ready.length}`);
      await processItem(item);
      done++;
      await yieldToUi();
    }
    mixPlayer.setProgress(null);
    state.busy = false;
    render();
    logSuccess(`Processed ${done} loop${done === 1 ? "" : "s"} to ${formatTarget(state.target)}.`);
  }

  // -------------------------------------------------------------------------
  // Auto-processing
  //
  // Change a loop's stretch method, correct its tempo, flip a Fit switch - and hear the
  // result, without going and finding a Process button first. The STRETCH task already
  // works this way; there was no reason PLAY NICE shouldn't.
  //
  // Two things make it safe, both borrowed from scheduleStretchPreview() in app.js:
  //
  //   - DEBOUNCE. Dragging a slider or holding a key fires a change per tick; each one just
  //     resets one shared timer, so the render starts once the value has settled.
  //   - LATEST-WINS. Some methods are far slower than others, so an older render can finish
  //     after a newer one. Every run tags itself with the generation counter at the moment
  //     it started and stops the instant that has moved on, without touching the UI.
  //
  // Scope is deliberately asymmetric. A change to ONE loop re-renders that loop, because
  // you were plainly working on it. A change to a session-wide setting (the target, the
  // session method, key matching) re-renders only loops you have ALREADY rendered - keeping
  // what you were listening to current, without silently kicking off twenty renders you
  // never asked for.
  // -------------------------------------------------------------------------

  const AUTO_PROCESS_DEBOUNCE_MS = 350;
  let autoProcessTimer = null;
  let autoProcessGeneration = 0;
  const autoProcessQueue = new Set();

  function scheduleAutoProcess(items) {
    for (const item of items) autoProcessQueue.add(item.id);
    if (autoProcessTimer) clearTimeout(autoProcessTimer);
    autoProcessTimer = setTimeout(runAutoProcess, AUTO_PROCESS_DEBOUNCE_MS);
  }

  /** Everything the user has already heard, so it stays current when a shared setting moves. */
  function scheduleAutoProcessForRendered() {
    scheduleAutoProcess(state.items.filter((i) => i.result));
  }

  async function runAutoProcess() {
    autoProcessTimer = null;
    const generation = ++autoProcessGeneration;
    const ids = [...autoProcessQueue];
    autoProcessQueue.clear();
    // An explicit Process all / Export all is already doing this work; don't race it.
    if (state.busy) return;

    for (const id of ids) {
      if (generation !== autoProcessGeneration) return;
      const item = state.items.find((i) => i.id === id);
      if (!item || item.status !== "ready" || item.busy) continue;
      const plan = planFor(item);
      if (item.result && item.result.signature === planSignature(plan)) continue; // already current
      await processItem(item);
      if (generation !== autoProcessGeneration) return;
      await yieldToUi();
    }
    if (generation === autoProcessGeneration) mixPlayer.refresh();
  }

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  async function exportItem(item) {
    const result = await processItem(item);
    if (!result) return;
    const name = conformedFileName(item.name, state.target, result.plan);
    // A single export is a download, not a folder write: it's the "I just want this one"
    // action, and asking for a destination folder to place one file is friction.
    downloadBlob(result.blob, name);
    logSuccess(`Exported ${name}`);
  }

  async function exportAll() {
    if (state.busy) return;
    const ready = state.items.filter((i) => i.status === "ready");
    if (!ready.length) {
      logWarn("Nothing to export yet.");
      return;
    }

    log(`Exporting ${ready.length} loop${ready.length === 1 ? "" : "s"}…`);
    const folder = batchFolderName(state.target);
    let dirHandle = null;
    if (io.supportsFSA) {
      // Asked once per session and remembered, so a second Export All after a few tweaks
      // doesn't re-prompt.
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
    for (const item of ready) {
      mixPlayer.setProgress(`exporting ${++index}/${ready.length}`);
      const result = await processItem(item);
      if (!result) {
        failed++;
        continue;
      }
      // Two source folders can both hold "loop.wav"; a flat destination would silently
      // overwrite one with the other.
      const name = uniqueName(conformedFileName(item.name, state.target, result.plan), taken);
      try {
        if (dirHandle) await io.writeFile(dirHandle, folder, "", name, result.blob);
        else zip.addFile(folder, "", "", name, result.blob);
        written++;
      } catch (err) {
        failed++;
        logWarn(`Couldn't write "${name}": ${err.message || err}`);
      }
      await yieldToUi();
    }

    mixPlayer.setProgress(null);
    if (zip && written > 0) await zip.downloadAs(`${folder}.zip`);

    state.busy = false;
    render();
    if (written) {
      logSuccess(`Exported ${written} loop${written === 1 ? "" : "s"} to ${dirHandle ? `${folder}/` : `${folder}.zip`}.`);
    }
    if (failed) logWarn(`${failed} loop${failed === 1 ? "" : "s"} couldn't be exported.`);
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

  function mountCard(item) {
    const card = createLoopCard({
      item,
      getAudioContext,
      color,
      methodGroups: methodGroups(),
      onSourceChange: (patch) => handleSourceChange(item, patch),
      onOptionsChange: (patch) => handleOptionsChange(item, patch),
      onPreview: () => processItem(item, { force: false }),
      onExport: () => exportItem(item),
      onRemove: async () => {
        if (item.result || item.status === "ready") {
          const { confirmed } = await showConfirmDialog({
            title: `Remove "${item.name}"?`,
            body: "It leaves this batch along with its analysis and anything processed from it.",
            confirmLabel: "Remove",
            cancelLabel: "Keep",
          });
          if (!confirmed) return;
        }
        removeItem(item);
      },
      onUseAsReference: () => setReferenceItem(item),
      onSolo: () => toggleSolo(item),
      onSoloPlay: () => mixPlayer.stop(),
      // Only ever one card open: twenty expanded cards is the wall of scrolling the
      // collapsed row exists to prevent, and you audition one loop at a time anyway.
      onExpandedChange: (isOpen) => {
        if (!isOpen) return;
        for (const [id, other] of cards) {
          if (id !== item.id && other.isExpanded()) other.setExpanded(false);
        }
      },
    });
    cards.set(item.id, card);
    loopList.appendChild(card.element);
  }

  function handleSourceChange(item, patch) {
    if ("bpm" in patch) {
      const bpm = sanitizeSourceBpm(patch.bpm);
      if (bpm != null) item.overrides.bpm = bpm;
    }
    if ("key" in patch && isNote(patch.key)) item.overrides.key = patch.key;
    if ("mode" in patch) item.overrides.mode = normalizeMode(patch.mode);
    if ("keyDisabled" in patch) item.keyDisabled = !!patch.keyDisabled;
    // A corrected detection changes the required transformation immediately - the whole
    // point of the correction being here rather than behind a "reanalyse" button - and the
    // audio follows on its own a moment later.
    renderItem(item);
    scheduleAutoProcess([item]);
  }

  function handleOptionsChange(item, patch) {
    if ("tempoFit" in patch) item.tempoFit = !!patch.tempoFit;
    if ("pitchFit" in patch) item.pitchFit = !!patch.pitchFit;
    if ("method" in patch) item.method = patch.method;
    if ("timeFeel" in patch) item.timeFeel = patch.timeFeel;
    if ("inMix" in patch) {
      item.inMix = !!patch.inMix;
      // Gain, not reload: muting a loop mid-playback must not restart the other eleven.
      mixPlayer.applyTrackStates();
    }
    renderItem(item);
    // "In mix" only changes what is audible, not what the audio IS, so it needs no render.
    if ("tempoFit" in patch || "pitchFit" in patch || "method" in patch || "timeFeel" in patch) scheduleAutoProcess([item]);
  }

  function viewFor(item) {
    const source = effectiveSource(item);
    const detected = item.detected || {};
    const plan = planFor(item);
    const stale = !!(item.result && item.result.signature !== planSignature(plan));
    const seconds = item.audio ? predictedDuration(item.audio.duration, plan) : null;

    return {
      status: item.status,
      busy: item.busy,
      isReference: state.referenceId === item.id,
      inMix: item.inMix,
      soloed: state.soloId === item.id,
      hasConformed: !!item.result,
      levelText: item.rmsDb != null ? formatLevel(item.rmsDb, monitorGain(item)) : null,
      percussive: item.percussive,
      timeFeel: item.timeFeel,
      timeFeels: TIME_FEELS,
      timeFeelText: formatTimeFeel(item.timeFeel, state.target.bpm),
      ...attentionFor(item, plan),
      statusText: statusTextFor(item),
      plan,
      stale,
      renderError: item.renderError,
      detectedBpm: detected.bpm,
      detectedBpmText: formatBpmText(detected.bpm, false, item.analysisAvailable),
      autoOctave: plan.tempo.autoOctave,
      detectedKeyText: detected.key ? formatKey(detected.key, detected.scale) : item.analysisAvailable ? "no clear key" : "unavailable",
      // The INTERPRETED tempo, not the raw detected one: if half/double was resolved
      // automatically, the field and the chips must show what is actually in force.
      sourceBpm: plan.tempo.interpretedBpm != null ? plan.tempo.interpretedBpm : source.bpm,
      bpmIsManual: item.overrides.bpm != null,
      sourceKey: item.overrides.key || detected.key || "C",
      sourceMode: item.overrides.mode || detected.scale || "major",
      keyIsManual: !!(item.overrides.key || item.overrides.mode),
      keyDisabled: item.keyDisabled,
      tempoFit: item.tempoFit,
      pitchFit: item.pitchFit,
      method: item.method,
      sessionMethodLabel: describeMethod(state.sessionMethod).label,
      predictedDurationText: seconds != null ? `${seconds.toFixed(2)}s${item.audio ? ` (was ${item.audio.duration.toFixed(2)}s)` : ""}` : "-",
      conformedNote: item.result ? (stale ? "settings changed - process again" : `${item.result.seconds.toFixed(2)}s`) : "not processed yet",
      alignment: item.result ? item.result.alignment : null,
      ...transformSummary(item, plan),
    };
  }

  /**
   * "104 BPM · G major → 120 BPM · D# major" - the headline answer to "what am I getting?".
   * Each half is built from what will ACTUALLY happen, not from the target: a loop with
   * tempo fitting off keeps its own tempo on the right-hand side, and a loop conformed to
   * the target's relative key says so rather than naming a key it never reaches.
   */
  function transformSummary(item, plan) {
    const source = effectiveSource(item);
    const detected = item.detected || {};

    const fromBpm = plan.tempo.interpretedBpm || source.bpm;
    const fromKey = source.key ? formatKey(source.key, source.mode) : detected.key ? formatKey(detected.key, detected.scale) : null;
    const fromText = [fromBpm ? `${Math.round(fromBpm)} BPM` : null, fromKey].filter(Boolean).join(" · ") || "unknown";

    const toBpm = plan.tempo.fit && plan.tempo.targetBpm ? plan.tempo.targetBpm : fromBpm;
    const toKey = plan.pitch.fit && plan.pitch.resultKey ? formatKey(plan.pitch.resultKey, plan.pitch.resultMode) : fromKey;
    const toText = [toBpm ? `${Math.round(toBpm)} BPM` : null, toKey].filter(Boolean).join(" · ") || "unchanged";

    const notes = [];
    if (!plan.tempo.fit) notes.push("tempo left alone");
    if (!plan.pitch.fit || item.keyDisabled) notes.push("key left alone");
    if (plan.pitch.relativeUsed) notes.push("relative key");

    return { fromText, toText, transformNote: notes.join(" · ") };
  }

  /**
   * Does this loop want looking at?
   *
   * The batch job is not "check twenty loops", it is "find the two that went wrong" - so
   * the list needs to say which those are without being read. Anything here is a case where
   * the conform is very likely not what the user wants, and all of them are one click from
   * being fixed.
   */
  function attentionFor(item, plan) {
    const reasons = [];
    if (item.renderError) reasons.push("it failed to process");
    for (const w of plan.warnings) reasons.push(w.text);
    if (plan.tempo.fit && !plan.tempo.applied && plan.tempo.reason && !/already at the target|not applicable/.test(plan.tempo.reason)) {
      reasons.push(`tempo not fitted - ${plan.tempo.reason}`);
    }
    // Not when key matching was deliberately switched off for this loop - by the user, or
    // by percussion detection. Flagging a loop for doing exactly what it was told is the
    // fastest way to make the warning dot mean nothing, and it is why drum loops were
    // coming up flagged for having no key.
    if (!item.keyDisabled && plan.pitch.fit && !plan.pitch.applied && plan.pitch.reason && !/already in the target key/.test(plan.pitch.reason)) {
      reasons.push(`key not fitted - ${plan.pitch.reason}`);
    }
    if (plan.tempo.applied && !plan.tempo.snapped) {
      reasons.push("its length isn't a whole number of beats at the tempo it was detected at, so it may not loop cleanly - try a different reading of the source BPM");
    }
    // 6 is the furthest nearest-root matching ever goes, so it's the only shift extreme
    // enough to be worth a flag. Flagging 5 as well lit up a third of a real batch, which
    // is exactly the "warning about everything warns about nothing" failure.
    if (Math.abs(plan.pitch.semitones) >= 6) reasons.push(`a ${Math.abs(plan.pitch.semitones)}-semitone shift is as far as this ever moves a loop`);
    // As a LIST, not a joined string: the card renders these as visible text in the body.
    // They were previously only ever a title attribute, which meant the reasons that aren't
    // also plan warnings - "length isn't a whole number of beats", most commonly - appeared
    // literally nowhere except a tooltip on a 16px dot.
    return { needsAttention: reasons.length > 0, attentionReasons: reasons, attentionReason: reasons.join(" · ") };
  }

  function statusTextFor(item) {
    if (item.status === "error") return item.error || "failed";
    if (item.busy) return "processing…";
    if (item.status === "decoding") return "decoding…";
    if (item.status === "analysing") return "analysing…";
    if (item.status === "queued") return "queued";
    return "";
  }

  function renderItem(item) {
    const card = cards.get(item.id);
    if (card) card.render(viewFor(item));
  }

  function render() {
    const readiness = targetReadiness(state.target);
    targetPanel.render(
      {
        ...state.target,
        keyStrategy: state.keyStrategy,
        snapToLoop: state.snapToLoop,
        alignDownbeat: state.alignDownbeat,
        bitDepth: state.bitDepth,
        summary: formatTarget(state.target),
      },
      referenceViewState()
    );

    sessionMethodSelect.value = state.sessionMethod;
    const method = describeMethod(state.sessionMethod);
    methodHint.textContent = method.preservesPitch
      ? method.description
      : `${method.description} Pitch fitting compensates for that so the result still lands on the target key.`;

    const ready = state.items.filter((i) => i.status === "ready").length;
    loopsCount.textContent = state.items.length ? `${ready} of ${state.items.length} ready` : "";
    loopList.hidden = state.items.length === 0;

    // Attention filter. Hidden entirely when there is nothing to filter, so it never nags.
    let flagged = 0;
    for (const item of state.items) {
      if (item.status === "error") flagged++;
      else if (item.status === "ready" && attentionFor(item, planFor(item)).needsAttention) flagged++;
    }
    filterRow.hidden = state.items.length === 0;
    attentionBtn.hidden = flagged === 0 && !state.onlyNeedsAttention;
    attentionBtn.classList.toggle("is-active", state.onlyNeedsAttention);
    attentionBtn.textContent = state.onlyNeedsAttention ? `Showing ${flagged} that need a look` : `${flagged} need${flagged === 1 ? "s" : ""} a look`;
    filterNote.textContent = flagged === 0 && state.items.length ? "nothing looks wrong" : "";

    const canAct = ready > 0 && !state.busy && readiness.usable;
    clearBtn.disabled = state.items.length === 0 || state.busy;
    addLoopsBtn.disabled = state.busy;

    for (const item of state.items) {
      renderItem(item);
      const card = cards.get(item.id);
      if (!card) continue;
      const flaggedItem = item.status === "error" || (item.status === "ready" && attentionFor(item, planFor(item)).needsAttention);
      card.element.hidden = state.onlyNeedsAttention && !flaggedItem;
    }
    mixPlayer.refresh();
    mixPlayer.setActionsState({
      canProcess: canAct,
      canExport: canAct,
      busy: state.busy,
      label: state.items.length ? `${mixTracks().length}/${ready} in mix` : "",
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Decode a file into the {channels, mono, sampleRate, duration} shape the waveforms and the
   * conform pipeline both want.
   *
   * Duration is DERIVED, never read off the buffer: app.js's decodeFile() returns a real
   * AudioBuffer for natively-decoded formats but a lightweight buffer-LIKE for .wav/.aiff
   * (see makeBufferLike() in js/audio-codec.js), and that buffer-like has no `duration`
   * property. Reading buffer.duration therefore worked for mp3/m4a and was silently undefined
   * for exactly the format this feature is most often handed.
   */
  async function decodeToAudio(file) {
    const { buffer } = await decodeFile(file, extOf(file.name));
    const channels = bufferChannels(buffer);
    if (!channels.length || !channels[0].length) throw new Error("no audio in that file");
    return { channels, mono: toMono(channels), sampleRate: buffer.sampleRate, duration: channels[0].length / buffer.sampleRate };
  }

  render();

  return {
    element: root,
    stopAllPlayback() {
      mixPlayer.stop();
      targetPanel.stopPlayback();
      for (const card of cards.values()) card.stopPlayback();
    },
    /** PLAY NICE is on screen (or not) - the bottom bar follows, and is padded for. */
    setActive(active) {
      mixPlayer.setVisible(!!active);
    },
    hasContent() {
      return state.items.length > 0;
    },
    /** Wipe the session - what New Session calls. */
    reset() {
      this.stopAllPlayback();
      clearLoops();
      state.target = createTargetContext();
      state.exportDir = null;
      state.soloId = null;
      state.onlyNeedsAttention = false;
      saveSession();
      render();
    },
  };

  function referenceViewState() {
    const r = referenceItem();
    if (!r) return null;
    return {
      name: r.name,
      status: r.status,
      statusText:
        r.status === "error"
          ? r.error
          : r.status === "decoding"
            ? "decoding…"
            : r.status === "analysing" || r.status === "queued"
              ? "analysing…"
              : r.detected && r.detected.bpm
                ? "detected - correct anything that looks wrong"
                : "no confident tempo detected - set one yourself",
      detected: r.detected,
      analysisAvailable: r.analysisAvailable,
    };
  }
}

/** Apply a saved blob over the defaults, validating everything - a corrupt or stale entry must not break startup. */
function restoreSession(state) {
  const saved = readJSON(STORAGE_KEY);
  if (!saved || typeof saved !== "object") return;
  const t = saved.target;
  if (t && typeof t === "object") {
    const bpm = sanitizeTargetBpm(t.bpm);
    if (bpm != null) state.target.bpm = bpm;
    if (isNote(t.key)) state.target.key = t.key;
    const mode = normalizeMode(t.keyMode);
    if (mode) state.target.keyMode = mode;
    if (typeof t.pitchEnabled === "boolean") state.target.pitchEnabled = t.pitchEnabled;
  }
  if (typeof saved.sessionMethod === "string") state.sessionMethod = saved.sessionMethod;
  if (typeof saved.keyStrategy === "string") state.keyStrategy = saved.keyStrategy;
  for (const flag of ["snapToLoop", "alignDownbeat", "matchLevels"]) {
    if (typeof saved[flag] === "boolean") state[flag] = saved[flag];
  }
  if ([16, 24, 32].includes(saved.bitDepth)) state.bitDepth = saved.bitDepth;
  if (saved.mixSource === "original" || saved.mixSource === "conformed") state.mixSource = saved.mixSource;
}

function bufferChannels(buffer) {
  const out = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
  return out;
}

/** Let the browser paint between files, so a batch shows progress instead of freezing. */
function yieldToUi() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

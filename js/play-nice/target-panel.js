// target-panel.js
//
// The TARGET half of PLAY NICE's UI: the Defined / Reference Loop switch and whichever
// editor that choice calls for. Its entire job is to produce a TargetContext - it owns
// no audio pipeline and knows nothing about loops, conforming or export.
//
// Built once and updated in place (the same reason js/stretch-workspace.js is a set of
// small setX/renderX methods rather than one render(viewModel)): typing in the BPM field
// must not tear down and rebuild the reference loop's waveform, which would both look
// broken and silently kill any audition currently playing.
//
// ANALYSIS PROPOSES, USER OVERRIDES, visibly: in Reference mode the detected values are
// shown as detected, the editable fields are shown separately, and "Reset to detected" is
// always one click away. The user is never left guessing which number is in force.
import { NOTE_NAMES, FLAT_NAMES, formatKey, TRANSPOSE_STRATEGIES } from "./key-matching.js";
import { tempoInterpretations } from "./target-context.js";
import { createPreviewWaveform } from "../preview-waveform.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Root-note <select>, sharps labelled with their flat spelling too ("A# / Bb") for readability. */
function noteSelect(id) {
  const select = el("select");
  select.id = id;
  for (const note of NOTE_NAMES) {
    const opt = document.createElement("option");
    opt.value = note;
    opt.textContent = FLAT_NAMES[note] ? `${note} / ${FLAT_NAMES[note]}` : note;
    select.appendChild(opt);
  }
  return select;
}

/** Major/Minor as a two-button segmented control - the same `.seg` language the task switcher uses. */
function modeToggle(onChange) {
  const seg = el("div", "seg pn-mode-seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Major or minor");
  const buttons = {};
  for (const value of ["major", "minor"]) {
    const btn = el("button", "seg-btn", value === "major" ? "Major" : "Minor");
    btn.type = "button";
    btn.addEventListener("click", () => onChange(value));
    buttons[value] = btn;
    seg.appendChild(btn);
  }
  return { seg, buttons };
}

/**
 * @param {object} deps
 * @param {HTMLElement} deps.container
 * @param {() => AudioContext} deps.getAudioContext
 * @param {(name:string, fallback:string) => string} deps.color
 * @param {(patch:object) => void} deps.onTargetChange   merge a patch into the TargetContext
 * @param {(mode:string) => void} deps.onModeChange      "defined" | "reference"
 * @param {() => void} deps.onPickReference
 * @param {(files:File[]) => void} deps.onReferenceFiles
 * @param {() => void} deps.onClearReference
 * @param {() => void} deps.onResetReferenceDetection
 * @param {(strategy:string) => void} deps.onKeyStrategyChange
 * @param {(enabled:boolean) => void} deps.onSnapChange
 * @param {(enabled:boolean) => void} deps.onAlignChange
 * @param {(depth:number) => void} deps.onBitDepthChange
 */
export function createTargetPanel({
  container,
  getAudioContext,
  color,
  onTargetChange,
  onModeChange,
  onPickReference,
  onReferenceFiles,
  onClearReference,
  onResetReferenceDetection,
  onKeyStrategyChange,
  onSnapChange,
  onAlignChange,
  onBitDepthChange,
}) {
  const panel = el("section", "pn-panel pn-target");
  container.appendChild(panel);

  // Clickable header. The target is a set-once decision you then refer to constantly, so it
  // belongs on screen as a LINE, not as a 277px block permanently occupying the top of a
  // list you are trying to scan. Collapsed, the header still answers "what am I conforming
  // to?" - which is the only question it needs to answer most of the time.
  const head = el("button", "pn-panel-head pn-panel-head--toggle");
  head.type = "button";
  const collapseIcon = el("span", "pn-panel-caret", "▾");
  const headTitle = el("h2", "pn-panel-title", "Target");
  const summary = el("span", "pn-target-summary");
  head.append(collapseIcon, headTitle, summary);
  head.addEventListener("click", () => setCollapsed(!collapsed));
  panel.appendChild(head);

  const panelBody = el("div", "pn-panel-body");
  panel.appendChild(panelBody);

  let collapsed = false;
  function setCollapsed(next) {
    collapsed = !!next;
    panel.classList.toggle("is-collapsed", collapsed);
    panelBody.hidden = collapsed;
    collapseIcon.textContent = collapsed ? "▸" : "▾";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
  }

  // ---- mode switch -------------------------------------------------------
  const modeSeg = el("div", "seg pn-target-seg");
  modeSeg.setAttribute("role", "group");
  modeSeg.setAttribute("aria-label", "Where the target comes from");
  const modeButtons = {};
  for (const [value, label, title] of [
    ["defined", "Defined", "Type the BPM and key you want everything conformed to."],
    ["reference", "Reference loop", "Load a loop you already like and conform everything else to it."],
  ]) {
    const btn = el("button", "seg-btn", label);
    btn.type = "button";
    btn.title = title;
    btn.addEventListener("click", () => onModeChange(value));
    modeButtons[value] = btn;
    modeSeg.appendChild(btn);
  }
  panelBody.appendChild(modeSeg);

  // ---- the editable target values ---------------------------------------
  //
  // Shared by both modes on purpose. In Reference mode these are seeded from detection
  // and stay editable; there is no second set of controls, and no mode in which the
  // target isn't the user's to change.

  const valuesRow = el("div", "pn-target-values");
  panelBody.appendChild(valuesRow);

  const bpmField = el("div", "field pn-field");
  const bpmLabel = el("label", null, "BPM");
  bpmLabel.htmlFor = "pn-target-bpm";
  const bpmInput = el("input");
  bpmInput.id = "pn-target-bpm";
  bpmInput.type = "number";
  bpmInput.className = "slider-number pn-bpm-input";
  bpmInput.min = "1";
  bpmInput.step = "0.01";
  bpmInput.addEventListener("change", () => onTargetChange({ bpm: bpmInput.value }));
  bpmField.append(bpmLabel, bpmInput);

  const keyField = el("div", "field pn-field");
  const keyLabel = el("label", null, "Key");
  keyLabel.htmlFor = "pn-target-key";
  const keySelect = noteSelect("pn-target-key");
  keySelect.addEventListener("change", () => onTargetChange({ key: keySelect.value }));
  keyField.append(keyLabel, keySelect);

  const modeField = el("div", "field pn-field");
  modeField.appendChild(el("label", null, "Mode"));
  const { seg: keyModeSeg, buttons: keyModeButtons } = modeToggle((value) => onTargetChange({ keyMode: value }));
  modeField.appendChild(keyModeSeg);

  valuesRow.append(bpmField, keyField, modeField);

  // How a source key is matched onto the target when the two modes differ. Not a stretch
  // setting and not a per-loop one: it is a statement about what "in the target key" is
  // allowed to mean for this session. See TRANSPOSE_STRATEGIES in key-matching.js.
  const strategyField = el("div", "field pn-field pn-strategy-field");
  const strategyLabel = el("label", null, "Key matching");
  strategyLabel.htmlFor = "pn-key-strategy";
  const strategySelect = el("select");
  strategySelect.id = "pn-key-strategy";
  for (const [key, strategy] of Object.entries(TRANSPOSE_STRATEGIES)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = strategy.label;
    opt.title = strategy.description;
    strategySelect.appendChild(opt);
  }
  strategySelect.addEventListener("change", () => onKeyStrategyChange(strategySelect.value));
  strategyField.append(strategyLabel, strategySelect);
  valuesRow.appendChild(strategyField);

  const strategyHint = el("p", "mod-note pn-strategy-hint");

  // Pitch fitting can be switched off for the whole session - the honest answer when the
  // target is a drum loop with no key worth conforming to. Loops keep their own PITCH
  // switch; this one is the session-wide "key doesn't mean anything here".
  const pitchToggle = el("label", "checkbox pn-target-pitch-toggle");
  const pitchCheckbox = el("input");
  pitchCheckbox.type = "checkbox";
  pitchCheckbox.addEventListener("change", () => onTargetChange({ pitchEnabled: pitchCheckbox.checked }));
  pitchToggle.append(pitchCheckbox, el("span", null, "Conform key as well as tempo"));

  // Tempo detection is accurate to a fraction of a percent, which is inaudible on one
  // playthrough and ruinous in a mix that loops - the error compounds every cycle until
  // the batch flams. Deriving each loop's tempo from its own exact length instead fixes it.
  const snapToggle = el("label", "checkbox pn-target-snap-toggle");
  const snapCheckbox = el("input");
  snapCheckbox.type = "checkbox";
  snapCheckbox.addEventListener("change", () => onSnapChange(snapCheckbox.checked));
  snapToggle.append(snapCheckbox, el("span", null, "Snap loops to whole beats"));
  snapToggle.title = "Trust each loop's length over its detected tempo, so a looping mix stays locked instead of drifting apart.";

  // Rotating each loop so its attacks land on the beat grid, and deriving its tempo from
  // its own length. Both are CORRECTNESS, not taste - they have no musical meaning to the
  // user, and offering them at the same visual weight as Key matching invited switching off
  // the things that make the tool work. Behind a disclosure, off the main path, available
  // when something looks wrong and you want to know whether these are why.
  const advanced = document.createElement("details");
  advanced.className = "pn-advanced";
  const advancedSummary = document.createElement("summary");
  advancedSummary.textContent = "Advanced";
  advanced.appendChild(advancedSummary);

  const alignToggle = el("label", "checkbox pn-target-align-toggle");
  const alignCheckbox = el("input");
  alignCheckbox.type = "checkbox";
  alignCheckbox.addEventListener("change", () => onAlignChange(alignCheckbox.checked));
  alignToggle.append(alignCheckbox, el("span", null, "Line loops up to the grid"));
  alignToggle.title = "Nudge each loop so its first beat lands where it should. Only ever moves audio by less than a sixteenth note.";

  const exportField = el("div", "field pn-field");
  const exportLabel = el("label", null, "Export bit depth");
  exportLabel.htmlFor = "pn-bit-depth";
  const bitDepthSelect = el("select");
  bitDepthSelect.id = "pn-bit-depth";
  for (const depth of [16, 24, 32]) {
    const opt = document.createElement("option");
    opt.value = String(depth);
    opt.textContent = `${depth}-bit`;
    bitDepthSelect.appendChild(opt);
  }
  bitDepthSelect.addEventListener("change", () => onBitDepthChange(Number(bitDepthSelect.value)));
  exportField.append(exportLabel, bitDepthSelect);

  advanced.append(snapToggle, alignToggle, exportField);

  panelBody.append(pitchToggle, strategyHint, advanced);

  // ---- reference-loop area ----------------------------------------------

  const referenceArea = el("div", "pn-reference");
  panelBody.appendChild(referenceArea);

  const refDrop = el("div", "pn-dropzone pn-dropzone--reference");
  const refCopy = el("div", "dropzone-copy");
  refCopy.append(el("strong", null, "Drop a reference loop"), el("span", null, "its BPM and key become the target"));
  const refActions = el("div", "dropzone-actions");
  const refPickBtn = el("button", "btn btn--primary", "Choose loop");
  refPickBtn.type = "button";
  refPickBtn.addEventListener("click", onPickReference);
  refActions.appendChild(refPickBtn);
  refDrop.append(refCopy, refActions);
  referenceArea.appendChild(refDrop);

  wireDropZone(refDrop, onReferenceFiles);

  const refLoaded = el("div", "pn-reference-loaded");
  refLoaded.hidden = true;
  referenceArea.appendChild(refLoaded);

  const refHead = el("div", "pn-reference-head");
  const refName = el("strong", "pn-reference-name");
  const refHeadActions = el("div", "pn-reference-head-actions");
  const refResetBtn = el("button", "btn btn--ghost btn--small", "Reset to detected");
  refResetBtn.type = "button";
  refResetBtn.title = "Put the detected BPM and key back, discarding manual corrections.";
  refResetBtn.addEventListener("click", onResetReferenceDetection);
  const refClearBtn = el("button", "btn btn--ghost btn--small", "Remove");
  refClearBtn.type = "button";
  refClearBtn.addEventListener("click", onClearReference);
  refHeadActions.append(refResetBtn, refClearBtn);
  refHead.append(refName, refHeadActions);
  refLoaded.appendChild(refHead);

  const refStatus = el("p", "pn-reference-status");
  refLoaded.appendChild(refStatus);

  const refWaveHost = el("div", "pn-reference-wave");
  refLoaded.appendChild(refWaveHost);

  const refDetected = el("div", "pn-detected-row");
  refLoaded.appendChild(refDetected);

  // "Detected: 64 BPM - interpret as [32] [64] [128] [256]". Octave errors are the most
  // common tempo-detection failure by a wide margin, so correcting one is a single click.
  const interpRow = el("div", "pn-interpret-row");
  const interpLabel = el("span", "pn-interpret-label", "Interpret as");
  const interpChips = el("div", "pn-interpret-chips");
  interpRow.append(interpLabel, interpChips);
  refLoaded.appendChild(interpRow);

  let waveform = null;

  function destroyWaveform() {
    if (waveform) {
      waveform.destroy();
      waveform = null;
    }
    refWaveHost.replaceChildren();
  }

  return {
    element: panel,
    setCollapsed,
    isCollapsed: () => collapsed,

    /** Rebuild the reference loop's waveform. Only called when the reference audio itself changes. */
    setReferenceAudio(audio) {
      destroyWaveform();
      if (!audio) return;
      waveform = createPreviewWaveform({
        mono: audio.mono,
        sampleRate: audio.sampleRate,
        duration: audio.duration,
        color,
        getAudioContext,
      });
      refWaveHost.appendChild(waveform.el);
    },

    stopPlayback() {
      if (waveform) waveform.stop();
    },

    /** Everything that isn't the waveform, refreshed in place from the current context. */
    render(context, referenceState) {
      summary.textContent = context.summary;

      for (const [value, btn] of Object.entries(modeButtons)) {
        btn.classList.toggle("is-active", context.mode === value);
      }

      if (document.activeElement !== bpmInput) bpmInput.value = context.bpm != null ? String(round2(context.bpm)) : "";
      keySelect.value = context.key || "C";
      for (const [value, btn] of Object.entries(keyModeButtons)) {
        btn.classList.toggle("is-active", context.keyMode === value);
      }
      pitchCheckbox.checked = !!context.pitchEnabled;
      snapCheckbox.checked = !!context.snapToLoop;
      alignCheckbox.checked = !!context.alignDownbeat;
      bitDepthSelect.value = String(context.bitDepth || 24);
      // A quiet nudge that something non-default is hiding in here.
      advancedSummary.textContent = context.snapToLoop && context.alignDownbeat ? "Advanced" : "Advanced · changed";
      strategySelect.value = context.keyStrategy;
      strategySelect.disabled = !context.pitchEnabled;
      strategyField.classList.toggle("is-disabled", !context.pitchEnabled);
      strategyHint.textContent = context.pitchEnabled ? (TRANSPOSE_STRATEGIES[context.keyStrategy] || {}).description || "" : "";
      keyField.classList.toggle("is-disabled", !context.pitchEnabled);
      modeField.classList.toggle("is-disabled", !context.pitchEnabled);
      keySelect.disabled = !context.pitchEnabled;
      for (const btn of Object.values(keyModeButtons)) btn.disabled = !context.pitchEnabled;

      const inReference = context.mode === "reference";
      referenceArea.hidden = !inReference;
      const hasReference = inReference && !!referenceState;
      refDrop.hidden = hasReference;
      refLoaded.hidden = !hasReference;
      if (!hasReference) {
        interpChips.replaceChildren();
        return;
      }

      refName.textContent = referenceState.name;
      refStatus.textContent = referenceState.statusText;
      refStatus.classList.toggle("is-error", referenceState.status === "error");

      const detected = referenceState.detected || {};
      const detectedBpmText = detected.bpm ? `${Math.round(detected.bpm)} BPM` : referenceState.analysisAvailable ? "BPM unclear" : "BPM unavailable";
      const detectedKeyText = detected.key ? formatKey(detected.key, detected.scale) : referenceState.analysisAvailable ? "no clear key" : "key unavailable";
      refDetected.replaceChildren(
        detectedLine("Detected", `${detectedBpmText} / ${detectedKeyText}`),
        detectedLine("Using", context.summary)
      );

      renderInterpretations(detected.bpm, context.bpm);
      refResetBtn.disabled = !detected.bpm && !detected.key;
    },
  };

  function renderInterpretations(detectedBpm, currentBpm) {
    const options = tempoInterpretations(detectedBpm);
    interpRow.hidden = options.length < 2;
    interpChips.replaceChildren();
    for (const value of options) {
      const chip = el("button", "pn-chip", String(value));
      chip.type = "button";
      // Whichever chip matches the value actually in force is the active one, including
      // after the user typed that number by hand rather than clicking the chip.
      chip.classList.toggle("is-active", Math.abs(value - (currentBpm || 0)) < 0.51);
      chip.addEventListener("click", () => onTargetChange({ bpm: value }));
      interpChips.appendChild(chip);
    }
  }

  function detectedLine(label, value) {
    const line = el("div", "field-readout pn-readout");
    line.append(el("span", null, label), el("strong", null, value));
    return line;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Drag-and-drop for a plain File list. PLAY NICE takes loose loop files rather than
 * folders-with-write-access, so this is deliberately the simple DataTransfer.files path
 * rather than the FSA handle dance app.js's source-folder drop zone needs.
 */
export function wireDropZone(zone, onFiles) {
  ["dragenter", "dragover"].forEach((name) => {
    zone.addEventListener(name, (ev) => {
      if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types || []).includes("Files")) return;
      ev.preventDefault();
      zone.classList.add("is-dragover");
    });
  });
  ["dragleave", "dragend"].forEach((name) => {
    zone.addEventListener(name, (ev) => {
      if (name === "dragleave" && ev.relatedTarget && zone.contains(ev.relatedTarget)) return;
      zone.classList.remove("is-dragover");
    });
  });
  zone.addEventListener("drop", (ev) => {
    if (!ev.dataTransfer) return;
    ev.preventDefault();
    // The whole PLAY NICE workspace is also a drop target (so a loop dropped anywhere lands
    // somewhere sensible), which means an inner zone's drop would otherwise bubble up and be
    // handled a SECOND time - dropping a reference loop would add it as a loop as well, and
    // dropping loops onto the loops zone would add every file twice. The innermost zone wins.
    ev.stopPropagation();
    zone.classList.remove("is-dragover");
    const files = Array.from(ev.dataTransfer.files || []);
    if (files.length) onFiles(files);
  });
}

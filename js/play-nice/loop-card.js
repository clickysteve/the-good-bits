// loop-card.js
//
// One loaded loop. Collapsed to a single scannable row by default, expanded on demand.
//
// WHY COLLAPSED IS THE DEFAULT: PLAY NICE is built around throwing twenty loops at it, and
// the fully-detailed card is about 450px tall - so at any normal window size exactly zero
// of them fitted on screen at once and a twenty-loop batch was nine thousand pixels of
// scrolling. The batch judgement you actually make ("which of these got detected wrong?")
// needs to be a glance down a list, not a scroll-and-remember exercise. Everything the
// glance needs is in the row: what the loop was, what it becomes, how, and whether it wants
// looking at. Everything you only need for ONE loop at a time - the detection editors, the
// numbers, the audition - lives in the body.
//
// Built once per item and updated in place, never re-created on every state change - the
// same reasons stretch-workspace.js gives: rebuilding would kill audio mid-audition, and
// twenty cards rebuilding on every keystroke in one of them is visibly slow.
//
// DETECTED vs IN FORCE: shown next to each other, and the second is always editable.
// Everything downstream (the ratio, the semitones, the filename) recalculates from the
// corrected value immediately - see onSourceChange.
//
// A/B AUDITION: ONE player whose audio is swapped between Original and Conformed, not two
// players side by side. Two playheads meant comparing "the same moment, processed and
// unprocessed" involved starting one, stopping it, starting the other and hunting for the
// position again. See setAudio() in js/preview-waveform.js.
import { NOTE_NAMES, FLAT_NAMES, formatSemitones, formatKey } from "./key-matching.js";
import { tempoInterpretations } from "./target-context.js";
import { formatRatio, formatTempoChange } from "./conform.js";
import { METHOD_INHERIT } from "./methods.js";
import { createPreviewWaveform } from "../preview-waveform.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Compact two-state Fit/Off switch. TEMPO and PITCH share it so they read as one kind of decision. */
function fitToggle(label, title, onChange) {
  const wrap = el("div", "pn-fit");
  const tag = el("span", "pn-fit-label", label);
  tag.title = title;
  wrap.appendChild(tag);
  const seg = el("div", "seg pn-fit-seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", title);
  const buttons = {};
  for (const [value, text] of [
    [true, "Fit"],
    [false, "Off"],
  ]) {
    const btn = el("button", "seg-btn", text);
    btn.type = "button";
    btn.addEventListener("click", () => onChange(value));
    buttons[String(value)] = btn;
    seg.appendChild(btn);
  }
  wrap.appendChild(seg);
  return { wrap, buttons };
}

/**
 * @param {object} deps
 * @param {object} deps.item                     the loop's state object (see controller.js)
 * @param {() => AudioContext} deps.getAudioContext
 * @param {(name:string, fallback:string) => string} deps.color
 * @param {object[]} deps.methodGroups           grouped stretch methods, from the character registry
 * @param {(patch:object) => void} deps.onSourceChange   {bpm} / {key} / {mode} / {keyDisabled}
 * @param {(patch:object) => void} deps.onOptionsChange  {tempoFit} / {pitchFit} / {method} / {inMix}
 * @param {() => void} deps.onSolo               hear this one alone
 * @param {() => void} deps.onPreview
 * @param {() => void} deps.onExport
 * @param {() => void} deps.onRemove
 * @param {() => void} deps.onUseAsReference
 * @param {() => void} deps.onSoloPlay           this card started playing - stop the mix
 * @param {(expanded:boolean) => void} deps.onExpandedChange
 */
export function createLoopCard({
  item,
  getAudioContext,
  color,
  methodGroups,
  onSourceChange,
  onOptionsChange,
  onSolo,
  onPreview,
  onExport,
  onRemove,
  onUseAsReference,
  onSoloPlay = () => {},
  onExpandedChange = () => {},
}) {
  const card = el("article", "pn-card");
  card.dataset.itemId = String(item.id);
  let expanded = false;

  // =========================================================================
  // The row - always visible, and the only thing most loops ever need
  // =========================================================================

  const row = el("header", "pn-card-row");

  const toggleBtn = el("button", "pn-card-toggle", "▸");
  toggleBtn.type = "button";
  toggleBtn.title = "Show detection, numbers and audition";
  toggleBtn.setAttribute("aria-expanded", "false");
  toggleBtn.addEventListener("click", () => setExpanded(!expanded));

  const identity = el("div", "pn-card-id");
  const nameEl = el("strong", "pn-card-name", item.name);
  nameEl.title = item.name;
  const referenceBadge = el("span", "pn-ref-badge", "Ref");
  referenceBadge.title = "Everything else is being conformed to this loop.";
  referenceBadge.hidden = true;
  // A single dot answering "does this one want looking at?" without reading anything. In a
  // batch of twenty the whole job is finding the two or three that do.
  const attention = el("button", "pn-attention", "!");
  attention.type = "button";
  attention.hidden = true;
  attention.title = "Why this needs a look";
  // Clicking opens the card, where the reasons are written out. A tooltip on a 16px dot is
  // not an explanation - it is a place to hide one.
  attention.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setExpanded(true);
  });
  identity.append(nameEl, referenceBadge, attention);

  const summary = el("div", "pn-card-summary");
  const rowAutoBadge = el("span", "pn-auto-badge pn-auto-badge--row", "auto");
  rowAutoBadge.hidden = true;
  rowAutoBadge.title = "Detection was an octave out and has been corrected against the target. Expand to see the detected value or override it.";
  const fromEl = el("span", "pn-transform-from");
  const arrowEl = el("span", "pn-transform-arrow", "→");
  const toEl = el("span", "pn-transform-to");
  const noteEl = el("span", "pn-transform-note");
  summary.append(rowAutoBadge, fromEl, arrowEl, toEl, noteEl);

  const status = el("span", "pn-card-status");

  const methodSelect = el("select", "pn-method-select");
  methodSelect.title = "How the stretch is performed. Never changes how much stretch is needed.";
  const inheritOption = document.createElement("option");
  inheritOption.value = METHOD_INHERIT;
  methodSelect.appendChild(inheritOption);
  for (const group of methodGroups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const character of group.characters) {
      const opt = document.createElement("option");
      opt.value = character.key;
      opt.textContent = character.label;
      opt.title = character.description || "";
      optgroup.appendChild(opt);
    }
    methodSelect.appendChild(optgroup);
  }
  methodSelect.addEventListener("change", () => onOptionsChange({ method: methodSelect.value }));

  // Half-time, double-time and friends. Conforms the loop to a MULTIPLE of the target
  // rather than to the target itself - a 174 break at half-time into an 87 track is twice
  // as long per bar, big and stretchy, and still locked to the grid. See time-feel.js.
  const feelSelect = el("select", "pn-feel-select");
  feelSelect.title = "Conform to a multiple of the target tempo - half-time for a big stretched break that still fits.";
  feelSelect.addEventListener("change", () => onOptionsChange({ timeFeel: feelSelect.value }));

  const tempoFit = fitToggle("T", "Tempo fitting", (v) => onOptionsChange({ tempoFit: v }));
  const pitchFit = fitToggle("P", "Pitch fitting", (v) => onOptionsChange({ pitchFit: v }));

  // Solo and mute, the two controls anyone reaches for constantly once more than three
  // things are playing. Muting was previously a checkbox called "In mix"; soloing eight
  // loops down to one meant unticking seven of them.
  const monitor = el("div", "pn-monitor");
  const soloBtn = el("button", "pn-mon-btn pn-solo", "S");
  soloBtn.type = "button";
  soloBtn.title = "Solo - hear only this one (click again to release)";
  soloBtn.setAttribute("aria-pressed", "false");
  soloBtn.addEventListener("click", onSolo);
  const muteBtn = el("button", "pn-mon-btn pn-mute", "M");
  muteBtn.type = "button";
  muteBtn.title = "Mute - leave this one out of the mix";
  muteBtn.setAttribute("aria-pressed", "false");
  muteBtn.addEventListener("click", () => onOptionsChange({ inMix: !item.inMix }));
  monitor.append(soloBtn, muteBtn);

  row.append(toggleBtn, identity, summary, status, feelSelect, methodSelect, tempoFit.wrap, pitchFit.wrap, monitor);
  card.appendChild(row);
  // Clicking anywhere in the row's dead space expands, so the chevron isn't a pixel hunt.
  row.addEventListener("click", (ev) => {
    if (ev.target.closest("button, select, input, label")) return;
    setExpanded(!expanded);
  });

  // =========================================================================
  // The body - one loop at a time
  // =========================================================================

  const body = el("div", "pn-card-body");
  body.hidden = true;
  card.appendChild(body);

  // Why this loop is flagged, in words, at the top of the body where it is unmissable.
  const attentionBlock = el("div", "pn-attention-block");
  attentionBlock.hidden = true;
  const attentionTitle = el("strong", "pn-attention-title", "Needs a look");
  const attentionList = el("ul", "pn-attention-list");
  attentionBlock.append(attentionTitle, attentionList);
  body.appendChild(attentionBlock);

  // ---- detection, editable ----
  const detection = el("div", "pn-detection");
  body.appendChild(detection);

  const tempoBlock = el("div", "pn-detect-block");
  const tempoHead = el("div", "pn-detect-head");
  tempoHead.append(el("span", "pn-detect-title", "Source BPM"), el("span", "pn-detect-detected"));
  const detectedBpmEl = tempoHead.lastChild;
  const autoOctaveBadge = el("span", "pn-auto-badge");
  autoOctaveBadge.hidden = true;
  autoOctaveBadge.title = "Detection came back an octave out. Corrected against the target - click a number below to override.";
  tempoHead.appendChild(autoOctaveBadge);
  tempoBlock.appendChild(tempoHead);

  const bpmRow = el("div", "pn-detect-row");
  const bpmInput = el("input");
  bpmInput.type = "number";
  bpmInput.className = "slider-number pn-bpm-input";
  bpmInput.min = "1";
  bpmInput.step = "0.01";
  bpmInput.title = "The tempo this loop is treated as. Correct it if detection got it wrong.";
  bpmInput.addEventListener("change", () => onSourceChange({ bpm: bpmInput.value }));
  const bpmChips = el("div", "pn-interpret-chips");
  bpmRow.append(bpmInput, bpmChips);
  tempoBlock.appendChild(bpmRow);
  detection.appendChild(tempoBlock);

  const keyBlock = el("div", "pn-detect-block");
  const keyHead = el("div", "pn-detect-head");
  keyHead.append(el("span", "pn-detect-title", "Source key"), el("span", "pn-detect-detected"));
  const detectedKeyEl = keyHead.lastChild;
  keyBlock.appendChild(keyHead);

  const keyRow = el("div", "pn-detect-row");
  const keySelect = el("select", "pn-key-select");
  for (const note of NOTE_NAMES) {
    const opt = document.createElement("option");
    opt.value = note;
    opt.textContent = FLAT_NAMES[note] ? `${note}/${FLAT_NAMES[note]}` : note;
    keySelect.appendChild(opt);
  }
  keySelect.addEventListener("change", () => onSourceChange({ key: keySelect.value }));
  const keyModeSelect = el("select", "pn-key-mode-select");
  for (const [value, label] of [
    ["major", "major"],
    ["minor", "minor"],
  ]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    keyModeSelect.appendChild(opt);
  }
  keyModeSelect.addEventListener("change", () => onSourceChange({ mode: keyModeSelect.value }));

  // Percussion, noise and atonal material have no key worth matching. Per-loop, so it
  // survives the rest of the batch having pitch fitting on.
  const atonal = el("label", "checkbox pn-atonal");
  const atonalCheckbox = el("input");
  atonalCheckbox.type = "checkbox";
  atonalCheckbox.addEventListener("change", () => onSourceChange({ keyDisabled: atonalCheckbox.checked }));
  atonal.append(atonalCheckbox, el("span", null, "No key"));
  atonal.title = "Percussion, noise or anything atonal - skip key matching for this one.";

  keyRow.append(keySelect, keyModeSelect, atonal);
  keyBlock.appendChild(keyRow);
  detection.appendChild(keyBlock);

  const readouts = el("div", "pn-readouts");
  body.appendChild(readouts);

  const warnings = el("div", "pn-warnings");
  body.appendChild(warnings);

  // ---- audition: one player, two sources ----
  const ab = el("div", "pn-ab");
  const abHead = el("div", "pn-ab-head");
  const abSeg = el("div", "seg pn-ab-seg");
  abSeg.setAttribute("role", "group");
  abSeg.setAttribute("aria-label", "Which version to audition");
  const abButtons = {};
  for (const [value, label] of [
    ["original", "Original"],
    ["conformed", "Conformed"],
  ]) {
    const btn = el("button", "seg-btn", label);
    btn.type = "button";
    btn.addEventListener("click", () => setAuditionSource(value));
    abButtons[value] = btn;
    abSeg.appendChild(btn);
  }
  const abNote = el("span", "pn-ab-note");
  abHead.append(abSeg, abNote);
  ab.appendChild(abHead);
  const waveHost = el("div", "pn-ab-wave");
  ab.appendChild(waveHost);
  body.appendChild(ab);

  // ---- secondary actions, out of accidental reach ----
  const actions = el("div", "pn-card-body-actions");
  const referenceBtn = el("button", "btn btn--small", "Use as reference");
  referenceBtn.type = "button";
  referenceBtn.title = "Detect this loop's tempo and key and make them the target for everything else.";
  referenceBtn.addEventListener("click", onUseAsReference);
  const processBtn = el("button", "btn btn--small", "Re-process");
  processBtn.type = "button";
  processBtn.title = "Render this loop's conformed version again.";
  processBtn.addEventListener("click", onPreview);
  const exportBtn = el("button", "btn btn--small", "Export");
  exportBtn.type = "button";
  exportBtn.addEventListener("click", onExport);
  const removeBtn = el("button", "btn btn--ghost btn--small pn-remove", "Remove");
  removeBtn.type = "button";
  removeBtn.addEventListener("click", onRemove);
  actions.append(referenceBtn, processBtn, exportBtn, removeBtn);
  body.appendChild(actions);

  // =========================================================================

  let wave = null;
  let lastView = null; // so expanding can populate the body without waiting for the next render
  let auditionSource = "conformed";
  let audio = { original: null, conformed: null };

  function currentAudio() {
    return auditionSource === "conformed" ? audio.conformed || audio.original : audio.original;
  }

  function syncWave() {
    const next = currentAudio();
    if (!next) {
      if (wave) {
        wave.destroy();
        wave = null;
        waveHost.replaceChildren();
      }
      return;
    }
    if (!wave) {
      wave = createPreviewWaveform({
        mono: next.mono,
        sampleRate: next.sampleRate,
        duration: next.duration,
        color,
        getAudioContext,
        onPlayStateChange: (isPlaying) => {
          if (isPlaying) onSoloPlay();
        },
      });
      waveHost.appendChild(wave.el);
    } else {
      wave.setAudio(next);
    }
  }

  function setAuditionSource(next) {
    if (auditionSource === next) return;
    auditionSource = next;
    for (const [value, btn] of Object.entries(abButtons)) btn.classList.toggle("is-active", auditionSource === value);
    syncWave();
  }

  function setExpanded(next) {
    expanded = !!next;
    card.classList.toggle("is-expanded", expanded);
    body.hidden = !expanded;
    toggleBtn.textContent = expanded ? "▾" : "▸";
    toggleBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    if (expanded) {
      // The body is only populated by render(), which skips it while collapsed - so
      // without this an expanded card shows its shell and none of its numbers until
      // something else happens to trigger a render.
      if (lastView) api.render(lastView);
      syncWave();
    } else if (wave) {
      wave.stop();
    }
    onExpandedChange(expanded);
  }

  function readout(label, value, extraClass) {
    const line = el("div", `field-readout pn-readout${extraClass ? ` ${extraClass}` : ""}`);
    line.append(el("span", null, label), el("strong", null, value));
    return line;
  }

  /** "+4 st → A minor" when Match scale sent the loop to the target's relative key. */
  function pitchText(pitch) {
    if (!pitch.applied) return pitch.reason || "no change";
    const shift = formatSemitones(pitch.semitones);
    return pitch.relativeUsed && pitch.resultKey ? `${shift} → ${formatKey(pitch.resultKey, pitch.resultMode)}` : shift;
  }

  function renderChips(view) {
    const options = tempoInterpretations(view.detectedBpm);
    bpmChips.replaceChildren();
    if (options.length < 2) return;
    for (const value of options) {
      const chip = el("button", "pn-chip", String(value));
      chip.type = "button";
      chip.classList.toggle("is-active", Math.abs(value - (view.sourceBpm || 0)) < 0.51);
      chip.addEventListener("click", () => onSourceChange({ bpm: value }));
      bpmChips.appendChild(chip);
    }
  }

  const api = {
    element: card,
    isExpanded: () => expanded,
    setExpanded,

    setOriginalAudio(next) {
      audio.original = next;
      if (expanded) syncWave();
    },

    setConformedAudio(next) {
      audio.conformed = next;
      if (expanded && auditionSource === "conformed") syncWave();
    },

    stopPlayback() {
      if (wave) wave.stop();
    },

    destroy() {
      if (wave) wave.destroy();
      card.remove();
    },

    /** Refresh everything except the waveform, from the item's current state + plan. */
    render(view) {
      lastView = view;
      card.classList.toggle("is-busy", view.busy);
      card.classList.toggle("is-error", view.status === "error");
      card.classList.toggle("is-reference", !!view.isReference);
      card.classList.toggle("is-muted", !view.inMix);
      card.classList.toggle("is-soloed", !!view.soloed);

      referenceBadge.hidden = !view.isReference;
      status.textContent = view.statusText;
      status.className = `pn-card-status${view.status === "error" ? " is-error" : ""}${view.busy ? " is-busy" : ""}`;

      const ready = view.status === "ready";
      toggleBtn.disabled = !ready;
      methodSelect.disabled = !ready;
      soloBtn.disabled = !ready;
      muteBtn.disabled = !ready;
      for (const btn of [...Object.values(tempoFit.buttons), ...Object.values(pitchFit.buttons)]) btn.disabled = !ready;
      if (!ready) {
        summary.hidden = true;
        attention.hidden = true;
        if (expanded) setExpanded(false);
        return;
      }
      summary.hidden = false;

      rowAutoBadge.hidden = !view.autoOctave;
      fromEl.textContent = view.fromText;
      toEl.textContent = view.toText;
      noteEl.textContent = view.transformNote;
      noteEl.hidden = !view.transformNote;

      attention.hidden = !view.needsAttention;
      // Colour alone can't carry this - the dot needs to say what it means out loud.
      attention.setAttribute("aria-label", view.needsAttention ? `Needs a look: ${view.attentionReason}` : "");

      if (!feelSelect.options.length) {
        for (const feel of view.timeFeels) {
          const opt = document.createElement("option");
          opt.value = feel.key;
          opt.textContent = feel.short;
          opt.title = `${feel.label} - ${feel.description}`;
          feelSelect.appendChild(opt);
        }
      }
      feelSelect.value = view.timeFeel;
      feelSelect.classList.toggle("is-overridden", view.timeFeel !== "normal");
      feelSelect.disabled = !ready;

      inheritOption.textContent = `Follow session (${view.sessionMethodLabel})`;
      methodSelect.value = view.method;
      methodSelect.classList.toggle("is-overridden", view.method !== METHOD_INHERIT);

      for (const [value, btn] of Object.entries(tempoFit.buttons)) btn.classList.toggle("is-active", String(view.tempoFit) === value);
      for (const [value, btn] of Object.entries(pitchFit.buttons)) btn.classList.toggle("is-active", String(view.pitchFit) === value);

      soloBtn.classList.toggle("is-active", !!view.soloed);
      soloBtn.setAttribute("aria-pressed", view.soloed ? "true" : "false");
      muteBtn.classList.toggle("is-active", !view.inMix);
      muteBtn.setAttribute("aria-pressed", view.inMix ? "false" : "true");

      if (!expanded) return;

      // ---- body ----
      const reasons = view.attentionReasons || [];
      attentionBlock.hidden = reasons.length === 0;
      attentionList.replaceChildren(...reasons.map((r) => el("li", null, r)));

      detectedBpmEl.textContent = view.detectedBpmText;
      autoOctaveBadge.hidden = !view.autoOctave;
      if (view.autoOctave) autoOctaveBadge.textContent = `auto → ${Math.round(view.sourceBpm)}`;
      if (document.activeElement !== bpmInput) bpmInput.value = view.sourceBpm != null ? String(Math.round(view.sourceBpm * 100) / 100) : "";
      bpmInput.classList.toggle("is-overridden", view.bpmIsManual);
      renderChips(view);

      detectedKeyEl.textContent = view.detectedKeyText;
      keySelect.value = view.sourceKey || "C";
      keyModeSelect.value = view.sourceMode || "major";
      atonalCheckbox.checked = !!view.keyDisabled;
      keySelect.disabled = !!view.keyDisabled;
      keyModeSelect.disabled = !!view.keyDisabled;
      keySelect.classList.toggle("is-overridden", view.keyIsManual);
      keyModeSelect.classList.toggle("is-overridden", view.keyIsManual);

      const plan = view.plan;
      const lines = [
        readout("Tempo", plan.tempo.applied ? `${formatRatio(plan.tempo.ratio)} · ${formatTempoChange(plan.tempo.ratio)}` : plan.tempo.reason || "no change", plan.tempo.applied ? "is-active" : null),
        readout("Loop", plan.tempo.snapped ? `${plan.tempo.snappedBeats} beats · ${plan.tempo.sourceBpm.toFixed(2)} BPM` : "not snapped"),
        readout("Pitch", pitchText(plan.pitch), plan.pitch.applied ? "is-active" : null),
        readout("Length", view.predictedDurationText),
      ];
      if (view.timeFeelText) lines.push(readout("Feel", view.timeFeelText, "is-active"));
      if (view.levelText) lines.push(readout("Level", view.levelText));
      if (view.percussive) lines.push(readout("Content", "looks like percussion"));
      const align = view.alignment;
      if (align) {
        const ratio = plan.tempo.applied ? plan.tempo.ratio : 1;
        const total = (align.source && align.source.applied ? align.source.offsetMs * ratio : 0) + (align.output && align.output.applied ? align.output.offsetMs : 0);
        const src = align.source;
        if (Math.abs(total) >= 0.1) lines.push(readout("Grid", `nudged ${total > 0 ? "-" : "+"}${Math.abs(total).toFixed(1)} ms`));
        else if (src && src.found && !src.confident) lines.push(readout("Grid", "no clear beat - left as-is"));
      }
      readouts.replaceChildren(...lines);

      abNote.textContent = view.conformedNote;
      for (const [value, btn] of Object.entries(abButtons)) btn.classList.toggle("is-active", auditionSource === value);
      abButtons.conformed.disabled = !view.hasConformed;
      if (!view.hasConformed && auditionSource === "conformed") setAuditionSource("original");

      warnings.replaceChildren();
      for (const warning of plan.warnings) {
        warnings.appendChild(el("p", `pn-warning pn-warning--${warning.code}`, warning.text));
      }
      const outAlign = align && align.output;
      if (outAlign && outAlign.found && outAlign.confident && !outAlign.converged) {
        warnings.appendChild(
          el("p", "pn-warning pn-warning--loose", `${plan.method.label} left this about ${Math.abs(outAlign.residualMs).toFixed(0)} ms off the grid - it won't sit tightly. Try Transient or Punch if you want it locked.`)
        );
      }
      if (view.renderError) warnings.appendChild(el("p", "pn-warning is-error", view.renderError));
    },
  };

  return api;
}

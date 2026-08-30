// stretch-workspace.js
//
// The STRETCH task's central workspace: a compact file strip, an Original vs. Processed A/B
// audition pane (built on preview-waveform.js), and a character browser (a grid of cards grouped by
// sonic family, reading straight from the DSP's own character registry, plus a focused macro-control
// panel for whichever character is selected). app.js owns all real state (timestretchSettings,
// analysisCache, the batch pipeline) - this module is a renderer + interaction surface over it, the
// same relationship editor-waveform.js has with the chop-editor card it's mounted inside.
//
// Deliberately split into several small `setX`/`renderX` methods rather than one big
// `render(viewModel)`: dragging a macro slider must be cheap (update a number, nothing else) and
// must NOT tear down and rebuild the Original/Processed waveforms - that would both look janky and
// silently kill any audio currently playing. Only an actual character switch, file switch, or a
// fresh Process result rebuilds the parts of the DOM that need it.
import { characterGroups, MACROS } from "./dsp/stretch/characters.js";
import { createPreviewWaveform } from "./preview-waveform.js";

function fmtSeconds(s) {
  return `${s.toFixed(1)}s`;
}

export function createStretchWorkspace({ container, getAudioContext, color }) {
  const fileStrip = document.createElement("div");
  fileStrip.className = "stretch-file-strip";
  container.appendChild(fileStrip);

  const ab = document.createElement("div");
  ab.className = "stretch-ab";
  container.appendChild(ab);

  function makePane(kind, title) {
    const pane = document.createElement("section");
    pane.className = `stretch-pane stretch-pane--${kind}`;
    const head = document.createElement("div");
    head.className = "stretch-pane-head";
    const h = document.createElement("h3");
    h.textContent = title;
    const meta = document.createElement("span");
    meta.className = "stretch-pane-meta";
    head.append(h, meta);
    pane.appendChild(head);
    const staleBadge = document.createElement("p");
    staleBadge.className = "stretch-stale-badge";
    staleBadge.textContent = "Settings changed - press Process to update this preview";
    staleBadge.hidden = true;
    pane.appendChild(staleBadge);
    const waveHost = document.createElement("div");
    waveHost.className = "stretch-pane-wave";
    pane.appendChild(waveHost);
    ab.appendChild(pane);
    return { pane, meta, waveHost, staleBadge };
  }

  const originalPane = makePane("original", "Original");
  const processedPane = makePane("processed", "Processed");
  processedPane.pane.classList.add("stretch-pane--emphasis");

  const browser = document.createElement("div");
  browser.className = "stretch-character-browser";
  const browserHead = document.createElement("div");
  browserHead.className = "stretch-character-browser-head";
  const browserTitle = document.createElement("h3");
  browserTitle.textContent = "Character";
  browserHead.appendChild(browserTitle);
  browser.appendChild(browserHead);
  const groupsHost = document.createElement("div");
  groupsHost.className = "stretch-character-groups";
  browser.appendChild(groupsHost);
  const detailHost = document.createElement("div");
  detailHost.className = "stretch-character-detail";
  browser.appendChild(detailHost);
  container.appendChild(browser);

  let originalWave = null;
  let processedWave = null;
  let hasProcessedData = false; // tracks whether processedPane currently shows real audio (for setStale)

  function destroyWave(ref) {
    if (ref) ref.destroy();
  }

  /** items: [{key, fileName, processed:boolean}]; onSelect(key) fires on click. */
  function setFileList(items, activeKey, onSelect) {
    fileStrip.innerHTML = "";
    fileStrip.hidden = items.length <= 1;
    for (const item of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "stretch-file-chip" + (item.key === activeKey ? " is-active" : "");
      row.textContent = item.fileName;
      if (!item.processed) row.classList.add("is-unprocessed");
      row.title = item.processed ? item.fileName : `${item.fileName} - not processed yet`;
      row.addEventListener("click", () => onSelect(item.key));
      fileStrip.appendChild(row);
    }
  }

  /** data: null (nothing to show yet) or {mono, sampleRate, duration, bpmText, keyText}. */
  function setOriginal(data) {
    destroyWave(originalWave);
    originalWave = null;
    originalPane.waveHost.innerHTML = "";
    if (!data) {
      originalPane.meta.textContent = "";
      originalWave = createPreviewWaveform({ mono: null, sampleRate: 0, duration: 0, color, getAudioContext });
      originalPane.waveHost.appendChild(originalWave.el);
      return;
    }
    const bits = [data.bpmText, fmtSeconds(data.duration)].filter(Boolean);
    originalPane.meta.textContent = bits.join(" · ");
    originalWave = createPreviewWaveform({ mono: data.mono, sampleRate: data.sampleRate, duration: data.duration, color, getAudioContext });
    originalPane.waveHost.appendChild(originalWave.el);
  }

  /** data: null, or {mono, sampleRate, duration, characterLabel, ratio}. */
  function setProcessed(data, isStale) {
    destroyWave(processedWave);
    processedWave = null;
    processedPane.waveHost.innerHTML = "";
    if (!data) {
      hasProcessedData = false;
      processedPane.meta.textContent = "";
      processedPane.staleBadge.hidden = true;
      processedWave = createPreviewWaveform({ mono: null, sampleRate: 0, duration: 0, color, getAudioContext });
      processedPane.waveHost.appendChild(processedWave.el);
      return;
    }
    hasProcessedData = true;
    const bits = [data.characterLabel, `${data.ratio.toFixed(2)}x`, fmtSeconds(data.duration)].filter(Boolean);
    processedPane.meta.textContent = bits.join(" · ");
    processedPane.staleBadge.hidden = !isStale;
    processedPane.pane.classList.toggle("is-stale", !!isStale);
    processedWave = createPreviewWaveform({ mono: data.mono, sampleRate: data.sampleRate, duration: data.duration, color, getAudioContext });
    processedPane.waveHost.appendChild(processedWave.el);
  }

  /** Cheap: just the stale badge/border, no waveform rebuild - safe to call on every settings tweak. */
  function setStale(isStale) {
    processedPane.staleBadge.hidden = !isStale || !hasProcessedData;
    processedPane.pane.classList.toggle("is-stale", !!isStale && hasProcessedData);
  }

  /**
   * opts: { characterKey, macroValues, seed, onSelectCharacter(key), onMacroChange(key,value),
   * onSeedChange(value), onRandomise() }
   */
  function renderCharacterBrowser(opts) {
    groupsHost.innerHTML = "";
    for (const group of characterGroups()) {
      if (!group.characters.length) continue;
      const section = document.createElement("div");
      section.className = "stretch-character-group";
      const h = document.createElement("h4");
      h.textContent = group.label;
      section.appendChild(h);
      const grid = document.createElement("div");
      grid.className = "stretch-character-grid";
      for (const c of group.characters) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "stretch-character-card" + (c.key === opts.characterKey ? " is-active" : "");
        const label = document.createElement("span");
        label.className = "stretch-character-card-label";
        label.textContent = c.label;
        const desc = document.createElement("span");
        desc.className = "stretch-character-card-desc";
        desc.textContent = c.description;
        card.append(label, desc);
        card.title = c.description;
        card.addEventListener("click", () => opts.onSelectCharacter(c.key));
        grid.appendChild(card);
      }
      section.appendChild(grid);
      groupsHost.appendChild(section);
    }

    renderCharacterDetail(opts);
  }

  function renderCharacterDetail(opts) {
    detailHost.innerHTML = "";
    const character = characterGroups()
      .flatMap((g) => g.characters)
      .find((c) => c.key === opts.characterKey);
    if (!character) return;

    const head = document.createElement("div");
    head.className = "stretch-character-detail-head";
    const name = document.createElement("strong");
    name.textContent = character.label;
    const desc = document.createElement("span");
    desc.textContent = character.description;
    head.append(name, desc);
    detailHost.appendChild(head);

    const macroKeys = character.macros || [];
    if (macroKeys.length) {
      const macroGrid = document.createElement("div");
      macroGrid.className = "stretch-macro-grid";
      for (const key of macroKeys) {
        const meta = MACROS[key];
        const row = document.createElement("div");
        row.className = "field";
        const label = document.createElement("label");
        label.textContent = meta.label;
        const sliderRow = document.createElement("div");
        sliderRow.className = "slider-row";
        const slider = document.createElement("input");
        slider.type = "range";
        slider.min = "0";
        slider.max = "100";
        slider.step = "1";
        const value = opts.macroValues && typeof opts.macroValues[key] === "number" ? opts.macroValues[key] : meta.default;
        slider.value = String(value);
        const number = document.createElement("input");
        number.type = "number";
        number.className = "slider-number";
        number.min = "0";
        number.max = "100";
        number.step = "1";
        number.value = String(value);
        const unit = document.createElement("span");
        unit.className = "slider-unit";
        unit.textContent = "%";
        slider.addEventListener("input", () => {
          number.value = slider.value;
          opts.onMacroChange(key, Number(slider.value));
        });
        number.addEventListener("change", () => {
          let v = Number(number.value);
          if (!Number.isFinite(v)) v = Number(slider.value);
          v = Math.min(100, Math.max(0, Math.round(v)));
          number.value = String(v);
          slider.value = String(v);
          opts.onMacroChange(key, v);
        });
        sliderRow.append(slider, number, unit);
        const hint = document.createElement("p");
        hint.className = "mod-note";
        hint.textContent = meta.hint || "";
        row.append(label, sliderRow, hint);
        macroGrid.appendChild(row);
      }
      detailHost.appendChild(macroGrid);
    }

    const footRow = document.createElement("div");
    footRow.className = "stretch-character-detail-foot";
    if (character.usesSeed) {
      const seedField = document.createElement("div");
      seedField.className = "field field--inline";
      const seedLabel = document.createElement("label");
      seedLabel.textContent = "Seed";
      const seedInput = document.createElement("input");
      seedInput.type = "number";
      seedInput.min = "0";
      seedInput.max = "999999";
      seedInput.step = "1";
      seedInput.value = String(opts.seed ?? 1);
      seedInput.addEventListener("change", () => {
        const v = Math.max(0, Math.round(Number(seedInput.value) || 0));
        seedInput.value = String(v);
        opts.onSeedChange(v);
      });
      seedField.append(seedLabel, seedInput);
      footRow.appendChild(seedField);
    }
    if (macroKeys.length || character.usesSeed) {
      const randomiseBtn = document.createElement("button");
      randomiseBtn.type = "button";
      randomiseBtn.className = "btn btn--ghost btn--small";
      randomiseBtn.textContent = "Randomise";
      randomiseBtn.title = "Randomise this character's creative controls (and seed, if it has one).";
      randomiseBtn.addEventListener("click", () => opts.onRandomise());
      footRow.appendChild(randomiseBtn);
    }
    if (footRow.childElementCount) detailHost.appendChild(footRow);

    if (character.preservesPitch === false) {
      const note = document.createElement("p");
      note.className = "mod-note";
      note.textContent = "Pitch follows speed with this character - stretching also changes pitch, like tape or varispeed.";
      detailHost.appendChild(note);
    }
  }

  function stopAllPlayback() {
    if (originalWave) originalWave.stop();
    if (processedWave) processedWave.stop();
  }

  function destroy() {
    destroyWave(originalWave);
    destroyWave(processedWave);
    container.innerHTML = "";
  }

  return { el: container, setFileList, setOriginal, setProcessed, setStale, renderCharacterBrowser, stopAllPlayback, destroy };
}

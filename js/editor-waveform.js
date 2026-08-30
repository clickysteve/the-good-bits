// editor-waveform.js
//
// The interactive waveform. This is no longer an "edit mode" you enter: every processed file shows
// one of these directly, so zooming, auditioning and adjusting a cut are all one click away rather
// than three. Everything it does works on the in-memory mono downmix, so nothing here re-processes
// or writes files - the owning card decides when to Apply.
//
// Two things worth knowing about the model:
//
//   * Boundaries, not independent regions. Chops from a break are contiguous, so the end of one is
//     physically the same edge as the start of the next. Drawing and dragging them as two separate
//     handles stacked on top of each other made it look like a drag hadn't worked. Coincident
//     edges are detected and dragged as one SHARED boundary that moves both slices at once. Phrase
//     mode genuinely does leave gaps between slices, so non-adjacent edges stay independent and
//     are drawn with a direction flag so you can tell a start from an end.
//
//   * Selection is the link to the list below. Selecting a slice here highlights its row in the
//     card, which is what makes "delete slice 6" possible without counting.

import { findNearestZeroCrossing, computePeaksInRange } from "./dsp.js";
import { addOrSplitRegionAt } from "./chop-regions.js";

/** Two boundaries closer than this are treated as the same edge. */
const SHARED_EPS_SEC = 0.006;
const MIN_SLICE_SEC = 0.03;

export function formatEditorTime(t) {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2);
  return m > 0 ? `${m}:${s.padStart(5, "0")}` : `${s}s`;
}

/** Waveform-canvas X (px, relative to the canvas) -> file time, given the current zoom/pan. Pulled
 * out as a pure function so the double-click-to-split gesture's time conversion is testable without
 * a canvas. */
export function viewXToTime(xRel, width, viewStart, viewDuration) {
  return width > 0 ? viewStart + (xRel / width) * viewDuration : viewStart;
}

/**
 * @param {object} opts
 * @param {Float32Array} opts.mono          in-memory downmix, used for drawing, snapping and audition
 * @param {number} opts.sampleRate
 * @param {number} opts.duration
 * @param {[number,number][]} opts.initialRegions
 * @param {string} opts.noun                "chop" or "one-shot", for labels and empty states
 * @param {number} opts.zcSearchMs          zero-crossing snap window, from export settings
 * @param {(name:string,fallback:string)=>string} opts.color  reads a CSS custom property
 * @param {()=>void} opts.onChange          fired whenever the slice list changes
 * @param {(idx:number|null)=>void} opts.onSelect
 * @param {()=>void} [opts.onUndo]          fired by the Undo button or Cmd/Ctrl+Z - the canonical
 *   undo/redo stack lives in the caller (app.js keys it per file in analysisCache), not here, since
 *   an editor instance gets torn down and rebuilt on every Process/mode-switch while that history
 *   needs to survive
 * @param {()=>void} [opts.onRedo]          fired by the Redo button or Cmd/Ctrl+Shift+Z / Ctrl+Y
 */
export function createEditableWaveform({
  mono,
  sampleRate,
  duration,
  initialRegions,
  noun = "chop",
  zcSearchMs = 15,
  color = (_n, f) => f,
  onChange = () => {},
  onSelect = () => {},
  onUndo = () => {},
  onRedo = () => {},
}) {
  const wrap = document.createElement("div");
  wrap.className = "editable-waveform";
  wrap.tabIndex = 0; // so the canvas can take keyboard focus for Delete

  const toolbar = document.createElement("div");
  toolbar.className = "editable-waveform-toolbar";

  const mkBtn = (text, title) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn btn--ghost btn--small";
    b.textContent = text;
    if (title) b.title = title;
    return b;
  };

  const playBtn = mkBtn("▶ Play", `Play the selected ${noun} (Space)`);
  const stopBtn = mkBtn("■ Stop", "Stop playback (Esc)");
  const loopBtn = mkBtn("↺ Loop", "Loop the selected slice");
  loopBtn.classList.add("btn--loop");
  const addBtn = mkBtn("+ Add", `Add a ${noun} (or double-click anywhere on the waveform to start a new slice there)`);
  const deleteBtn = mkBtn("Delete", `Delete the selected ${noun} (Delete)`);
  const undoBtn = mkBtn("↶ Undo", "Undo the last edit (Cmd/Ctrl+Z)");
  undoBtn.disabled = true;
  const redoBtn = mkBtn("↷ Redo", "Redo (Cmd/Ctrl+Shift+Z, or Ctrl+Y)");
  redoBtn.disabled = true;
  const zoomOutBtn = mkBtn("−", "Zoom out");
  const zoomInBtn = mkBtn("+", "Zoom in");
  const fitBtn = mkBtn("Fit", "Zoom to fit");
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "editable-waveform-zoom-label";
  toolbar.append(playBtn, stopBtn, loopBtn, addBtn, deleteBtn, undoBtn, redoBtn, zoomOutBtn, zoomInBtn, fitBtn, zoomLabel);
  wrap.appendChild(toolbar);

  const canvas = document.createElement("canvas");
  canvas.className = "waveform-canvas waveform-canvas--editable";
  wrap.appendChild(canvas);

  const hint = document.createElement("p");
  hint.className = "editable-waveform-hint";
  wrap.appendChild(hint);

  const slices = initialRegions.map(([s, e]) => ({ s, e }));
  let selected = null;

  const MIN_VIEW_SEC = Math.min(Math.max(duration, 0.001), 0.25);
  const BIN_COUNT = 600;
  let viewStart = 0;
  let viewDuration = Math.max(duration, MIN_VIEW_SEC);
  let dragging = null;
  let playhead = null; // seconds, while auditioning

  const xToTime = (xRel, w) => viewXToTime(xRel, w, viewStart, viewDuration);
  const timeToX = (t, w) => (viewDuration > 0 ? ((t - viewStart) / viewDuration) * w : 0);

  function setView(newStart, newDuration) {
    viewDuration = Math.max(MIN_VIEW_SEC, Math.min(duration, newDuration));
    viewStart = Math.max(0, Math.min(Math.max(0, duration - viewDuration), newStart));
    redraw();
  }

  function zoomAt(anchorTime, factor) {
    const requestedDuration = viewDuration / factor;
    const clampedDuration = Math.max(MIN_VIEW_SEC, Math.min(duration, requestedDuration));
    if (clampedDuration === viewDuration) return;
    const ratio = viewDuration > 0 ? (anchorTime - viewStart) / viewDuration : 0.5;
    setView(anchorTime - ratio * clampedDuration, clampedDuration);
  }

  function snap(t) {
    if (!mono || !sampleRate) return t;
    const win = Math.max(1, Math.round((zcSearchMs / 1000) * sampleRate));
    return findNearestZeroCrossing(mono, Math.round(t * sampleRate), win) / sampleRate;
  }

  /**
   * Every distinct edge in the file, with the slices that own it. Two edges within SHARED_EPS_SEC
   * collapse into one entry holding both owners, which is what makes a shared boundary drag as a
   * single thing.
   */
  function boundaries() {
    const pts = [];
    slices.forEach((r, idx) => {
      pts.push({ t: r.s, refs: [{ idx, which: "s" }] });
      pts.push({ t: r.e, refs: [{ idx, which: "e" }] });
    });
    pts.sort((a, b) => a.t - b.t);
    const merged = [];
    for (const p of pts) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(last.t - p.t) <= SHARED_EPS_SEC) last.refs.push(...p.refs);
      else merged.push({ t: p.t, refs: [...p.refs] });
    }
    return merged;
  }

  function redraw() {
    const rectWidth = Math.max(200, Math.round(canvas.getBoundingClientRect().width || 600));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssH = 108;
    canvas.width = Math.round(rectWidth * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rectWidth;
    const h = cssH;
    const mid = h / 2;
    ctx.clearRect(0, 0, w, h);

    if (duration <= 0) {
      zoomLabel.textContent = "";
      return;
    }

    // selected slice gets a tinted bed so it's obvious which one the buttons act on
    if (selected != null && slices[selected]) {
      const r = slices[selected];
      const x0 = Math.max(0, timeToX(r.s, w));
      const x1 = Math.min(w, timeToX(r.e, w));
      if (x1 > x0) {
        ctx.fillStyle = color("--wave-region-sel", "rgba(255, 75, 59, 0.16)");
        ctx.fillRect(x0, 0, x1 - x0, h);
      }
    }

    const peaks = mono ? computePeaksInRange(mono, viewStart * sampleRate, (viewStart + viewDuration) * sampleRate, BIN_COUNT) : null;
    if (peaks) {
      const barWidth = w / peaks.length;
      ctx.fillStyle = color("--wave-fill", "#5b6670");
      for (let i = 0; i < peaks.length; i++) {
        const amp = Math.max(1, peaks[i] * (h * 0.42));
        ctx.fillRect(i * barWidth, mid - amp, Math.max(1, barWidth - 0.4), amp * 2);
      }
    }

    // Boundaries. Bolder than they were, and shaped: a shared edge gets a diamond, a lone start
    // flags right (into its slice), a lone end flags left. Previously every edge was an identical
    // thin line, so a start sitting on top of the previous end looked like one marker that hadn't
    // moved when you dragged it.
    const markerColor = color("--wave-marker", "#ff4b3b");
    const selColor = color("--wave-handle", "#eceef1");
    for (const b of boundaries()) {
      const x = timeToX(b.t, w);
      if (x < -10 || x > w + 10) continue;
      const touchesSelected = selected != null && b.refs.some((r) => r.idx === selected);
      const isShared = b.refs.length > 1;
      ctx.strokeStyle = touchesSelected ? selColor : markerColor;
      ctx.fillStyle = touchesSelected ? selColor : markerColor;
      ctx.lineWidth = touchesSelected ? 2.5 : 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();

      const capY = 7;
      ctx.beginPath();
      if (isShared) {
        ctx.moveTo(x, capY - 6);
        ctx.lineTo(x + 6, capY);
        ctx.lineTo(x, capY + 6);
        ctx.lineTo(x - 6, capY);
      } else if (b.refs[0].which === "s") {
        ctx.moveTo(x, capY - 6);
        ctx.lineTo(x + 9, capY);
        ctx.lineTo(x, capY + 6);
      } else {
        ctx.moveTo(x, capY - 6);
        ctx.lineTo(x - 9, capY);
        ctx.lineTo(x, capY + 6);
      }
      ctx.closePath();
      ctx.fill();
    }

    // slice numbers, so the waveform and the list below can be matched by eye
    ctx.font = "500 10px ui-monospace, Menlo, monospace";
    ctx.textBaseline = "bottom";
    slices.forEach((r, idx) => {
      const x0 = timeToX(r.s, w);
      const x1 = timeToX(r.e, w);
      if (x1 < 0 || x0 > w) return;
      const label = String(idx + 1).padStart(2, "0");
      ctx.fillStyle = idx === selected ? selColor : color("--text-faint", "#8a929a");
      ctx.fillText(label, Math.max(3, x0 + 4), h - 3);
    });

    if (playhead != null) {
      const x = timeToX(playhead, w);
      if (x >= 0 && x <= w) {
        ctx.strokeStyle = color("--wave-handle", "#eceef1");
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }

    const zoomX = viewDuration > 0 ? (duration / viewDuration).toFixed(1) : "1.0";
    zoomLabel.textContent = `${zoomX}x · ${formatEditorTime(viewStart)} to ${formatEditorTime(viewStart + viewDuration)}`;
    zoomOutBtn.disabled = viewDuration >= duration - 1e-6;
    zoomInBtn.disabled = viewDuration <= MIN_VIEW_SEC + 1e-6;
    fitBtn.disabled = zoomOutBtn.disabled;
    deleteBtn.disabled = selected == null;
    playBtn.disabled = selected == null;
    hint.textContent =
      selected == null
        ? `${slices.length} ${noun}${slices.length === 1 ? "" : "s"} · click one to select, double-click to add/split, scroll to zoom`
        : `${noun} ${String(selected + 1).padStart(2, "0")} selected · ${formatEditorTime(slices[selected].s)} to ${formatEditorTime(
            slices[selected].e
          )} · Space plays, Delete removes`;
  }

  // ---- audition -------------------------------------------------------------
  //
  // The playing source is built once per Play from a single persistent buffer covering the WHOLE
  // file, started at an absolute offset into it - never a small per-slice copy. That's what lets a
  // boundary drag update the audition in place: loopStart/loopEnd are plain attributes the audio
  // thread re-reads continuously, so mutating them live-retargets a playing loop with no stop/start
  // at all, and a non-looping pass is bounded by a *scheduled* stop() that can be rescheduled (or
  // brought forward to "now") as often as the current end boundary changes. Recreating the source on
  // every boundary edit was tried and produces audible stutter; this never recreates it mid-play.

  let audioCtx = null;
  let fullBuffer = null; // one AudioBuffer over the whole `mono` array, built once and reused
  let currentSource = null;
  let rafId = 0;
  let loopEnabled = false;
  let playingIdx = null; // index of the slice currentSource is auditioning
  let passAnchorTime = 0; // audioCtx.currentTime at which file playback was at passAnchorFilePos
  let passAnchorFilePos = 0; // file-time position (seconds) at passAnchorTime

  function getFullBuffer() {
    if (!fullBuffer) {
      fullBuffer = audioCtx.createBuffer(1, mono.length, sampleRate);
      fullBuffer.getChannelData(0).set(mono);
    }
    return fullBuffer;
  }

  /** Current playback position in file-time, derived from the pass anchor - no polling the node. */
  function currentFilePos() {
    return passAnchorFilePos + (audioCtx.currentTime - passAnchorTime);
  }

  function stopPlayback() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    if (currentSource) {
      try {
        currentSource.stop();
      } catch (_) {
        /* already stopped */
      }
      currentSource = null;
    }
    playingIdx = null;
    if (playhead != null) {
      playhead = null;
      redraw();
    }
    playBtn.classList.remove("is-playing");
  }

  /** Drives the visual playhead against the slice's LIVE bounds, re-anchoring on every wrap. */
  function startTick(src) {
    const tick = () => {
      if (currentSource !== src) return;
      const r = playingIdx != null ? slices[playingIdx] : null;
      if (!r) {
        stopPlayback();
        return;
      }
      const now = audioCtx.currentTime;
      let filePos = passAnchorFilePos + (now - passAnchorTime);
      if (src.loop) {
        const len = r.e - r.s;
        if (len > 0) {
          let rel = filePos - r.s;
          if (rel >= len || rel < 0) {
            rel = ((rel % len) + len) % len;
            passAnchorFilePos = r.s;
            passAnchorTime = now - rel;
          }
          filePos = r.s + rel;
        }
      } else if (filePos > r.e) {
        filePos = r.e; // native stop() is already scheduled for right about now
      }
      playhead = filePos;
      redraw();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function playSelected() {
    if (selected == null || !mono || !sampleRate) return;
    stopPlayback();
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    } catch (_) {
      return; // no Web Audio here; the button just does nothing rather than throwing
    }
    const idx = selected;
    const r = slices[idx];
    if (r.e <= r.s) return;
    const src = audioCtx.createBufferSource();
    src.buffer = getFullBuffer();
    src.connect(audioCtx.destination);
    if (loopEnabled) {
      src.loop = true;
      src.loopStart = r.s;
      src.loopEnd = r.e;
    }
    src.onended = () => {
      if (currentSource === src) stopPlayback();
    };
    const now = audioCtx.currentTime;
    src.start(now, r.s);
    if (!loopEnabled) src.stop(now + (r.e - r.s));
    currentSource = src;
    playingIdx = idx;
    passAnchorTime = now;
    passAnchorFilePos = r.s;
    playBtn.classList.add("is-playing");
    startTick(src);
  }

  /** True when a boundary drag on `refs` touches the slice currently loaded into currentSource. */
  function boundaryTouchesPlayingSlice(refs) {
    return playingIdx != null && refs.some((r) => r.idx === playingIdx);
  }

  /**
   * Re-targets the live audition after the selected+playing slice's bounds changed. Looping just
   * needs its native loop points nudged - the audio thread picks that up with no glitch. A
   * non-looping pass has no native notion of "the current end", so its scheduled stop is what we
   * move; if the new end already lies behind the live playback position, the pass is over now.
   */
  function applyLiveBoundaryUpdate() {
    if (playingIdx == null || !currentSource || selected !== playingIdx) return;
    const r = slices[playingIdx];
    if (currentSource.loop) {
      currentSource.loopStart = r.s;
      currentSource.loopEnd = r.e;
    } else {
      const remaining = r.e - currentFilePos();
      if (remaining <= 0) stopPlayback();
      else currentSource.stop(audioCtx.currentTime + remaining);
    }
  }

  // ---- mutation -------------------------------------------------------------

  function select(idx) {
    selected = idx;
    redraw();
    onSelect(idx);
  }

  function addSliceAt(centerTime) {
    const defaultLen = Math.min(Math.max(duration, MIN_SLICE_SEC), Math.max(0.05, viewDuration * 0.2));
    let s = Math.max(0, centerTime - defaultLen / 2);
    let e = Math.min(duration, centerTime + defaultLen / 2);
    s = snap(s);
    e = snap(e);
    if (e - s < MIN_SLICE_SEC) e = Math.min(duration, s + MIN_SLICE_SEC);
    if (e - s < MIN_SLICE_SEC) s = Math.max(0, e - MIN_SLICE_SEC);
    slices.push({ s, e });
    slices.sort((a, b) => a.s - b.s);
    select(slices.findIndex((r) => r.s === s && r.e === e));
    onChange();
  }

  function deleteSelected() {
    if (selected == null) return;
    slices.splice(selected, 1);
    select(slices.length ? Math.min(selected, slices.length - 1) : null);
    onChange();
  }

  /**
   * Double-click gesture: "I want a slice beginning here." Inside an existing canonical region, that
   * means splitting it in two, right at the click - never an arbitrary/overlapping region. In empty
   * waveform space (before the first region, in a gap, or after the last one), it means creating a
   * brand-new region starting at the click and running to whichever comes first: the next region's
   * start, or the end of the audio. The actual decision (and its refusal rules - too close to an
   * edge, a new region that would be shorter than the minimum) lives in addOrSplitRegionAt()
   * (chop-regions.js) so it's covered by the same unit tests without a canvas; this just supplies the
   * DOM-only bits (zero-crossing snap, selection, array<->slice-object shape).
   */
  function addOrSplitAt(clickTime) {
    if (!(duration > 0)) return;
    const t = Math.max(0, Math.min(duration, clickTime));
    const idx = sliceAtTime(t);
    let finalTime;
    if (idx != null) {
      const r = slices[idx];
      if (t - r.s < MIN_SLICE_SEC || r.e - t < MIN_SLICE_SEC) return;
      // Snapping to the nearest zero-crossing can walk the point back across the tolerance just
      // cleared above - clamp into the still-valid interior of the SAME containing slice rather than
      // either producing an invalid split or letting the snap silently pick a different one.
      finalTime = Math.max(r.s + MIN_SLICE_SEC, Math.min(r.e - MIN_SLICE_SEC, snap(t)));
    } else {
      // Empty space: the window available for a new region runs from the end of whichever region
      // precedes the click (0 if none) up to the start of whichever region follows it (the file's
      // own duration if none). slices is sorted by start and non-overlapping, so the last region
      // ending at/before t is the immediate predecessor, and the first starting after t is the
      // immediate successor.
      let precEnd = 0;
      for (const s of slices) if (s.e <= t) precEnd = s.e;
      const next = slices.find((s) => s.s > t);
      const nextStart = next ? next.s : duration;
      if (nextStart - t < MIN_SLICE_SEC) return;
      // Same clamp shape as the split branch above: never let the snap walk the new region's start
      // out of the empty space it's meant to occupy, in either direction.
      finalTime = Math.max(precEnd, Math.min(nextStart - MIN_SLICE_SEC, snap(t)));
    }
    const result = addOrSplitRegionAt(
      slices.map((sl) => [sl.s, sl.e]),
      finalTime,
      MIN_SLICE_SEC,
      duration
    );
    if (!result) return; // shouldn't happen given the clamps above, but never fabricate a bad region
    slices.length = 0;
    for (const [s, e] of result.regions) slices.push({ s, e });
    select(result.newIndex); // the new (or newly split) region, which starts at the click point
    onChange();
  }

  addBtn.addEventListener("click", () => addSliceAt(viewStart + viewDuration / 2));
  deleteBtn.addEventListener("click", deleteSelected);
  undoBtn.addEventListener("click", () => onUndo());
  redoBtn.addEventListener("click", () => onRedo());
  loopBtn.addEventListener("click", () => {
    loopEnabled = !loopEnabled;
    loopBtn.classList.toggle("is-active", loopEnabled);
    // Mutate the live source directly - toggling Loop must never restart playback.
    if (currentSource && playingIdx != null) {
      const r = slices[playingIdx];
      if (loopEnabled) {
        currentSource.loop = true;
        currentSource.loopStart = r.s;
        currentSource.loopEnd = r.e;
        // Going non-looping -> looping leaves behind the stop() scheduled for the old pass end;
        // push it far out since there's no way to un-schedule a stop() once one has been called.
        currentSource.stop(audioCtx.currentTime + 24 * 3600);
      } else {
        currentSource.loop = false;
        const remaining = slices[playingIdx].e - currentFilePos();
        if (remaining <= 0) stopPlayback();
        else currentSource.stop(audioCtx.currentTime + remaining);
      }
    }
  });

  playBtn.addEventListener("click", playSelected);
  stopBtn.addEventListener("click", stopPlayback);
  zoomInBtn.addEventListener("click", () => zoomAt(viewStart + viewDuration / 2, 1.6));
  zoomOutBtn.addEventListener("click", () => zoomAt(viewStart + viewDuration / 2, 1 / 1.6));
  fitBtn.addEventListener("click", () => setView(0, duration));

  wrap.addEventListener("keydown", (ev) => {
    // Conventional Undo/Redo. Scoped to `wrap` (only reachable once the waveform has keyboard focus,
    // same as Delete/Space/Arrow below) rather than a document-level listener, which is what keeps
    // this from firing while the user is typing in the BPM field, the naming token editor, or any
    // other text control elsewhere on the page - none of those live inside this element.
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && (ev.key === "z" || ev.key === "Z")) {
      ev.preventDefault();
      if (ev.shiftKey) onRedo();
      else onUndo();
      return;
    }
    if (ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey && (ev.key === "y" || ev.key === "Y")) {
      ev.preventDefault();
      onRedo();
      return;
    }
    if (ev.key === "Delete" || ev.key === "Backspace") {
      if (selected == null) return;
      ev.preventDefault();
      deleteSelected();
    } else if (ev.key === " ") {
      if (selected == null) return;
      ev.preventDefault();
      if (currentSource) stopPlayback();
      else playSelected();
    } else if (ev.key === "Escape") {
      if (currentSource) stopPlayback();
      else select(null);
    } else if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      if (!slices.length) return;
      ev.preventDefault();
      const step = ev.key === "ArrowRight" ? 1 : -1;
      const next = selected == null ? 0 : Math.max(0, Math.min(slices.length - 1, selected + step));
      select(next);
    }
  });

  // Zoom. The old 1.25 per notch meant a single trackpad flick went from the whole file to a few
  // milliseconds; deltaMode is normalised because a mouse wheel reports lines and a trackpad pixels.
  canvas.addEventListener(
    "wheel",
    (ev) => {
      if (!mono || duration <= 0) return;
      const rect = canvas.getBoundingClientRect();
      const anchorTime = xToTime(ev.clientX - rect.left, rect.width);
      const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? rect.height : 1;
      const deltaMag = (ev.deltaY * unit) ** 2 + (ev.deltaX * unit) ** 2;
      if (ev.deltaY !== 0 && (ev.deltaY * unit) ** 2 >= deltaMag * 0.5) {
        ev.preventDefault();
        const steps = Math.max(-4, Math.min(4, (ev.deltaY * unit) / 100));
        zoomAt(anchorTime, Math.pow(1.15, -steps));
      } else if (ev.deltaX !== 0 && (ev.deltaX * unit) ** 2 >= deltaMag * 0.5) {
        ev.preventDefault();
        const unitX = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? rect.height : 1;
        const panAmount = (ev.deltaX * unitX / rect.width) * viewDuration;
        setView(Math.max(0, Math.min(Math.max(0, duration - viewDuration), viewStart + panAmount)), viewDuration);
      }
    },
    { passive: false }
  );

  function hitBoundary(clientX) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0) return null;
    const tolerance = (9 / rect.width) * viewDuration;
    const t = xToTime(clientX - rect.left, rect.width);
    let best = null;
    let bestDist = tolerance;
    for (const b of boundaries()) {
      const d = Math.abs(b.t - t);
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    return best;
  }

  function sliceAtTime(t) {
    for (let i = 0; i < slices.length; i++) {
      if (t >= slices[i].s && t <= slices[i].e) return i;
    }
    return null;
  }

  canvas.addEventListener("dblclick", (ev) => {
    const rect = canvas.getBoundingClientRect();
    addOrSplitAt(xToTime(ev.clientX - rect.left, rect.width));
  });

  // A pointerdown can't yet know if it's a click or a drag, so it only remembers what a click
  // would do (select the boundary's start slice, or the slice under the pointer) in a "pending-*"
  // state. Movement past DRAG_THRESHOLD_PX upgrades it to a real "boundary"/"pan" drag, which never
  // touches selection - a drag edits or pans, it doesn't select.
  const DRAG_THRESHOLD_PX = 4;

  canvas.addEventListener("pointerdown", (ev) => {
    wrap.focus({ preventScroll: true });
    const rect = canvas.getBoundingClientRect();
    const t = xToTime(ev.clientX - rect.left, rect.width);
    const b = hitBoundary(ev.clientX);
    canvas.setPointerCapture(ev.pointerId);
    if (b) {
      dragging = { kind: "pending-boundary", refs: b.refs, startClientX: ev.clientX, startClientY: ev.clientY };
      return;
    }
    if (mono) {
      dragging = {
        kind: "pending-pan",
        startClientX: ev.clientX,
        startClientY: ev.clientY,
        startViewStart: viewStart,
        hitSlice: sliceAtTime(t),
      };
    } else {
      select(sliceAtTime(t));
    }
  });

  canvas.addEventListener("pointermove", (ev) => {
    const rect = canvas.getBoundingClientRect();
    if (!dragging) {
      canvas.style.cursor = hitBoundary(ev.clientX) ? "ew-resize" : (mono ? "grab" : "default");
      return;
    }
    if (dragging.kind === "pending-boundary" || dragging.kind === "pending-pan") {
      const dx = ev.clientX - dragging.startClientX;
      const dy = ev.clientY - dragging.startClientY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      canvas.classList.add("waveform-canvas--dragging");
      if (dragging.kind === "pending-boundary") {
        dragging = { kind: "boundary", refs: dragging.refs };
      } else {
        // An actual pan drag edits the view, not the selection - leave it exactly as it was.
        dragging = { kind: "pan", startClientX: dragging.startClientX, startViewStart: dragging.startViewStart };
      }
    }
    if (dragging.kind === "boundary") {
      moveBoundary(dragging.refs, xToTime(ev.clientX - rect.left, rect.width));
      redraw();
      if (boundaryTouchesPlayingSlice(dragging.refs)) applyLiveBoundaryUpdate();
    } else if (dragging.kind === "pan") {
      const dxPx = ev.clientX - dragging.startClientX;
      setView(dragging.startViewStart - (dxPx / Math.max(1, rect.width)) * viewDuration, viewDuration);
    }
  });

  /** Moves every slice edge sharing this boundary, clamped so no slice collapses. */
  function moveBoundary(refs, t) {
    let lo = 0;
    let hi = duration;
    for (const { idx, which } of refs) {
      const r = slices[idx];
      if (which === "s") hi = Math.min(hi, r.e - MIN_SLICE_SEC);
      else lo = Math.max(lo, r.s + MIN_SLICE_SEC);
    }
    const clamped = Math.max(lo, Math.min(hi, t));
    for (const { idx, which } of refs) slices[idx][which] = clamped;
    return clamped;
  }

  function endDrag() {
    if (!dragging) return;
    const kind = dragging.kind;
    if (kind === "pending-boundary") {
      // Never crossed the drag threshold: a click, which selects the region that starts here.
      const startRef = dragging.refs.find((r) => r.which === "s");
      select(startRef != null ? startRef.idx : dragging.refs[0].idx);
    } else if (kind === "pending-pan") {
      // Never crossed the drag threshold: a click on the waveform body.
      select(dragging.hitSlice != null ? dragging.hitSlice : null);
    } else if (kind === "boundary") {
      canvas.classList.remove("waveform-canvas--dragging");
      const refs = dragging.refs;
      const current = slices[refs[0].idx][refs[0].which];
      moveBoundary(refs, snap(current));
      slices.sort((a, b) => a.s - b.s);
      redraw();
      onChange();
      if (boundaryTouchesPlayingSlice(refs)) applyLiveBoundaryUpdate();
    } else if (kind === "pan") {
      canvas.classList.remove("waveform-canvas--dragging");
    }
    dragging = null;
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // redraw() sizes the canvas off canvas.getBoundingClientRect().width, which is 0 right now -
  // `wrap` isn't attached to the document yet; the caller (app.js) appends editor.el straight
  // after this function returns. That 0 falls back to a hardcoded 600px, so this first pass draws
  // for a 600px-wide buffer while CSS immediately stretches the canvas to its real (usually much
  // wider) container width, visually compressing every marker/label until something else happens
  // to call redraw() with the real size - which is why any interaction "fixes" it.
  //
  // A ResizeObserver on the canvas is the deterministic fix: it fires as soon as the canvas is
  // actually laid out (right after this returns and app.js attaches it) with its real size, and
  // again on every genuine size change afterwards (rail toggle, window resize, density change) -
  // a superset of the plain window "resize" listener this replaces, since a sidebar/rail toggle
  // changes this element's size without the window itself resizing.
  redraw();
  let resizeObserver = null;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => redraw());
    resizeObserver.observe(canvas);
  } else {
    window.addEventListener("resize", redraw);
  }

  return {
    el: wrap,
    getRegions: () => slices.map((r) => [r.s, r.e]),
    getSelected: () => selected,
    select,
    playSelected,
    stopPlayback,
    redraw,
    /**
     * Wholesale-replaces the slice list, e.g. after a re-chop. Programmatic, so it does NOT fire
     * onChange - the caller already knows what the new regions are and is responsible for updating
     * whatever it keeps in sync with edits (the caller decides whether this counts as a plain edit
     * or a new baseline).
     */
    setRegions: (newRegions) => {
      stopPlayback();
      slices.length = 0;
      for (const [s, e] of newRegions) slices.push({ s, e });
      slices.sort((a, b) => a.s - b.s);
      select(null);
      redraw();
    },
    /** Enables/disables the Undo/Redo buttons - the caller (app.js) owns the actual history and
     * calls this after every commit/undo/redo so the toolbar reflects it. */
    setHistoryState: (canUndoNow, canRedoNow) => {
      undoBtn.disabled = !canUndoNow;
      redoBtn.disabled = !canRedoNow;
    },
    destroy: () => {
      stopPlayback();
      if (resizeObserver) resizeObserver.disconnect();
      else window.removeEventListener("resize", redraw);
    },
  };
}

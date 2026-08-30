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

/** Two boundaries closer than this are treated as the same edge. */
const SHARED_EPS_SEC = 0.006;
const MIN_SLICE_SEC = 0.03;

export function formatEditorTime(t) {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2);
  return m > 0 ? `${m}:${s.padStart(5, "0")}` : `${s}s`;
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
  const addBtn = mkBtn("+ Add", `Add a ${noun} (or double-click the waveform)`);
  const deleteBtn = mkBtn("Delete", `Delete the selected ${noun} (Delete)`);
  const zoomOutBtn = mkBtn("−", "Zoom out");
  const zoomInBtn = mkBtn("+", "Zoom in");
  const fitBtn = mkBtn("Fit", "Zoom to fit");
  const zoomLabel = document.createElement("span");
  zoomLabel.className = "editable-waveform-zoom-label";
  toolbar.append(playBtn, stopBtn, addBtn, deleteBtn, zoomOutBtn, zoomInBtn, fitBtn, zoomLabel);
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

  const xToTime = (xRel, w) => (w > 0 ? viewStart + (xRel / w) * viewDuration : viewStart);
  const timeToX = (t, w) => (viewDuration > 0 ? ((t - viewStart) / viewDuration) * w : 0);

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
        ? `${slices.length} ${noun}${slices.length === 1 ? "" : "s"} · click one to select, double-click to add, scroll to zoom`
        : `${noun} ${String(selected + 1).padStart(2, "0")} selected · ${formatEditorTime(slices[selected].s)} to ${formatEditorTime(
            slices[selected].e
          )} · Space plays, Delete removes`;
  }

  // ---- audition -------------------------------------------------------------

  let audioCtx = null;
  let currentSource = null;
  let rafId = 0;

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
    if (playhead != null) {
      playhead = null;
      redraw();
    }
    playBtn.classList.remove("is-playing");
  }

  function playSelected() {
    if (selected == null || !mono || !sampleRate) return;
    const r = slices[selected];
    stopPlayback();
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    } catch (_) {
      return; // no Web Audio here; the button just does nothing rather than throwing
    }
    const a = Math.max(0, Math.round(r.s * sampleRate));
    const b = Math.min(mono.length, Math.round(r.e * sampleRate));
    if (b <= a) return;
    const buf = audioCtx.createBuffer(1, b - a, sampleRate);
    buf.getChannelData(0).set(mono.subarray(a, b));
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    const startedAt = audioCtx.currentTime;
    playBtn.classList.add("is-playing");
    src.onended = () => {
      if (currentSource === src) stopPlayback();
    };
    src.start();
    currentSource = src;

    const tick = () => {
      if (currentSource !== src) return;
      playhead = r.s + (audioCtx.currentTime - startedAt);
      if (playhead >= r.e) playhead = r.e;
      redraw();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
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

  addBtn.addEventListener("click", () => addSliceAt(viewStart + viewDuration / 2));
  deleteBtn.addEventListener("click", deleteSelected);
  playBtn.addEventListener("click", playSelected);
  stopBtn.addEventListener("click", stopPlayback);
  zoomInBtn.addEventListener("click", () => zoomAt(viewStart + viewDuration / 2, 1.6));
  zoomOutBtn.addEventListener("click", () => zoomAt(viewStart + viewDuration / 2, 1 / 1.6));
  fitBtn.addEventListener("click", () => setView(0, duration));

  wrap.addEventListener("keydown", (ev) => {
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
      ev.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const anchorTime = xToTime(ev.clientX - rect.left, rect.width);
      const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? rect.height : 1;
      const steps = Math.max(-4, Math.min(4, (ev.deltaY * unit) / 100));
      zoomAt(anchorTime, Math.pow(1.15, -steps));
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
    addSliceAt(xToTime(ev.clientX - rect.left, rect.width));
  });

  canvas.addEventListener("pointerdown", (ev) => {
    wrap.focus({ preventScroll: true });
    const rect = canvas.getBoundingClientRect();
    const t = xToTime(ev.clientX - rect.left, rect.width);
    const b = hitBoundary(ev.clientX);
    canvas.setPointerCapture(ev.pointerId);
    if (b) {
      dragging = { kind: "boundary", refs: b.refs };
      // selecting the slice this edge belongs to keeps the list highlight in step with the drag
      select(b.refs[0].idx);
      canvas.classList.add("waveform-canvas--dragging");
      return;
    }
    if (mono) {
      dragging = { kind: "pan", startClientX: ev.clientX, startViewStart: viewStart };
      canvas.classList.add("waveform-canvas--dragging");
      select(null);
    } else {
      const inside = sliceAtTime(t);
      if (inside != null) {
        select(inside);
      } else {
        select(null);
      }
    }
  });

  canvas.addEventListener("pointermove", (ev) => {
    const rect = canvas.getBoundingClientRect();
    if (!dragging) {
      canvas.style.cursor = hitBoundary(ev.clientX) ? "ew-resize" : (mono ? "grab" : "default");
      return;
    }
    if (dragging.kind === "boundary") {
      moveBoundary(dragging.refs, xToTime(ev.clientX - rect.left, rect.width));
      redraw();
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
    canvas.classList.remove("waveform-canvas--dragging");
    if (dragging.kind === "boundary") {
      const refs = dragging.refs;
      const current = slices[refs[0].idx][refs[0].which];
      moveBoundary(refs, snap(current));
      slices.sort((a, b) => a.s - b.s);
      redraw();
      onChange();
    }
    dragging = null;
  }
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  redraw();
  window.addEventListener("resize", redraw);

  return {
    el: wrap,
    getRegions: () => slices.map((r) => [r.s, r.e]),
    getSelected: () => selected,
    select,
    playSelected,
    stopPlayback,
    redraw,
    destroy: () => {
      stopPlayback();
      window.removeEventListener("resize", redraw);
    },
  };
}

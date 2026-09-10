// mix-player.js
//
// The floating mix transport: a bar pinned to the bottom of the window showing the whole
// batch as one waveform, with a playhead you can drag.
//
// It lives at the bottom of the viewport rather than inline in the loops list for a
// practical reason - the list gets long. Twenty conformed loops is a lot of scrolling, and
// the control that answers "do these work together?" is the one you reach for most often,
// so it must never be somewhere you have to go and find. Same reasoning (and much the same
// layout) as the mini-player in clickysteve/amfas-music-library, which is where the
// slide-up/body-padding pattern comes from; the audio underneath is entirely different,
// because that plays one <audio> element and this has to keep N buffers sample-locked.
//
// The waveform is the SUMMED mix, tiled - what you will actually hear - not a stack of
// per-loop waveforms. Per-loop detail already lives on the cards; this is the "does the
// whole thing work" view.
import { createMixer } from "./mixer.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/**
 * "3.2" - bar.beat, one-based, at `bpm` in 4/4.
 *
 * Everything else in PLAY NICE is musical - bars, beats, whole-beat snapping - and the
 * transport was the one place reading in minutes and seconds, which is the wrong unit for
 * judging whether a loop starts in the right place.
 */
function fmtBars(sec, bpm, beatsPerBar = 4) {
  if (!(bpm > 0) || !Number.isFinite(sec)) return null;
  const beats = (sec * bpm) / 60;
  const bar = Math.floor(beats / beatsPerBar) + 1;
  const beat = Math.floor(beats % beatsPerBar) + 1;
  return `${bar}.${beat}`;
}

/**
 * @param {object} deps
 * @param {() => AudioContext} deps.getAudioContext
 * @param {(name:string, fallback:string) => string} deps.color
 * @param {() => Array} deps.getTracks              current mix tracks, from the controller
 * @param {(source:string) => void} deps.onSourceChange   "original" | "conformed"
 * @param {() => Promise<void>} deps.onBeforePlay    render anything missing before playing
 * @param {() => void} deps.onPlayStart              so the controller can stop card previews
 * @param {() => void} deps.onProcessAll
 * @param {() => void} deps.onExportAll
 * @param {() => void} deps.onToggleLevels
 * @param {() => boolean} deps.getLevelsMatched
 * @param {() => number|null} deps.getTargetBpm   for the bar grid and the bars.beats readout
 * @param {() => string} deps.getMixSource
 * @param {() => object[]} deps.getTrackStates    live mute/solo/level, applied without reloading
 */
export function createMixPlayer({ getAudioContext, color, getTracks, onSourceChange, onBeforePlay, onPlayStart, onProcessAll, onExportAll, onToggleLevels, getLevelsMatched, getTargetBpm, getMixSource, getTrackStates }) {
  let source = (getMixSource && getMixSource()) || "conformed";
  let rafId = 0;
  let dragging = false;
  let dragPosition = null;
  let peaks = null;
  let peaksToken = "";
  let busy = false;
  let progressText = null;

  const mixer = createMixer({
    getAudioContext,
    onStateChange: () => {
      render();
      if (mixer.isPlaying()) startTicking();
      else stopTicking();
    },
  });

  // ---- layout -------------------------------------------------------------

  const bar = el("div", "pn-mixbar");
  bar.hidden = true;

  const controls = el("div", "pn-mixbar-controls");
  const playBtn = el("button", "pn-mixbar-play", "▶");
  playBtn.type = "button";
  playBtn.title = "Play the whole mix (Space)";
  playBtn.addEventListener("click", togglePlay);
  const stopBtn = el("button", "btn btn--ghost btn--small", "■");
  stopBtn.type = "button";
  stopBtn.title = "Stop and return to the start";
  stopBtn.addEventListener("click", () => mixer.stop());
  const loopBtn = el("button", "btn btn--ghost btn--small pn-mixbar-loop", "Loop");
  loopBtn.type = "button";
  loopBtn.title = "Repeat the mix continuously";
  loopBtn.addEventListener("click", () => mixer.setLoop(!mixer.isLooping()));
  // Monitoring only - it never touches what gets exported, which is why it belongs on the
  // transport rather than anywhere near the export controls.
  const levelBtn = el("button", "btn btn--ghost btn--small pn-mixbar-levels", "Match levels");
  levelBtn.type = "button";
  levelBtn.title = "Balance what you HEAR so one loud loop can't bury the rest. Exports are unaffected.";
  levelBtn.addEventListener("click", () => onToggleLevels());
  controls.append(playBtn, stopBtn, loopBtn, levelBtn);

  const sourceSeg = el("div", "seg pn-mix-seg");
  sourceSeg.setAttribute("role", "group");
  sourceSeg.setAttribute("aria-label", "Which version to play");
  const sourceButtons = {};
  for (const [value, label, title] of [
    ["original", "Original", "The loops as they came in - usually a mess, which is the point."],
    ["conformed", "Conformed", "The conformed versions, playing together."],
  ]) {
    const btn = el("button", "seg-btn", label);
    btn.type = "button";
    btn.title = title;
    btn.addEventListener("click", () => setSource(value));
    sourceButtons[value] = btn;
    sourceSeg.appendChild(btn);
  }

  const waveWrap = el("div", "pn-mixbar-wave");
  const canvas = el("canvas", "pn-mixbar-canvas");
  waveWrap.appendChild(canvas);

  const timeEl = el("span", "pn-mixbar-time");
  const countEl = el("span", "pn-mixbar-count");
  const meta = el("div", "pn-mixbar-meta");
  meta.append(timeEl, countEl);

  // The batch actions live here rather than down in the loops list. They are what the whole
  // screen is FOR, and burying the only button that writes files among "Add loops" and
  // "Clear" - halfway down a page you have to scroll - was exactly backwards. This bar is
  // already the one piece of chrome that never scrolls away, so: hear the batch, then
  // export it, from the same place.
  const actions = el("div", "pn-mixbar-actions");
  const processAllBtn = el("button", "btn", "Process all");
  processAllBtn.type = "button";
  processAllBtn.title = "Render every loop's conformed version, without saving anything.";
  processAllBtn.addEventListener("click", () => onProcessAll());
  const exportAllBtn = el("button", "btn btn--primary", "Export all");
  exportAllBtn.type = "button";
  exportAllBtn.title = "Write every conformed loop to disk.";
  exportAllBtn.addEventListener("click", () => onExportAll());
  actions.append(processAllBtn, exportAllBtn);

  const inner = el("div", "pn-mixbar-inner");
  inner.append(controls, sourceSeg, waveWrap, meta, actions);
  bar.appendChild(inner);

  // ---- scrubbing ----------------------------------------------------------

  function positionFromEvent(ev) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const x = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
    return (x / rect.width) * mixer.duration();
  }
  canvas.addEventListener("pointerdown", (ev) => {
    if (!mixer.duration()) return;
    dragging = true;
    canvas.setPointerCapture(ev.pointerId);
    dragPosition = positionFromEvent(ev);
    draw();
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    dragPosition = positionFromEvent(ev);
    draw();
  });
  function commitDrag() {
    if (!dragging) return;
    dragging = false;
    const to = dragPosition;
    dragPosition = null;
    if (to != null) mixer.seek(to);
    draw();
  }
  canvas.addEventListener("pointerup", commitDrag);
  canvas.addEventListener("pointercancel", () => {
    dragging = false;
    dragPosition = null;
    draw();
  });

  // ---- drawing ------------------------------------------------------------

  // The waveform is static between mix changes, so it is rendered once to an offscreen
  // canvas and blitted. Only the playhead actually moves, and it moves 60 times a second -
  // redrawing 700 bars (and reallocating the canvas backing store, which assigning
  // canvas.width does) on every one of those frames was pure waste.
  let waveCanvas = null;
  let waveToken = "";

  function ensureCanvasSize(cssW, cssH, dpr) {
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    // Assigning width/height RESETS the canvas, so only do it when it genuinely changed.
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      return true;
    }
    return false;
  }

  function renderWaveLayer(cssW, cssH, dpr) {
    const bpm = getTargetBpm ? getTargetBpm() : null;
    const token = `${peaksToken}|${cssW}x${cssH}@${dpr}|${bpm || 0}`;
    if (waveCanvas && waveToken === token) return;
    waveToken = token;
    waveCanvas = document.createElement("canvas");
    waveCanvas.width = Math.round(cssW * dpr);
    waveCanvas.height = Math.round(cssH * dpr);
    const wctx = waveCanvas.getContext("2d");
    wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const mid = cssH / 2;

    // Bar lines FIRST, under the waveform. This is the control you judge alignment on, and
    // without a grid it is an undifferentiated blob - you cannot see whether a loop starts
    // where a bar starts, which is the single thing the whole feature is about.
    const duration = mixer.duration();
    if (bpm > 0 && duration > 0) {
      const barSec = (60 / bpm) * 4;
      const bars = Math.floor(duration / barSec);
      // Give up rather than draw mush when a long mix would produce hundreds of lines.
      if (bars > 0 && bars <= 128) {
        for (let b = 0; b <= bars; b++) {
          const x = ((b * barSec) / duration) * cssW;
          // Every fourth bar reads as a phrase boundary, which is how loops are counted.
          wctx.fillStyle = color(b % 4 === 0 ? "--border" : "--border-soft", "#2b2f36");
          wctx.fillRect(Math.round(x), 0, 1, cssH);
        }
      }
    }

    const barWidth = cssW / peaks.length;
    wctx.fillStyle = color("--wave-fill", "#5b6670");
    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.max(1, peaks[i] * (cssH * 0.44));
      wctx.fillRect(i * barWidth, mid - amp, Math.max(1, barWidth - 0.4), amp * 2);
    }
  }

  function draw() {
    const cssW = Math.max(80, Math.round(canvas.getBoundingClientRect().width || 400));
    const cssH = 40;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ensureCanvasSize(cssW, cssH, dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const duration = mixer.duration();
    if (!peaks || !duration) {
      ctx.fillStyle = color("--text-faint", "#8a929a");
      ctx.font = "500 11px ui-monospace, Menlo, monospace";
      ctx.textBaseline = "middle";
      ctx.fillText("nothing in the mix yet", 8, cssH / 2);
      return;
    }

    renderWaveLayer(cssW, cssH, dpr);
    ctx.drawImage(waveCanvas, 0, 0, cssW, cssH);

    const pos = dragPosition != null ? dragPosition : mixer.position();
    const playedFraction = duration > 0 ? pos / duration : 0;
    const x = playedFraction * cssW;

    // Tint only the part already played, over the blitted waveform.
    if (x > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, x, cssH);
      ctx.clip();
      ctx.globalCompositeOperation = "source-atop";
      ctx.fillStyle = color("--accent", "#ff4b3b");
      ctx.fillRect(0, 0, x, cssH);
      ctx.restore();
    }

    ctx.strokeStyle = color(dragging ? "--accent-2" : "--wave-handle", "#eceef1");
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssH);
    ctx.stroke();
  }

  /** "bar 3.2 · 0:04.10" when a tempo is known, plain clock time when it isn't. */
  function transportText(duration) {
    const bpm = getTargetBpm ? getTargetBpm() : null;
    const bars = fmtBars(mixer.position(), bpm);
    const clock = `${fmtTime(mixer.position())} / ${fmtTime(duration)}`;
    return bars ? `${bars} · ${clock}` : clock;
  }

  function startTicking() {
    if (rafId) return;
    const tick = () => {
      rafId = 0;
      if (!mixer.isPlaying()) return;
      draw();
      timeEl.textContent = transportText(mixer.duration());
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }
  function stopTicking() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    draw();
  }

  if (typeof ResizeObserver === "function") new ResizeObserver(() => draw()).observe(canvas);
  else window.addEventListener("resize", draw);

  // ---- transport ----------------------------------------------------------

  async function togglePlay() {
    if (mixer.isPlaying()) {
      mixer.pause();
      return;
    }
    if (busy) return;
    busy = true;
    render();
    try {
      // Playing the conformed mix with nothing rendered yet would be silence, or a partial
      // mix of whichever loops happened to have been previewed.
      if (source === "conformed" && onBeforePlay) await onBeforePlay();
      refreshTracks();
      if (!mixer.duration()) return;
      onPlayStart();
      mixer.play();
    } finally {
      busy = false;
      render();
    }
  }

  function setSource(next) {
    if (source === next) return;
    source = next;
    onSourceChange(source);
    // Both variants are already running; this is a 12ms gain crossfade with the playhead
    // untouched. A true A/B - not two auditions that each start from the top.
    mixer.setVariant(source);
    // Only the drawing needs redoing. The tracks themselves are variant-independent - they
    // carry both - so forcing a reload here (which resetting peaksToken did) rebuilt every
    // AudioBuffer for a switch that is supposed to be a gain ramp.
    redrawWaveform();
    render();
  }

  /**
   * Pull the current mix from the controller, and hand it to the mixer ONLY if it actually
   * changed.
   *
   * The guard is the important part. mixer.load() rebuilds every AudioBuffer and, if the
   * mix is playing, restarts every source - which means a 0.12s scheduling gap in the audio
   * and a full copy of every loop's samples. refresh() is called from the controller's
   * render(), which fires on essentially any state change, so without this a checkbox
   * click rebuilt the entire mix mid-playback: measured at 2 -> 37 createBuffer calls
   * across a handful of UI interactions that changed no audio whatsoever.
   *
   * The token has to identify the mix's CONTENT, not just its shape. Re-rendering a loop
   * with a different stretch method produces different audio of identical length, so the
   * track's `version` (the controller's plan signature) is what makes that visible - length
   * and id alone would leave the old audio playing.
   */
  function refreshTracks() {
    const tracks = getTracks(source);
    // Neither the active variant nor mute/solo/level appear in this token: the variant is a
    // gain change on already-loaded sources, and the rest are applied live by
    // applyTrackStates(). Only genuinely different AUDIO should force a reload.
    const token = tracks.map((t) => `${t.id}:${t.version}`).join(",");
    if (token !== peaksToken) {
      peaksToken = token;
      mixer.setVariant(source);
      mixer.load(tracks);
    }
    // The waveform still has to follow mute and level, which change without a reload.
    mixer.setTrackStates(getTrackStates ? getTrackStates() : []);
    redrawWaveform();
  }

  /** Recompute the summed waveform for whatever is currently audible, and repaint. */
  function redrawWaveform() {
    peaks = mixer.mixPeaks(700);
    waveToken = ""; // the cached layer is now of the wrong thing
    draw();
  }

  function render() {
    const duration = mixer.duration();
    const count = mixer.trackCount();
    playBtn.textContent = mixer.isPlaying() ? "❚❚" : "▶";
    playBtn.classList.toggle("is-playing", mixer.isPlaying());
    playBtn.disabled = busy;
    stopBtn.disabled = !mixer.isPlaying() && mixer.position() === 0;
    loopBtn.classList.toggle("is-active", mixer.isLooping());
    levelBtn.classList.toggle("is-active", !!(getLevelsMatched && getLevelsMatched()));
    loopBtn.setAttribute("aria-pressed", mixer.isLooping() ? "true" : "false");
    for (const [value, btn] of Object.entries(sourceButtons)) btn.classList.toggle("is-active", source === value);
    timeEl.textContent = duration ? transportText(duration) : "–";
    countEl.textContent = progressText || (busy ? "working…" : countEl.dataset.label || (count ? `${count} in mix` : "nothing in the mix"));
    countEl.classList.toggle("is-working", !!progressText || busy);
  }

  // The tooltip promised "(Space)" and nothing implemented it. Ignored while typing, so it
  // can never swallow a keystroke meant for a BPM field or a key selector.
  function onKeyDown(ev) {
    if (bar.hidden) return;
    if (ev.key !== " " && ev.code !== "Space") return;
    const t = ev.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(t.tagName))) return;
    ev.preventDefault();
    void togglePlay();
  }
  document.addEventListener("keydown", onKeyDown);

  return {
    element: bar,
    mixer,
    getSource: () => source,

    /** Push mute/solo/level onto the running graph. No reload, no restart, no lost position. */
    applyTrackStates() {
      if (bar.hidden) return;
      mixer.setTrackStates(getTrackStates ? getTrackStates() : []);
      redrawWaveform();
      render();
    },

    /** Where a running batch has got to, e.g. "processing 7/20". Null clears it. */
    setProgress(text) {
      progressText = text;
      render();
    },

    /** Enable/disable the batch actions from the controller's own readiness rules. */
    setActionsState({ canProcess, canExport, busy: controllerBusy, label }) {
      processAllBtn.disabled = !canProcess;
      exportAllBtn.disabled = !canExport;
      if (controllerBusy != null) busy = controllerBusy;
      if (label != null) countEl.dataset.label = label;
      render();
    },

    /** Show or hide the bar. It sits in the app's normal flex flow, so hiding it just gives the space back. */
    setVisible(visible) {
      bar.hidden = !visible;
      if (visible) {
        refreshTracks();
        render();
      } else {
        mixer.stop();
      }
    },

    /** Called by the controller whenever the batch, its settings or its rendered audio change. */
    refresh() {
      if (bar.hidden) return;
      refreshTracks();
      render();
    },

    stop() {
      mixer.stop();
    },

    togglePlay,
  };
}

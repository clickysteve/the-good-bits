// preview-waveform.js
//
// A plain audition waveform: peaks, a playhead, click/drag to seek, play/pause/stop, a time
// readout. Deliberately NOT a second copy of editor-waveform.js - that component's entire job is
// slice boundaries (drag handles, shared edges, add/delete, zoom, re-chop), none of which apply
// here. Forcing this to reuse that module would mean threading a fake single "whole file" region
// through boundary-drag code that was never meant to represent one, for no benefit - this is a much
// smaller, simpler thing: the Stretch workspace's Original/Processed audition panes, where the only
// questions are "where am I" and "play from there".
//
// Only one instance plays at a time across the whole page (see the module-level `activeInstance`
// bus below) - starting one stops whichever other instance was playing, so Original and Processed
// (or two different files' waveforms) can never sound simultaneously by accident.
import { computePeaksInRange } from "./dsp.js";

function formatTime(t) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

let activeInstance = null;

/**
 * @param {object} opts
 * @param {Float32Array} opts.mono
 * @param {number} opts.sampleRate
 * @param {number} opts.duration
 * @param {(name:string,fallback:string)=>string} [opts.color]
 * @param {() => AudioContext} opts.getAudioContext  shared context factory (app.js's getAudioContext)
 * @param {() => void} [opts.onPlayStateChange]
 */
export function createPreviewWaveform({ mono, sampleRate, duration, color = (_n, f) => f, getAudioContext, onPlayStateChange = () => {} }) {
  const wrap = document.createElement("div");
  wrap.className = "preview-waveform";
  wrap.tabIndex = 0;

  const canvas = document.createElement("canvas");
  canvas.className = "waveform-canvas preview-waveform-canvas";
  wrap.appendChild(canvas);

  const bar = document.createElement("div");
  bar.className = "preview-waveform-bar";
  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "btn btn--ghost btn--small";
  playBtn.textContent = "▶";
  playBtn.title = "Play/pause (Space)";
  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "btn btn--ghost btn--small";
  stopBtn.textContent = "■";
  stopBtn.title = "Stop (Esc)";
  const timeEl = document.createElement("span");
  timeEl.className = "preview-waveform-time";
  bar.append(playBtn, stopBtn, timeEl);
  wrap.appendChild(bar);

  const hasAudio = !!(mono && mono.length && sampleRate && duration > 0);
  const BIN_COUNT = 500;
  const peaks = hasAudio ? computePeaksInRange(mono, 0, mono.length, BIN_COUNT) : null;

  let audioCtx = null;
  let buffer = null;
  let source = null;
  let playing = false;
  let anchorPos = 0; // file-time seconds, valid when !playing
  let anchorTime = 0; // audioCtx.currentTime at which playback was at anchorPos, valid when playing
  let rafId = 0;
  let dragPreviewPos = null; // set while dragging, before release commits the seek

  function timeToX(t, w) {
    return duration > 0 ? (t / duration) * w : 0;
  }
  function xToTime(x, w) {
    return w > 0 ? Math.max(0, Math.min(duration, (x / w) * duration)) : 0;
  }

  function currentPos() {
    if (dragPreviewPos != null) return dragPreviewPos;
    if (!playing) return anchorPos;
    return Math.min(duration, anchorPos + (audioCtx.currentTime - anchorTime));
  }

  function redraw() {
    const rectWidth = Math.max(100, Math.round(canvas.getBoundingClientRect().width || 300));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssH = 64;
    canvas.width = Math.round(rectWidth * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rectWidth;
    const h = cssH;
    const mid = h / 2;
    ctx.clearRect(0, 0, w, h);

    if (!hasAudio) {
      ctx.fillStyle = color("--text-faint", "#8a929a");
      ctx.font = "500 11px ui-monospace, Menlo, monospace";
      ctx.textBaseline = "middle";
      ctx.fillText("no audio yet", 8, mid);
      timeEl.textContent = "";
      return;
    }

    ctx.fillStyle = color("--wave-fill", "#5b6670");
    const barWidth = w / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const amp = Math.max(1, peaks[i] * (h * 0.44));
      ctx.fillRect(i * barWidth, mid - amp, Math.max(1, barWidth - 0.4), amp * 2);
    }

    const pos = currentPos();
    const x = timeToX(pos, w);
    ctx.strokeStyle = color(dragPreviewPos != null ? "--accent-2" : "--wave-handle", "#eceef1");
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();

    timeEl.textContent = `${formatTime(pos)} / ${formatTime(duration)}`;
    playBtn.textContent = playing ? "❚❚" : "▶";
    playBtn.classList.toggle("is-playing", playing);
  }

  function getBuffer() {
    if (!buffer) {
      audioCtx = audioCtx || getAudioContext();
      buffer = audioCtx.createBuffer(1, mono.length, sampleRate);
      buffer.getChannelData(0).set(mono);
    }
    return buffer;
  }

  function tick() {
    if (!playing) return;
    redraw();
    rafId = requestAnimationFrame(tick);
  }

  function pause() {
    if (!playing) return;
    anchorPos = currentPos();
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch (_) {
        /* already stopped */
      }
      source = null;
    }
    playing = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    redraw();
    onPlayStateChange(false);
  }

  function stop() {
    pause();
    anchorPos = 0;
    redraw();
  }

  function play(fromTime) {
    if (!hasAudio) return;
    if (activeInstance && activeInstance !== instance) activeInstance.pause();
    if (source) pause();
    try {
      audioCtx = audioCtx || getAudioContext();
    } catch (_) {
      return; // no Web Audio available; buttons just do nothing rather than throwing
    }
    let startAt = fromTime != null ? fromTime : anchorPos;
    if (startAt >= duration - 0.005) startAt = 0;
    const src = audioCtx.createBufferSource();
    src.buffer = getBuffer();
    src.connect(audioCtx.destination);
    src.onended = () => {
      if (source === src) {
        playing = false;
        source = null;
        anchorPos = 0;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        redraw();
        onPlayStateChange(false);
      }
    };
    const now = audioCtx.currentTime;
    src.start(now, startAt);
    src.stop(now + (duration - startAt));
    source = src;
    anchorTime = now;
    anchorPos = startAt;
    playing = true;
    activeInstance = instance;
    tick();
    onPlayStateChange(true);
  }

  function togglePlay() {
    if (playing) pause();
    else play(anchorPos);
  }

  function seekTo(t) {
    const wasPlaying = playing;
    const clamped = Math.max(0, Math.min(duration, t));
    if (wasPlaying) play(clamped);
    else {
      anchorPos = clamped;
      redraw();
    }
  }

  playBtn.addEventListener("click", togglePlay);
  stopBtn.addEventListener("click", stop);

  canvas.addEventListener("pointerdown", (ev) => {
    if (!hasAudio) return;
    wrap.focus({ preventScroll: true });
    canvas.setPointerCapture(ev.pointerId);
    const rect = canvas.getBoundingClientRect();
    dragPreviewPos = xToTime(ev.clientX - rect.left, rect.width);
    redraw();
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (dragPreviewPos == null) return;
    const rect = canvas.getBoundingClientRect();
    dragPreviewPos = xToTime(ev.clientX - rect.left, rect.width);
    redraw();
  });
  function commitDrag() {
    if (dragPreviewPos == null) return;
    const t = dragPreviewPos;
    dragPreviewPos = null;
    seekTo(t);
  }
  canvas.addEventListener("pointerup", commitDrag);
  canvas.addEventListener("pointercancel", () => {
    dragPreviewPos = null;
    redraw();
  });

  wrap.addEventListener("keydown", (ev) => {
    if (ev.key === " ") {
      ev.preventDefault();
      togglePlay();
    } else if (ev.key === "Escape") {
      stop();
    }
  });

  redraw();
  let resizeObserver = null;
  if (typeof ResizeObserver === "function") {
    resizeObserver = new ResizeObserver(() => redraw());
    resizeObserver.observe(canvas);
  } else {
    window.addEventListener("resize", redraw);
  }

  const instance = {
    el: wrap,
    play: (t) => play(t),
    pause,
    stop,
    togglePlay,
    seekTo,
    isPlaying: () => playing,
    hasAudio: () => hasAudio,
    getPosition: () => currentPos(),
    getDuration: () => duration,
    focus: () => wrap.focus({ preventScroll: true }),
    redraw,
    destroy: () => {
      pause();
      if (activeInstance === instance) activeInstance = null;
      if (resizeObserver) resizeObserver.disconnect();
      else window.removeEventListener("resize", redraw);
    },
  };
  return instance;
}

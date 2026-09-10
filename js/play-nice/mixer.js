// mixer.js
//
// Play every loop at once, in sync, with a transport you can actually move around in.
//
// Auditioning loops one at a time tells you each is the right tempo. It does not tell you
// they work TOGETHER, which is the only result anybody cares about - and switching the
// same mix between ORIGINAL and CONFORMED is the fastest possible demonstration of what
// the tool did: same loops, same downbeat, incoherent then coherent.
//
// Deliberately not built on preview-waveform.js: that plays one buffer with a playhead and
// enforces one-instance-at-a-time page-wide, which is the opposite of what this needs.
//
// SYNC: every source starts at ONE precomputed AudioContext timestamp a little way in the
// future, rather than "now" per source - starting them in a loop with start(0) would smear
// them across however long the loop takes to run, which at these lengths is audible.
//
// SEAMLESS SWITCHING: mute, solo and Original/Conformed are GAIN changes on sources that
// never stop, not stop-and-restart. Every track gets a source for each variant it has, all
// started together and all running for as long as the mix plays; what you hear is whichever
// gains are open. Restarting instead - which is what this did first - meant a 0.12s
// scheduling gap and a re-attack on every mute, and made A/B'ing two versions of a loop
// impossible to judge, because the thing you were comparing kept beginning again.
//
// The cost is a second set of AudioBuffers while both variants exist. That is the price of
// an instant, sample-accurate A/B, and the sample data is already in memory either way.
//
// POSITION: Web Audio has no notion of "where is this playing" once a source is started,
// so position is derived from the context clock against the timestamp playback began at.
// That stays sample-accurate for as long as the context runs, which is what lets a
// playhead track a looping mix without drifting away from the audio.
import { computePeaksInRange } from "../dsp.js";

/** Scheduling headroom: enough for every source to be created and queued before the shared start. */
const START_LOOKAHEAD_SEC = 0.12;

/**
 * @param {object} deps
 * @param {() => AudioContext} deps.getAudioContext
 * @param {() => void} [deps.onStateChange]  called when playback starts, stops or reaches the end
 */
export function createMixer({ getAudioContext, onStateChange = () => {} }) {
  let tracks = [];
  let duration = 0;
  let playing = false;
  let sources = [];
  const trackGains = new Map(); // track id -> its own gain node, so mute/level never restarts it
  let activeVariant = "conformed";
  let masterGain = null;
  let startedAtCtxTime = 0; // context time corresponding to mix position 0
  let pausedAt = 0; // mix position held while stopped
  let looping = true;
  let endTimer = null;

  /** Ramp rather than jump: a hard gain step on a running source is an audible click. */
  const RAMP_SEC = 0.012;

  const hasSamples = (audio) => !!(audio && audio.channels && audio.channels.length && audio.channels[0] && audio.channels[0].length);

  /** The mix is as long as its longest track IN THE ACTIVE VARIANT - the two can differ. */
  function recomputeDuration() {
    duration = 0;
    for (const t of tracks) {
      const audio = hasSamples(t[activeVariant]) ? t[activeVariant] : hasSamples(t.original) ? t.original : t.conformed;
      if (!hasSamples(audio)) continue;
      duration = Math.max(duration, audio.channels[0].length / (audio.sampleRate || t.sampleRate));
    }
  }

  function teardown() {
    if (endTimer) {
      clearTimeout(endTimer);
      endTimer = null;
    }
    for (const entry of sources) {
      try {
        entry.node.onended = null;
        entry.node.stop();
      } catch (_) {
        /* already stopped */
      }
      try {
        entry.node.disconnect();
        entry.variantGain.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
    sources = [];
    for (const g of trackGains.values()) {
      try {
        g.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
    trackGains.clear();
    if (masterGain) {
      try {
        masterGain.disconnect();
      } catch (_) {
        /* ignore */
      }
      masterGain = null;
    }
  }

  /** Mix position in seconds, from the context clock. */
  function currentPosition() {
    if (!playing) return pausedAt;
    const raw = getAudioContext().currentTime - startedAtCtxTime;
    if (!looping) return Math.max(0, Math.min(duration, raw));
    return duration > 0 ? ((raw % duration) + duration) % duration : 0;
  }

  /** What a track's own gain should be right now: its monitoring level, or silence. */
  function wantedTrackGain(track) {
    if (!track.audible) return 0;
    return Number.isFinite(track.gain) ? track.gain : 1;
  }

  function rampTo(param, value) {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + RAMP_SEC);
  }

  /** Push current mute/solo/level and the active variant onto the running graph. */
  function applyGains() {
    if (!playing) return;
    for (const track of tracks) {
      const g = trackGains.get(track.id);
      if (g) rampTo(g.gain, wantedTrackGain(track));
    }
    for (const entry of sources) {
      rampTo(entry.variantGain.gain, entry.variant === activeVariant ? 1 : 0);
    }
  }

  function startAt(offsetSec) {
    teardown();
    if (!tracks.length || duration <= 0) return false;

    const ctx = getAudioContext();
    // A context created before any user gesture starts suspended; without this the mix
    // silently does nothing on the first click.
    if (ctx.state === "suspended") ctx.resume();

    masterGain = ctx.createGain();
    // Headroom: summing twenty loops at unity clips instantly. Scaling by the square root
    // of the track count keeps perceived level roughly steady as loops are added or muted,
    // rather than the mix getting quieter and quieter the more you put in it.
    masterGain.gain.value = 1 / Math.sqrt(Math.max(1, tracks.length));
    masterGain.connect(ctx.destination);

    const offset = Math.max(0, Math.min(duration, offsetSec || 0));
    const when = ctx.currentTime + START_LOOKAHEAD_SEC;

    for (const track of tracks) {
      const trackGain = ctx.createGain();
      trackGain.gain.value = wantedTrackGain(track);
      trackGain.connect(masterGain);
      trackGains.set(track.id, trackGain);

      // Every variant this track has gets its own running source. Switching between them
      // later is a gain ramp, not a restart.
      for (const variant of ["original", "conformed"]) {
        const audio = track[variant];
        if (!audio || !audio.channels || !audio.channels.length || !audio.channels[0].length) continue;
        const sampleRate = audio.sampleRate || track.sampleRate;
        const trackDuration = audio.channels[0].length / sampleRate;
        const trackOffset = looping ? offset % trackDuration : offset;
        if (!looping && trackOffset >= trackDuration) continue;

        const buffer = ctx.createBuffer(audio.channels.length, audio.channels[0].length, sampleRate);
        for (let c = 0; c < audio.channels.length; c++) buffer.copyToChannel(audio.channels[c], c);
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.loop = looping;
        const variantGain = ctx.createGain();
        variantGain.gain.value = variant === activeVariant ? 1 : 0;
        node.connect(variantGain);
        variantGain.connect(trackGain);
        node.start(when, trackOffset);
        sources.push({ id: track.id, variant, node, variantGain });
      }
    }

    if (!sources.length) {
      teardown();
      return false;
    }

    playing = true;
    startedAtCtxTime = when - offset;
    if (!looping) {
      // Nothing in Web Audio tells us the mix finished, only that individual sources did,
      // so the transport resets itself when the longest one would have ended.
      endTimer = setTimeout(
        () => {
          teardown();
          playing = false;
          pausedAt = 0;
          onStateChange();
        },
        Math.max(0, (duration - offset + START_LOOKAHEAD_SEC) * 1000)
      );
    }
    onStateChange();
    return true;
  }

  return {
    isPlaying: () => playing,
    isLooping: () => looping,
    duration: () => duration,
    activeVariant: () => activeVariant,

    /**
     * Switch Original/Conformed with no restart - both are already running, so this is a
     * 12ms gain crossfade and the playhead never moves. That is what makes it an A/B rather
     * than two separate auditions.
     */
    setVariant(next) {
      if (activeVariant === next) return;
      activeVariant = next;
      recomputeDuration();
      applyGains();
      onStateChange();
    },

    /**
     * Update mute/solo/level for the whole batch without touching playback. The controller
     * hands over the same track list with different `audible`/`gain` values.
     */
    setTrackStates(next) {
      let changed = false;
      for (const update of next) {
        const track = tracks.find((t) => t.id === update.id);
        if (!track) continue;
        if (track.audible !== update.audible || track.gain !== update.gain) changed = true;
        track.audible = update.audible;
        track.gain = update.gain;
      }
      if (!changed) return;
      applyGains();
      onStateChange();
    },
    position: currentPosition,
    trackCount: () => tracks.length,

    /**
     * Replace what the mix contains. Keeps playing from the same position if it was
     * playing - switching Original/Conformed mid-flow should be an A/B, not a restart.
     */
    load(nextTracks) {
      const wasPlaying = playing;
      const at = currentPosition();
      // channels.length is the CHANNEL COUNT - a single empty channel is length 1 and would
      // sail through. What matters is whether there are any samples.
      tracks = nextTracks.filter((t) => hasSamples(t.original) || hasSamples(t.conformed));
      recomputeDuration();
      if (!tracks.length) {
        teardown();
        playing = false;
        pausedAt = 0;
        onStateChange();
        return;
      }
      pausedAt = Math.min(at, duration);
      if (wasPlaying) startAt(pausedAt);
      else onStateChange();
    },

    play(offsetSec) {
      return startAt(offsetSec != null ? offsetSec : pausedAt);
    },

    pause() {
      if (!playing) return;
      pausedAt = currentPosition();
      teardown();
      playing = false;
      onStateChange();
    },

    stop() {
      if (!playing && pausedAt === 0) return;
      teardown();
      playing = false;
      pausedAt = 0;
      onStateChange();
    },

    /** Move the playhead. Restarts the sources when playing, because Web Audio can't seek in place. */
    seek(sec) {
      const at = Math.max(0, Math.min(duration, sec));
      if (playing) startAt(at);
      else {
        pausedAt = at;
        onStateChange();
      }
    },

    setLoop(next) {
      if (looping === !!next) return;
      looping = !!next;
      if (playing) startAt(currentPosition());
      else onStateChange();
    },

    /**
     * Peak data for the summed mix, for drawing. Tracks are tiled to the full mix length,
     * so a two-bar loop inside a four-bar mix shows the two passes it will actually play.
     */
    mixPeaks(binCount) {
      if (!tracks.length || duration <= 0) return null;
      // Each track is read at ITS OWN rate against a shared timeline. Taking one rate from
      // tracks[0] and indexing everything by it draws any differently-rated loop
      // time-compressed and tiled at the wrong period - and mixed rates are entirely
      // ordinary here, since parseWav preserves each file's own rate while decodeAudioData
      // resamples to the context's.
      const first = hasSamples(tracks[0][activeVariant]) ? tracks[0][activeVariant] : hasSamples(tracks[0].original) ? tracks[0].original : tracks[0].conformed;
      const timelineRate = (first && first.sampleRate) || tracks[0].sampleRate;
      const total = Math.round(duration * timelineRate);
      if (total <= 0) return null;
      const sum = new Float32Array(total);
      for (const track of tracks) {
        const audio = hasSamples(track[activeVariant]) ? track[activeVariant] : hasSamples(track.original) ? track.original : track.conformed;
        if (!hasSamples(audio)) continue;
        const ch = audio.channels[0];
        const len = ch.length;
        if (!len) continue;
        // Muted tracks are drawn out of the waveform too, so it always shows what you hear.
        const g = track.audible === false ? 0 : Number.isFinite(track.gain) ? track.gain : 1;
        if (g === 0) continue;
        const step = (audio.sampleRate || track.sampleRate) / timelineRate;
        for (let i = 0; i < total; i++) sum[i] += ch[Math.floor(i * step) % len] * g;
      }
      const scale = 1 / Math.sqrt(Math.max(1, tracks.length));
      for (let i = 0; i < total; i++) sum[i] *= scale;
      return computePeaksInRange(sum, 0, total, binCount);
    },
  };
}

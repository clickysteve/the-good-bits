// outputstage.js
//
// Optional lo-fi coloration applied at export time: a bank of "output stage"
// character presets (tape/vinyl/radio-style coloration), a saturation
// "drive" stage, and a crunch (bitcrush / sample-rate reduction) stage.
// Inspired by the OutputStage/Drive/Interp designs in the author's own
// Loop Saboteur plugin (https://github.com/clickysteve/Loop-Saboteur,
// Source/OutputStage.h) - ported here as offline, whole-buffer JS instead of
// a real-time per-sample audio-thread processor, since this tool has no
// live audio path. Pure functions operating on Float32Array channel data -
// no DOM/Web Audio dependency, so this is unit-testable like the rest of
// the dsp modules.

/** Output stage character presets - order matches the UI select. "clean" is the off/bypass state. */
export const OUTPUT_STAGES = [
  { key: "clean", label: "Clean", description: "no coloration" },
  { key: "cassette", label: "Cassette", description: "C90 wow + flutter + hiss" },
  { key: "reelToReel", label: "Reel-to-Reel", description: "slow wow, head bump, glue" },
  { key: "damaged", label: "Damaged", description: "pitch dropouts, wide flutter" },
  { key: "vinyl", label: "Vinyl", description: "surface crackle + LP wobble" },
  { key: "boombox", label: "Boombox", description: "plastic-cabinet bandpass" },
  { key: "amRadio", label: "AM Radio", description: "300 Hz-4 kHz, occasional static" },
  { key: "vhs", label: "VHS Hi-Fi", description: "AGC pumping, narrow band" },
  { key: "busComp", label: "Bus Comp", description: "2-bus glue, no noise" },
  { key: "lathe", label: "Lathe", description: "dub-plate emphasis" },
  { key: "phone", label: "Phone Bus", description: "voicemail bandpass + mu-law" },
];

/** Saturation drive types - order matches the UI select. */
export const DRIVE_TYPES = [
  { key: "tape", label: "Tape", description: "soft, symmetric saturation" },
  { key: "tube", label: "Tube", description: "asymmetric, warm even harmonics" },
  { key: "diode", label: "Diode", description: "hard clip, odd harmonics" },
  { key: "fuzz", label: "Fuzz", description: "extreme, broken-speaker fuzz" },
];

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// -----------------------------------------------------------------------------
// DSP primitives - direct ports of the equivalent structs in OutputStage.h.
// -----------------------------------------------------------------------------

function makeOnePoleLP(fs, fc) {
  const coeff = Math.exp((-2 * Math.PI * fc) / fs);
  const a = 1 - coeff;
  let y = 0;
  return (x) => {
    y += a * (x - y);
    return y;
  };
}

function makeOnePoleHP(fs, fc) {
  const lp = makeOnePoleLP(fs, fc);
  return (x) => x - lp(x);
}

/** RBJ cookbook peaking EQ. Returns {L, R} process functions with independent channel state. */
function makeBiquadPeak(fs, freq, Q, gainDb) {
  const w0 = (2 * Math.PI * freq) / fs;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  const alpha = sinW0 / (2 * Q);
  const a0d = 1 + alpha / A;
  const b0 = (1 + alpha * A) / a0d;
  const b1 = (-2 * cosW0) / a0d;
  const b2 = (1 - alpha * A) / a0d;
  const a1 = (-2 * cosW0) / a0d;
  const a2 = (1 - alpha / A) / a0d;
  let z1L = 0,
    z2L = 0,
    z1R = 0,
    z2R = 0;
  return {
    L(x) {
      const y = b0 * x + z1L;
      z1L = b1 * x - a1 * y + z2L;
      z2L = b2 * x - a2 * y;
      return y;
    },
    R(x) {
      const y = b0 * x + z1R;
      z1R = b1 * x - a1 * y + z2R;
      z2R = b2 * x - a2 * y;
      return y;
    },
  };
}

/** RBJ cookbook low shelf. */
function makeBiquadLowShelf(fs, freq, gainDb, slope = 1.0) {
  const w0 = (2 * Math.PI * freq) / fs;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const A = Math.pow(10, gainDb / 40);
  const alpha = (sinW0 / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
  const sqrtA2alpha = 2 * Math.sqrt(A) * alpha;
  const a0d = A + 1 + (A - 1) * cosW0 + sqrtA2alpha;
  const b0 = (A * (A + 1 - (A - 1) * cosW0 + sqrtA2alpha)) / a0d;
  const b1 = (2 * A * (A - 1 - (A + 1) * cosW0)) / a0d;
  const b2 = (A * (A + 1 - (A - 1) * cosW0 - sqrtA2alpha)) / a0d;
  const a1 = (-2 * (A - 1 + (A + 1) * cosW0)) / a0d;
  const a2 = (A + 1 + (A - 1) * cosW0 - sqrtA2alpha) / a0d;
  let z1L = 0,
    z2L = 0,
    z1R = 0,
    z2R = 0;
  return {
    L(x) {
      const y = b0 * x + z1L;
      z1L = b1 * x - a1 * y + z2L;
      z2L = b2 * x - a2 * y;
      return y;
    },
    R(x) {
      const y = b0 * x + z1R;
      z1R = b1 * x - a1 * y + z2R;
      z2R = b2 * x - a2 * y;
      return y;
    },
  };
}

/** Soft tanh-ish saturator with adjustable drive. */
function softSat(x, drive = 1) {
  return Math.tanh(x * drive) / Math.tanh(drive);
}

/** Short ring-buffer delay line for wow/flutter, read with linear interpolation at a fractional offset. */
function makeShortDelay(capacity) {
  const buf = new Float32Array(capacity);
  let writePos = 0;
  return {
    write(x) {
      buf[writePos] = x;
      writePos = writePos + 1 >= capacity ? 0 : writePos + 1;
    },
    read(delaySamples) {
      let pos = writePos - delaySamples;
      while (pos < 0) pos += capacity;
      const i0 = Math.floor(pos);
      const i1 = i0 + 1 >= capacity ? 0 : i0 + 1;
      const frac = pos - i0;
      return buf[i0] + frac * (buf[i1] - buf[i0]);
    },
  };
}

/** Peak-detector envelope follower with attack/release in ms. */
function makeEnvFollower(fs, attMs, relMs) {
  const aAtt = Math.exp(-1 / (0.001 * attMs * fs));
  const aRel = Math.exp(-1 / (0.001 * relMs * fs));
  let env = 0;
  return (x) => {
    const ax = Math.abs(x);
    const a = ax > env ? aAtt : aRel;
    env = a * env + (1 - a) * ax;
    return env;
  };
}

/** xorshift32 RNG, seeded per call so re-processing the same audio is reproducible within one run. */
function makeRng(seed) {
  let s = seed >>> 0 || 0xcafe15b0;
  function next() {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  }
  return {
    white: () => (next() | 0) / 2147483648, // [-1, 1)
    uniform: () => (next() & 0x7fffffff) / 2147483648, // [0, 1)
  };
}

// -----------------------------------------------------------------------------
// Per-mode processors - each returns a (L, R) => [L, R] function closing over
// its own filter/oscillator/RNG state, one fresh instance per call to
// applyOutputStage so files never bleed state into each other.
// -----------------------------------------------------------------------------

const MODE_FACTORIES = {
  cassette(fs, rng) {
    const hp60 = makeOnePoleHP(fs, 60);
    const lp9k = makeOnePoleLP(fs, 9000);
    const hissLp = makeOnePoleLP(fs, 6000);
    const wowDelay = makeShortDelay(128);
    let wowPhase = 0,
      flutterPhase = 0;
    const twoPi = Math.PI * 2;
    return (L, R) => {
      wowDelay.write(0.5 * (L + R));
      wowPhase += (twoPi * 0.4) / fs;
      flutterPhase += (twoPi * 8.0) / fs;
      if (wowPhase > twoPi) wowPhase -= twoPi;
      if (flutterPhase > twoPi) flutterPhase -= twoPi;
      const wow = Math.sin(wowPhase) * 10;
      const flut = Math.sin(flutterPhase) * 3;
      const jit = rng.white() * 0.8;
      const dly = Math.max(1, 24 + wow + flut + jit);
      const wobble = wowDelay.read(dly);
      let l = 0.75 * L + 0.25 * wobble;
      let r = 0.75 * R + 0.25 * wobble;
      l = hp60(l);
      r = hp60(r);
      l = lp9k(l);
      r = lp9k(r);
      const hiss = hissLp(rng.white()) * 0.008;
      l += hiss;
      r += hiss;
      return [softSat(l, 1.8), softSat(r, 1.8)];
    };
  },

  reelToReel(fs, rng) {
    const shelf = makeBiquadLowShelf(fs, 80, 2.0, 1.0);
    const lp14k = makeOnePoleLP(fs, 14000);
    const wowDelay = makeShortDelay(128);
    let wowPhase = 0;
    const twoPi = Math.PI * 2;
    return (L, R) => {
      wowDelay.write(0.5 * (L + R));
      wowPhase += (twoPi * 0.25) / fs;
      if (wowPhase > twoPi) wowPhase -= twoPi;
      const wow = Math.sin(wowPhase) * 5;
      const dly = Math.max(1, 16 + wow);
      const wobble = wowDelay.read(dly);
      let l = 0.85 * L + 0.15 * wobble;
      let r = 0.85 * R + 0.15 * wobble;
      l = shelf.L(l);
      r = shelf.R(r);
      l = lp14k(l);
      r = lp14k(r);
      return [softSat(l, 1.5), softSat(r, 1.5)];
    };
  },

  damaged(fs, rng) {
    const lp7k = makeOnePoleLP(fs, 7000);
    const hissLp = makeOnePoleLP(fs, 4000);
    const agc = makeEnvFollower(fs, 5.0, 60.0);
    const wowDelay = makeShortDelay(160);
    let wowPhase = 0,
      flutterPhase = 0,
      skipCountdown = 0,
      skipHoldSamples = 0;
    const twoPi = Math.PI * 2;
    return (L, R) => {
      wowDelay.write(0.5 * (L + R));
      wowPhase += (twoPi * 0.6) / fs;
      flutterPhase += (twoPi * 11.0) / fs;
      if (wowPhase > twoPi) wowPhase -= twoPi;
      if (flutterPhase > twoPi) flutterPhase -= twoPi;
      const wow = Math.sin(wowPhase) * 18;
      const flut = Math.sin(flutterPhase) * 6 * (0.5 + 0.5 * Math.sin(wowPhase * 1.7));
      const jit = rng.white() * 3;
      const dly = Math.max(1, 60 + wow + flut + jit);
      const wobble = wowDelay.read(dly);
      let l = 0.6 * L + 0.4 * wobble;
      let r = 0.6 * R + 0.4 * wobble;
      l = lp7k(l);
      r = lp7k(r);
      const env = agc(0.5 * (l + r));
      const duck = 1 / (1 + 4 * env);
      l *= duck;
      r *= duck;
      const hiss = hissLp(rng.white()) * 0.04;
      l += hiss;
      r += hiss;
      if (--skipCountdown <= 0) {
        skipCountdown = 1 + Math.floor(rng.uniform() * fs * 2.0);
        skipHoldSamples = Math.floor(rng.uniform() * 0.012 * fs);
      }
      if (skipHoldSamples > 0) {
        l *= 0.25;
        r *= 0.25;
        skipHoldSamples--;
      }
      return [l, r];
    };
  },

  vinyl(fs, rng) {
    const riaaHp = makeOnePoleHP(fs, 30);
    const tilt = makeBiquadPeak(fs, 8000, 0.7, 1.5);
    const wowDelay = makeShortDelay(64);
    let vinylPhase = 0,
      clickCountdown = 0;
    const twoPi = Math.PI * 2;
    return (L, R) => {
      wowDelay.write(0.5 * (L + R));
      vinylPhase += (twoPi * 0.55) / fs;
      if (vinylPhase > twoPi) vinylPhase -= twoPi;
      const wow = Math.sin(vinylPhase) * 4;
      const dly = Math.max(1, 8 + wow);
      const wobble = wowDelay.read(dly);
      let l = 0.88 * L + 0.12 * wobble;
      let r = 0.88 * R + 0.12 * wobble;
      l = tilt.L(l);
      r = tilt.R(r);
      l = riaaHp(l);
      r = riaaHp(r);
      const surface = rng.white() * 0.007;
      l += surface;
      r += surface;
      if (--clickCountdown <= 0) {
        clickCountdown = 1 + Math.floor(rng.uniform() * fs * 0.5);
        const popAmp = 0.08 + 0.22 * rng.uniform();
        const popSign = rng.uniform() < 0.5 ? -1 : 1;
        l += popAmp * popSign;
        r += popAmp * popSign;
      }
      return [l, r];
    };
  },

  boombox(fs) {
    const hp150 = makeOnePoleHP(fs, 150);
    const lp8k = makeOnePoleLP(fs, 8000);
    const honk = makeBiquadPeak(fs, 1200, 1.2, 4.0);
    return (L, R) => {
      let l = hp150(L);
      let r = hp150(R);
      l = lp8k(l);
      r = lp8k(r);
      l = honk.L(l);
      r = honk.R(r);
      const mono = 0.5 * (l + r);
      l = 0.7 * l + 0.3 * mono;
      r = 0.7 * r + 0.3 * mono;
      return [softSat(l, 1.3), softSat(r, 1.3)];
    };
  },

  amRadio(fs, rng) {
    const hp300 = makeOnePoleHP(fs, 300);
    const lp4k = makeOnePoleLP(fs, 4000);
    const hissLp = makeOnePoleLP(fs, 3500);
    const progEnv = makeEnvFollower(fs, 8.0, 220.0);
    const kink = (x) => {
      const t = 0.02;
      if (x > t) return x - t * 0.5;
      if (x < -t) return x + t * 0.5;
      return x * 0.5;
    };
    let washEnv = 0,
      washTarget = 0,
      washHold = 0;
    const washA = 1 - Math.exp(-1 / (0.05 * fs));
    return (L, R) => {
      let l = hp300(L);
      let r = hp300(R);
      l = lp4k(l);
      r = lp4k(r);
      l = kink(l);
      r = kink(r);
      const mono = 0.5 * (l + r);
      l = 0.3 * l + 0.7 * mono;
      r = 0.3 * r + 0.7 * mono;
      const prog = progEnv(mono);
      const duck = 1 / (1 + 8 * prog);
      if (--washHold <= 0) {
        washHold = Math.floor(fs * (0.25 + rng.uniform() * 0.55));
        const pick = rng.uniform();
        washTarget = pick < 0.85 ? 0.1 + rng.uniform() * 0.25 : 0.5 + rng.uniform() * 0.5;
      }
      washEnv += washA * (washTarget - washEnv);
      const rawHiss = hissLp(rng.white());
      const hissAmp = (0.0035 + 0.018 * washEnv) * duck;
      const hiss = rawHiss * hissAmp;
      l += hiss;
      r += hiss;
      return [l, r];
    };
  },

  vhs(fs, rng) {
    const hp50 = makeOnePoleHP(fs, 50);
    const lp12k = makeOnePoleLP(fs, 12000);
    const agc = makeEnvFollower(fs, 3.0, 80.0);
    let clickCountdown = 0;
    return (L, R) => {
      let l = hp50(L);
      let r = hp50(R);
      l = lp12k(l);
      r = lp12k(r);
      const env = agc(0.5 * (l + r));
      const duck = 1 / (1 + 2.5 * env);
      l *= duck;
      r *= duck;
      if (--clickCountdown <= 0) {
        clickCountdown = 1 + Math.floor(rng.uniform() * fs * 1.8);
        const tick = 0.02 * (rng.uniform() < 0.5 ? -1 : 1);
        l += tick;
        r += tick;
      }
      return [l, r];
    };
  },

  busComp(fs) {
    const agc = makeEnvFollower(fs, 12.0, 180.0);
    const thr = 0.25;
    const make = 1.05;
    return (L, R) => {
      const env = agc(0.5 * (L + R));
      const over = Math.max(0, env - thr);
      const gr = 1 / (1 + 2 * over);
      return [L * gr * make, R * gr * make];
    };
  },

  lathe(fs, rng) {
    const boost = makeBiquadPeak(fs, 8000, 0.7, 3.0);
    const lp15k = makeOnePoleLP(fs, 15000);
    let skipCountdown = 0,
      skipHoldSamples = 0,
      skipHoldL = 0,
      skipHoldR = 0;
    return (L, R) => {
      let l = boost.L(L);
      let r = boost.R(R);
      l = lp15k(l);
      r = lp15k(r);
      l = softSat(l, 1.4);
      r = softSat(r, 1.4);
      if (--skipCountdown <= 0) {
        skipCountdown = 1 + Math.floor(rng.uniform() * fs * 8.0);
        skipHoldSamples = Math.floor(rng.uniform() * 0.006 * fs);
        skipHoldL = l;
        skipHoldR = r;
      }
      if (skipHoldSamples > 0) {
        l = skipHoldL;
        r = skipHoldR;
        skipHoldSamples--;
      }
      return [l, r];
    };
  },

  phone(fs) {
    const hp400 = makeOnePoleHP(fs, 400);
    const lp3k4 = makeOnePoleLP(fs, 3400);
    const mulawQuant = (x) => {
      const mu = 32;
      const c = (x >= 0 ? 1 : -1) * (Math.log(1 + mu * Math.abs(x)) / Math.log(1 + mu));
      const q = Math.round(c * 8) / 8;
      return (q >= 0 ? 1 : -1) * ((Math.pow(1 + mu, Math.abs(q)) - 1) / mu);
    };
    return (L, R) => {
      let l = hp400(L);
      let r = hp400(R);
      l = lp3k4(l);
      r = lp3k4(r);
      l = mulawQuant(l);
      r = mulawQuant(r);
      const mono = 0.5 * (l + r);
      l = 0.2 * l + 0.8 * mono;
      r = 0.2 * r + 0.8 * mono;
      return [l, r];
    };
  },
};

/**
 * Applies an output-stage character preset to every channel in lockstep (stereo L/R if present,
 * otherwise the single channel is treated as both). `mixPct`/`intensityPct` are 0-100: intensity
 * scales how strongly the mode's own processing differs from the dry signal, mix is the final
 * wet/dry blend - same two-stage design as the plugin this is ported from, so "a little bit of a
 * lot of character" and "all of a little character" are both reachable. mode "clean" (or mix 0)
 * is a no-op copy.
 */
export function applyOutputStage(channels, sampleRate, modeKey, mixPct = 100, intensityPct = 50, seed) {
  const mix = clamp01((mixPct ?? 100) / 100);
  if (!modeKey || modeKey === "clean" || mix <= 0.0001 || !MODE_FACTORIES[modeKey]) {
    return channels.map((ch) => Float32Array.from(ch));
  }
  const intensity = clamp01((intensityPct ?? 50) / 100);
  const rng = makeRng(seed ?? ((0xc0ffee ^ Math.imul(channels[0].length + 1, 2654435761)) >>> 0));
  const proc = MODE_FACTORIES[modeKey](sampleRate, rng);

  const stereo = channels.length > 1;
  const n = channels[0].length;
  const outL = new Float32Array(n);
  const outR = stereo ? new Float32Array(n) : null;
  for (let i = 0; i < n; i++) {
    const dryL = channels[0][i];
    const dryR = stereo ? channels[1][i] : dryL;
    const [rawL, rawR] = proc(dryL, dryR);
    const wetL = dryL + (rawL - dryL) * intensity;
    const wetR = dryR + (rawR - dryR) * intensity;
    outL[i] = dryL + (wetL - dryL) * mix;
    if (stereo) outR[i] = dryR + (wetR - dryR) * mix;
  }
  return stereo ? [outL, outR] : [outL];
}

// -----------------------------------------------------------------------------
// Drive: multi-mode saturation. Ported from the plugin's per-voice DRIVE stage
// (PluginProcessor.cpp) - gain and wet amount are both driven directly off the
// drive amount, same as the source.
// -----------------------------------------------------------------------------

function driveShapeFor(key) {
  switch (key) {
    case "tube":
      return (x, g, d) => {
        const bias = 0.2 * d;
        return Math.tanh((x + bias) * g) - Math.tanh(bias * g);
      };
    case "diode":
      return (x, g) => Math.max(-1, Math.min(1, x * g));
    case "fuzz":
      return (x, g) => {
        const v = x * g;
        return v > 0 ? Math.tanh(v * 3) : Math.max(-1, Math.min(0, v));
      };
    case "tape":
    default:
      return (x, g) => Math.tanh(x * g);
  }
}

/** amountPct 0-100. 0 is a no-op copy. */
export function applyDrive(channels, driveKey, amountPct = 0) {
  const d = clamp01((amountPct ?? 0) / 100);
  if (d <= 0.0001) return channels.map((ch) => Float32Array.from(ch));
  const g = 1 + d * 5;
  const shape = driveShapeFor(driveKey);
  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      out[i] = (1 - d) * x + d * shape(x, g, d);
    }
    return out;
  });
}

// -----------------------------------------------------------------------------
// Crunch: bitcrush (quantize to a lower bit depth) + sample-and-hold rate
// reduction (SP-1200-style "drop-sample" grit, per the plugin's Interp enum).
// -----------------------------------------------------------------------------

/** bits: 1-16 (16 = no reduction). rateDivide: 1-32 (1 = no reduction). Both are no-ops at their max. */
export function applyCrunch(channels, { bits = 16, rateDivide = 1 } = {}) {
  const bitsClamped = Math.max(1, Math.min(16, Math.round(bits ?? 16)));
  const rateClamped = Math.max(1, Math.min(32, Math.round(rateDivide ?? 1)));
  const hasBits = bitsClamped < 16;
  const hasRate = rateClamped > 1;
  if (!hasBits && !hasRate) return channels.map((ch) => Float32Array.from(ch));

  const levels = Math.pow(2, bitsClamped);
  const step = 2 / levels;

  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    let held = 0;
    for (let i = 0; i < ch.length; i++) {
      if (!hasRate || i % rateClamped === 0) held = ch[i];
      out[i] = hasBits ? Math.round(held / step) * step : held;
    }
    return out;
  });
}

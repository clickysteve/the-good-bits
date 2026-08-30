// windows.js
//
// Analysis/synthesis window shapes shared by the WSOLA, granular, phase-vocoder,
// spectral-freeze and PaulStretch engines. Textbook formulas (Hann/triangular),
// no third-party code.

export function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, n - 1));
  return w;
}

export function triangularWindow(n) {
  const w = new Float32Array(n);
  const half = (n - 1) / 2;
  for (let i = 0; i < n; i++) w[i] = 1 - Math.abs((i - half) / Math.max(1, half));
  return w;
}

/** Flat-top-ish rectangular window with a short raised-cosine taper at each edge, just enough to avoid a hard click. */
export function rectTaperWindow(n, taperFraction = 0.08) {
  const w = new Float32Array(n).fill(1);
  const taper = Math.max(1, Math.round(n * taperFraction));
  for (let i = 0; i < taper; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / taper);
    w[i] = g;
    w[n - 1 - i] = g;
  }
  return w;
}

const CACHE = new Map();

/** Cached window lookup by (shape, length) - the STFT-style engines rebuild windows often at a handful of fixed sizes. */
export function getWindow(shape, n) {
  const key = `${shape}:${n}`;
  let w = CACHE.get(key);
  if (!w) {
    w = shape === "tri" ? triangularWindow(n) : shape === "rect" ? rectTaperWindow(n) : hannWindow(n);
    CACHE.set(key, w);
  }
  return w;
}

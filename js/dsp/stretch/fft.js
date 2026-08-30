// fft.js
//
// Small self-contained radix-2 iterative FFT (Cooley-Tukey with a bit-reversal
// permutation pass), operating in place on parallel real/imaginary
// Float64Array buffers whose length must be a power of two. This is the
// standard textbook algorithm - no third-party code was copied to write it -
// and it's the shared FFT infrastructure behind the phase-vocoder, spectral-
// freeze and PaulStretch engines (see js/dsp/stretch/*.js).
//
// Deliberately not the fastest possible implementation (no SIMD, no
// precomputed twiddle tables shared across calls) - it's fast enough for
// offline, non-realtime processing of chop-length audio, and staying simple
// keeps it easy to trust.

/** Smallest power of two >= n (minimum 1). */
export function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

function bitReversePermute(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
}

/** In-place forward FFT. re/im must be the same power-of-two length. */
export function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;
  bitReversePermute(re, im);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWr = 1;
      let curWi = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j;
        const b = a + half;
        const bRe = re[b] * curWr - im[b] * curWi;
        const bIm = re[b] * curWi + im[b] * curWr;
        const aRe = re[a];
        const aIm = im[a];
        re[a] = aRe + bRe;
        im[a] = aIm + bIm;
        re[b] = aRe - bRe;
        im[b] = aIm - bIm;
        const nextWr = curWr * wr - curWi * wi;
        const nextWi = curWr * wi + curWi * wr;
        curWr = nextWr;
        curWi = nextWi;
      }
    }
  }
}

/** In-place inverse FFT (normalized by n so fft() -> ifft() round-trips exactly). */
export function ifft(re, im) {
  const n = re.length;
  if (n <= 1) return;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  const invN = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] *= invN;
    im[i] = -im[i] * invN;
  }
}

/** Wraps a phase (radians) into (-PI, PI]. */
export function wrapPhase(x) {
  const twoPi = Math.PI * 2;
  let y = x - twoPi * Math.floor((x + Math.PI) / twoPi);
  return y;
}

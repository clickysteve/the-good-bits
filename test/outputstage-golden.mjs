// Fixed inputs and settings for the golden-output regression test (outputstage-core.test.mjs).
// Shared by the test and by the one-off script that recorded the hashes from the original
// js/outputstage.js before it moved to Slop Factory Core.
import { createHash } from "node:crypto";

export function signal(n, sr, stereo) {
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const noise = (x / 0x3fffffff - 1) * 0.15;
    L[i] = 0.8 * Math.sin((2 * Math.PI * 97 * i) / sr) + 0.3 * Math.sin((2 * Math.PI * 1650 * i) / sr) + noise;
    R[i] = 0.7 * Math.sin((2 * Math.PI * 143 * i) / sr) - noise + (i / n) * 0.4;
  }
  return stereo ? [L, R] : [L];
}

export function hash(channels) {
  const h = createHash("sha256");
  for (const c of channels) h.update(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
  return h.digest("hex").slice(0, 24);
}

const MODES = ["cassette", "reelToReel", "damaged", "vinyl", "boombox", "amRadio", "vhs", "busComp", "lathe", "phone"];
const DRIVES = ["tape", "tube", "diode", "fuzz", "unknown"];

/** [name, (api) => channels] pairs covering every stage, mode, shape and the full chain. */
export function cases() {
  const out = [];
  for (const sr of [22050, 44100, 48000]) {
    for (const stereo of [false, true]) {
      const tag = `${sr}/${stereo ? "st" : "mono"}`;
      const src = () => signal(9000, sr, stereo);
      for (const m of MODES) {
        out.push([`stage ${m} ${tag}`, (api) => api.applyOutputStage(src(), sr, m, 85, 60, 4242)]);
        out.push([`stage ${m} default-seed ${tag}`, (api) => api.applyOutputStage(src(), sr, m)]);
      }
      for (const d of DRIVES) out.push([`drive ${d} ${tag}`, (api) => api.applyDrive(src(), d, 55)]);
      for (const [bits, rate] of [[8, 1], [12, 3], [3, 7], [16, 4], [1, 32]]) out.push([`crunch ${bits}/${rate} ${tag}`, (api) => api.applyCrunch(src(), { bits, rateDivide: rate })]);
      out.push([
        `chain ${tag}`,
        (api) =>
          api.applyLofiChain(src(), sr, {
            outputStage: { enabled: true, mode: "vhs", mixPct: 70, intensityPct: 80 },
            drive: { enabled: true, type: "tube", amountPct: 30 },
            crunch: { enabled: true, bits: 10, rateDivide: 2 },
          }, api.deriveRegionSeed(7, 3)),
      ]);
      out.push([
        `chain stage-off ${tag}`,
        (api) =>
          api.applyLofiChain(src(), sr, {
            outputStage: { enabled: false, mode: "vinyl", mixPct: 100, intensityPct: 50 },
            drive: { enabled: true, type: "fuzz", amountPct: 70 },
            crunch: { enabled: false, bits: 4, rateDivide: 1 },
          }, 99),
      ]);
    }
  }
  return out;
}

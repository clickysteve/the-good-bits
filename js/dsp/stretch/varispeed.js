// varispeed.js
//
// NOT pitch-preserving, deliberately: this is "play it back at a different
// speed" (like winding tape faster/slower, or a sampler played at the wrong
// note), so duration and pitch move together exactly the way they would on
// that hardware. Reuses the app's existing linear-interpolation resampler
// (dsp.js's resampleLinear, already used for analysis-rate conversion)
// rather than duplicating a resampling loop here.
import { resampleLinear } from "../../dsp.js";

/** ratio = output length / input length, same convention as every other stretch engine here. */
export function stretchVarispeed(channels, ratio) {
  return channels.map((ch) => resampleLinear(ch, 1, ratio));
}

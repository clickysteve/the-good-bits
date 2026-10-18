//#region src/engines/params.ts
/** The default value of every parameter. */
function defaultParams(defs) {
	const out = {};
	for (const d of defs) out[d.id] = d.default;
	return out;
}
/** One value made valid for its parameter: clamped, rounded, or the default when unusable. */
function repairParam(def, v) {
	switch (def.type) {
		case "continuous":
		case "integer": {
			let x = typeof v === "number" && Number.isFinite(v) ? v : def.default;
			if (def.type === "integer") x = Math.round(x);
			return Math.max(def.min, Math.min(def.max, x));
		}
		case "boolean": return typeof v === "boolean" ? v : def.default;
		case "enum": return typeof v === "string" && def.options.some((o) => o.value === v) ? v : def.default;
	}
}
/** Every parameter present and valid; unknown keys dropped. */
function repairParams(defs, src) {
	const o = src && typeof src === "object" && !Array.isArray(src) ? src : {};
	const out = {};
	for (const d of defs) out[d.id] = repairParam(d, o[d.id]);
	return out;
}
/** Whether a value is already valid (repairParam would leave it unchanged). */
function isValidParam(def, v) {
	return repairParam(def, v) === v;
}
var trim = (x, step) => {
	const d = step && step < 1 ? Math.min(4, Math.ceil(-Math.log10(step))) : 0;
	return x.toFixed(d);
};
/** A short display string, e.g. "40%", "8 bit", "OFF", "Cassette". Applications may format their own. */
function formatParam(def, v) {
	switch (def.type) {
		case "continuous":
		case "integer": {
			const x = Number(v);
			if (def.neutral !== void 0 && x === def.neutral) return "OFF";
			const s = def.type === "integer" ? String(Math.round(x)) : trim(x, def.step);
			if (!def.unit) return s;
			return /^[%x]/.test(def.unit) ? `${s}${def.unit}` : `${s} ${def.unit}`;
		}
		case "boolean": return v ? "ON" : "OFF";
		case "enum": return def.options.find((o) => o.value === v)?.label ?? String(v);
	}
}
//#endregion
//#region src/dsp/vendor/goodbits/js/outputstage.js
/** Output stage character presets - order matches the UI select. "clean" is the off/bypass state. */
var OUTPUT_STAGES = [
	{
		key: "clean",
		label: "Clean",
		description: "no coloration"
	},
	{
		key: "cassette",
		label: "Cassette",
		description: "C90 wow + flutter + hiss"
	},
	{
		key: "reelToReel",
		label: "Reel-to-Reel",
		description: "slow wow, head bump, glue"
	},
	{
		key: "damaged",
		label: "Damaged",
		description: "pitch dropouts, wide flutter"
	},
	{
		key: "vinyl",
		label: "Vinyl",
		description: "surface crackle + LP wobble"
	},
	{
		key: "boombox",
		label: "Boombox",
		description: "plastic-cabinet bandpass"
	},
	{
		key: "amRadio",
		label: "AM Radio",
		description: "300 Hz-4 kHz, occasional static"
	},
	{
		key: "vhs",
		label: "VHS Hi-Fi",
		description: "AGC pumping, narrow band"
	},
	{
		key: "busComp",
		label: "Bus Comp",
		description: "2-bus glue, no noise"
	},
	{
		key: "lathe",
		label: "Lathe",
		description: "dub-plate emphasis"
	},
	{
		key: "phone",
		label: "Phone Bus",
		description: "voicemail bandpass + mu-law"
	}
];
/** Saturation drive types - order matches the UI select. */
var DRIVE_TYPES = [
	{
		key: "tape",
		label: "Tape",
		description: "soft, symmetric saturation"
	},
	{
		key: "tube",
		label: "Tube",
		description: "asymmetric, warm even harmonics"
	},
	{
		key: "diode",
		label: "Diode",
		description: "hard clip, odd harmonics"
	},
	{
		key: "fuzz",
		label: "Fuzz",
		description: "extreme, broken-speaker fuzz"
	}
];
function makeOnePoleLP(fs, fc) {
	const a = 1 - Math.exp(-2 * Math.PI * fc / fs);
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
	const w0 = 2 * Math.PI * freq / fs;
	const cosW0 = Math.cos(w0);
	const sinW0 = Math.sin(w0);
	const A = Math.pow(10, gainDb / 40);
	const alpha = sinW0 / (2 * Q);
	const a0d = 1 + alpha / A;
	const b0 = (1 + alpha * A) / a0d;
	const b1 = -2 * cosW0 / a0d;
	const b2 = (1 - alpha * A) / a0d;
	const a1 = -2 * cosW0 / a0d;
	const a2 = (1 - alpha / A) / a0d;
	let z1L = 0, z2L = 0, z1R = 0, z2R = 0;
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
		}
	};
}
/** RBJ cookbook low shelf. */
function makeBiquadLowShelf(fs, freq, gainDb, slope = 1) {
	const w0 = 2 * Math.PI * freq / fs;
	const cosW0 = Math.cos(w0);
	const sinW0 = Math.sin(w0);
	const A = Math.pow(10, gainDb / 40);
	const alpha = sinW0 / 2 * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
	const sqrtA2alpha = 2 * Math.sqrt(A) * alpha;
	const a0d = A + 1 + (A - 1) * cosW0 + sqrtA2alpha;
	const b0 = A * (A + 1 - (A - 1) * cosW0 + sqrtA2alpha) / a0d;
	const b1 = 2 * A * (A - 1 - (A + 1) * cosW0) / a0d;
	const b2 = A * (A + 1 - (A - 1) * cosW0 - sqrtA2alpha) / a0d;
	const a1 = -2 * (A - 1 + (A + 1) * cosW0) / a0d;
	const a2 = (A + 1 + (A - 1) * cosW0 - sqrtA2alpha) / a0d;
	let z1L = 0, z2L = 0, z1R = 0, z2R = 0;
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
		}
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
		}
	};
}
/** Peak-detector envelope follower with attack/release in ms. */
function makeEnvFollower(fs, attMs, relMs) {
	const aAtt = Math.exp(-1 / (.001 * attMs * fs));
	const aRel = Math.exp(-1 / (.001 * relMs * fs));
	let env = 0;
	return (x) => {
		const ax = Math.abs(x);
		const a = ax > env ? aAtt : aRel;
		env = a * env + (1 - a) * ax;
		return env;
	};
}
/**
* xorshift32 RNG, seeded per call so re-processing the same audio is reproducible within one run.
* A second, deliberately separate implementation from js/dsp/stretch/rng.js's mulberry32-based
* makeRng(): that one drives the stretch engines' {next,signed,range,int,bool} API from a
* number-or-string seed shared across a whole engine call, while this one is called per SAMPLE in
* hot loops below (wow/flutter/hiss/click generation, potentially millions of calls per file) and
* only ever needs two cheap accessors. Not merged into one implementation: since the two use
* different underlying algorithms, unifying them would silently change the exact noise sequence -
* and therefore the audible lo-fi output - for every existing seed, which isn't a change to make as
* a side effect of deduplication.
*/
function makeRng(seed) {
	let s = seed >>> 0 || 3405649328;
	function next() {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s;
	}
	return {
		white: () => (next() | 0) / 2147483648,
		uniform: () => (next() & 2147483647) / 2147483648
	};
}
var MODE_FACTORIES = {
	cassette(fs, rng) {
		const hp60 = makeOnePoleHP(fs, 60);
		const lp9k = makeOnePoleLP(fs, 9e3);
		const hissLp = makeOnePoleLP(fs, 6e3);
		const wowDelay = makeShortDelay(128);
		let wowPhase = 0, flutterPhase = 0;
		const twoPi = Math.PI * 2;
		return (L, R) => {
			wowDelay.write(.5 * (L + R));
			wowPhase += twoPi * .4 / fs;
			flutterPhase += twoPi * 8 / fs;
			if (wowPhase > twoPi) wowPhase -= twoPi;
			if (flutterPhase > twoPi) flutterPhase -= twoPi;
			const wow = Math.sin(wowPhase) * 10;
			const flut = Math.sin(flutterPhase) * 3;
			const jit = rng.white() * .8;
			const dly = Math.max(1, 24 + wow + flut + jit);
			const wobble = wowDelay.read(dly);
			let l = .75 * L + .25 * wobble;
			let r = .75 * R + .25 * wobble;
			l = hp60(l);
			r = hp60(r);
			l = lp9k(l);
			r = lp9k(r);
			const hiss = hissLp(rng.white()) * .008;
			l += hiss;
			r += hiss;
			return [softSat(l, 1.8), softSat(r, 1.8)];
		};
	},
	reelToReel(fs, rng) {
		const shelf = makeBiquadLowShelf(fs, 80, 2, 1);
		const lp14k = makeOnePoleLP(fs, 14e3);
		const wowDelay = makeShortDelay(128);
		let wowPhase = 0;
		const twoPi = Math.PI * 2;
		return (L, R) => {
			wowDelay.write(.5 * (L + R));
			wowPhase += twoPi * .25 / fs;
			if (wowPhase > twoPi) wowPhase -= twoPi;
			const wow = Math.sin(wowPhase) * 5;
			const dly = Math.max(1, 16 + wow);
			const wobble = wowDelay.read(dly);
			let l = .85 * L + .15 * wobble;
			let r = .85 * R + .15 * wobble;
			l = shelf.L(l);
			r = shelf.R(r);
			l = lp14k(l);
			r = lp14k(r);
			return [softSat(l, 1.5), softSat(r, 1.5)];
		};
	},
	damaged(fs, rng) {
		const lp7k = makeOnePoleLP(fs, 7e3);
		const hissLp = makeOnePoleLP(fs, 4e3);
		const agc = makeEnvFollower(fs, 5, 60);
		const wowDelay = makeShortDelay(160);
		let wowPhase = 0, flutterPhase = 0, skipCountdown = 0, skipHoldSamples = 0;
		const twoPi = Math.PI * 2;
		return (L, R) => {
			wowDelay.write(.5 * (L + R));
			wowPhase += twoPi * .6 / fs;
			flutterPhase += twoPi * 11 / fs;
			if (wowPhase > twoPi) wowPhase -= twoPi;
			if (flutterPhase > twoPi) flutterPhase -= twoPi;
			const wow = Math.sin(wowPhase) * 18;
			const flut = Math.sin(flutterPhase) * 6 * (.5 + .5 * Math.sin(wowPhase * 1.7));
			const jit = rng.white() * 3;
			const dly = Math.max(1, 60 + wow + flut + jit);
			const wobble = wowDelay.read(dly);
			let l = .6 * L + .4 * wobble;
			let r = .6 * R + .4 * wobble;
			l = lp7k(l);
			r = lp7k(r);
			const duck = 1 / (1 + 4 * agc(.5 * (l + r)));
			l *= duck;
			r *= duck;
			const hiss = hissLp(rng.white()) * .04;
			l += hiss;
			r += hiss;
			if (--skipCountdown <= 0) {
				skipCountdown = 1 + Math.floor(rng.uniform() * fs * 2);
				skipHoldSamples = Math.floor(rng.uniform() * .012 * fs);
			}
			if (skipHoldSamples > 0) {
				l *= .25;
				r *= .25;
				skipHoldSamples--;
			}
			return [l, r];
		};
	},
	vinyl(fs, rng) {
		const riaaHp = makeOnePoleHP(fs, 30);
		const tilt = makeBiquadPeak(fs, 8e3, .7, 1.5);
		const wowDelay = makeShortDelay(64);
		let vinylPhase = 0, clickCountdown = 0;
		const twoPi = Math.PI * 2;
		return (L, R) => {
			wowDelay.write(.5 * (L + R));
			vinylPhase += twoPi * .55 / fs;
			if (vinylPhase > twoPi) vinylPhase -= twoPi;
			const wow = Math.sin(vinylPhase) * 4;
			const dly = Math.max(1, 8 + wow);
			const wobble = wowDelay.read(dly);
			let l = .88 * L + .12 * wobble;
			let r = .88 * R + .12 * wobble;
			l = tilt.L(l);
			r = tilt.R(r);
			l = riaaHp(l);
			r = riaaHp(r);
			const surface = rng.white() * .007;
			l += surface;
			r += surface;
			if (--clickCountdown <= 0) {
				clickCountdown = 1 + Math.floor(rng.uniform() * fs * .5);
				const popAmp = .08 + .22 * rng.uniform();
				const popSign = rng.uniform() < .5 ? -1 : 1;
				l += popAmp * popSign;
				r += popAmp * popSign;
			}
			return [l, r];
		};
	},
	boombox(fs) {
		const hp150 = makeOnePoleHP(fs, 150);
		const lp8k = makeOnePoleLP(fs, 8e3);
		const honk = makeBiquadPeak(fs, 1200, 1.2, 4);
		return (L, R) => {
			let l = hp150(L);
			let r = hp150(R);
			l = lp8k(l);
			r = lp8k(r);
			l = honk.L(l);
			r = honk.R(r);
			const mono = .5 * (l + r);
			l = .7 * l + .3 * mono;
			r = .7 * r + .3 * mono;
			return [softSat(l, 1.3), softSat(r, 1.3)];
		};
	},
	amRadio(fs, rng) {
		const hp300 = makeOnePoleHP(fs, 300);
		const lp4k = makeOnePoleLP(fs, 4e3);
		const hissLp = makeOnePoleLP(fs, 3500);
		const progEnv = makeEnvFollower(fs, 8, 220);
		const kink = (x) => {
			const t = .02;
			if (x > t) return x - t * .5;
			if (x < -.02) return x + t * .5;
			return x * .5;
		};
		let washEnv = 0, washTarget = 0, washHold = 0;
		const washA = 1 - Math.exp(-1 / (.05 * fs));
		return (L, R) => {
			let l = hp300(L);
			let r = hp300(R);
			l = lp4k(l);
			r = lp4k(r);
			l = kink(l);
			r = kink(r);
			const mono = .5 * (l + r);
			l = .3 * l + .7 * mono;
			r = .3 * r + .7 * mono;
			const duck = 1 / (1 + 8 * progEnv(mono));
			if (--washHold <= 0) {
				washHold = Math.floor(fs * (.25 + rng.uniform() * .55));
				washTarget = rng.uniform() < .85 ? .1 + rng.uniform() * .25 : .5 + rng.uniform() * .5;
			}
			washEnv += washA * (washTarget - washEnv);
			const hiss = hissLp(rng.white()) * ((.0035 + .018 * washEnv) * duck);
			l += hiss;
			r += hiss;
			return [l, r];
		};
	},
	vhs(fs, rng) {
		const hp50 = makeOnePoleHP(fs, 50);
		const lp12k = makeOnePoleLP(fs, 12e3);
		const agc = makeEnvFollower(fs, 3, 80);
		let clickCountdown = 0;
		return (L, R) => {
			let l = hp50(L);
			let r = hp50(R);
			l = lp12k(l);
			r = lp12k(r);
			const duck = 1 / (1 + 2.5 * agc(.5 * (l + r)));
			l *= duck;
			r *= duck;
			if (--clickCountdown <= 0) {
				clickCountdown = 1 + Math.floor(rng.uniform() * fs * 1.8);
				const tick = .02 * (rng.uniform() < .5 ? -1 : 1);
				l += tick;
				r += tick;
			}
			return [l, r];
		};
	},
	busComp(fs) {
		const agc = makeEnvFollower(fs, 12, 180);
		const thr = .25;
		const make = 1.05;
		return (L, R) => {
			const env = agc(.5 * (L + R));
			const gr = 1 / (1 + 2 * Math.max(0, env - thr));
			return [L * gr * make, R * gr * make];
		};
	},
	lathe(fs, rng) {
		const boost = makeBiquadPeak(fs, 8e3, .7, 3);
		const lp15k = makeOnePoleLP(fs, 15e3);
		let skipCountdown = 0, skipHoldSamples = 0, skipHoldL = 0, skipHoldR = 0;
		return (L, R) => {
			let l = boost.L(L);
			let r = boost.R(R);
			l = lp15k(l);
			r = lp15k(r);
			l = softSat(l, 1.4);
			r = softSat(r, 1.4);
			if (--skipCountdown <= 0) {
				skipCountdown = 1 + Math.floor(rng.uniform() * fs * 8);
				skipHoldSamples = Math.floor(rng.uniform() * .006 * fs);
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
			const c = (x >= 0 ? 1 : -1) * (Math.log(1 + mu * Math.abs(x)) / Math.log(33));
			const q = Math.round(c * 8) / 8;
			return (q >= 0 ? 1 : -1) * ((Math.pow(33, Math.abs(q)) - 1) / mu);
		};
		return (L, R) => {
			let l = hp400(L);
			let r = hp400(R);
			l = lp3k4(l);
			r = lp3k4(r);
			l = mulawQuant(l);
			r = mulawQuant(r);
			const mono = .5 * (l + r);
			l = .2 * l + .8 * mono;
			r = .2 * r + .8 * mono;
			return [l, r];
		};
	}
};
function driveShapeFor(key) {
	switch (key) {
		case "tube": return (x, g, d) => {
			const bias = .2 * d;
			return Math.tanh((x + bias) * g) - Math.tanh(bias * g);
		};
		case "diode": return (x, g) => Math.max(-1, Math.min(1, x * g));
		case "fuzz": return (x, g) => {
			const v = x * g;
			return v > 0 ? Math.tanh(v * 3) : Math.max(-1, Math.min(0, v));
		};
		default: return (x, g) => Math.tanh(x * g);
	}
}
//#endregion
//#region src/dsp/output/kernels.ts
/**
* Block kernels for the Good Bits lo-fi stages: one stage each, processing a stereo block in
* place. These are the only implementation of the stages in Core: the combined output
* processor (`createChain` in stream.ts) and the output-engine plugins (`../../engines`) are
* both built from them, live (AudioWorklet), offline (OfflineAudioContext) and over plain
* buffers.
*
* Every kernel calls the vendored Good Bits code (`MODE_FACTORIES`, `driveShapeFor`,
* `makeOnePoleLP`) or repeats its arithmetic exactly (crunch, mix/intensity), and rounds to
* 32-bit float on output as Good Bits' whole-buffer functions do when they write a stage into a
* Float32Array. With steady parameters the output is bit-identical to `applyOutputStage`,
* `applyDrive` and `applyCrunch` on the same input and seed, whatever the block size.
*
* `update()` changes parameters in place where that can be done smoothly (a short linear ramp
* on mix, intensity and drive amount) and returns false where it cannot (a different mode,
* shape, bit depth, rate or cutoff), in which case the caller builds a new kernel and
* crossfades to it.
*/
var f32 = Math.fround;
var clamp01 = (x) => Math.max(0, Math.min(1, x));
var num = (v, def) => typeof v === "number" && Number.isFinite(v) ? v : def;
/** Length of an in-place parameter ramp, in samples (20 ms). */
var rampFrames = (sampleRate) => Math.max(1, Math.round(sampleRate * .02));
/** A value that moves linearly to its target over a number of samples and then holds it exactly. */
var Ramp = class {
	value;
	step = 0;
	left = 0;
	goal = 0;
	constructor(value) {
		this.value = value;
	}
	get target() {
		return this.left > 0 ? this.goal : this.value;
	}
	get steady() {
		return this.left === 0;
	}
	to(target, frames) {
		if (this.left === 0 && target === this.value) return;
		this.goal = target;
		this.left = Math.max(1, frames);
		this.step = (target - this.value) / this.left;
	}
	next() {
		if (this.left > 0) {
			this.left--;
			this.value = this.left === 0 ? this.goal : this.value + this.step;
		}
		return this.value;
	}
};
/** Good Bits output stage (applyOutputStage): a character mode, intensity, then mix. */
function outputStageKernel(sampleRate, p, seed) {
	const factory = p.mode !== "clean" ? MODE_FACTORIES[p.mode] : void 0;
	if (!factory) return {
		process() {},
		update: (q) => q.mode === p.mode
	};
	const stage = factory(sampleRate, makeRng(seed >>> 0));
	const mixOf = (pct) => {
		const m = clamp01(num(pct, 100) / 100);
		return m <= 1e-4 ? 0 : m;
	};
	const mix = new Ramp(mixOf(p.mixPct));
	const intensity = new Ramp(clamp01(num(p.intensityPct, 50) / 100));
	const frames = rampFrames(sampleRate);
	return {
		process(L, R, n) {
			if (mix.steady && intensity.steady) {
				const m = mix.value;
				const t = intensity.value;
				if (m === 0) return;
				for (let k = 0; k < n; k++) {
					const l = L[k];
					const r = R[k];
					const [rawL, rawR] = stage(l, r);
					const wetL = l + (rawL - l) * t;
					const wetR = r + (rawR - r) * t;
					L[k] = f32(l + (wetL - l) * m);
					R[k] = f32(r + (wetR - r) * m);
				}
				return;
			}
			for (let k = 0; k < n; k++) {
				const m = mix.next();
				const t = intensity.next();
				const l = L[k];
				const r = R[k];
				const [rawL, rawR] = stage(l, r);
				const wetL = l + (rawL - l) * t;
				const wetR = r + (rawR - r) * t;
				L[k] = f32(l + (wetL - l) * m);
				R[k] = f32(r + (wetR - r) * m);
			}
		},
		update(q) {
			if (q.mode !== p.mode) return false;
			mix.to(mixOf(q.mixPct), frames);
			intensity.to(clamp01(num(q.intensityPct, 50) / 100), frames);
			return true;
		}
	};
}
/** Good Bits drive (applyDrive): out = (1 - d) x + d shape(x, 1 + 5d, d). */
function driveKernel(sampleRate, p) {
	const shape = driveShapeFor(p.type);
	const amount = new Ramp(clamp01(num(p.amountPct, 0) / 100));
	const frames = rampFrames(sampleRate);
	return {
		process(L, R, n) {
			if (amount.steady) {
				const d = amount.value;
				if (d <= 1e-4) return;
				const g = 1 + d * 5;
				for (let k = 0; k < n; k++) {
					L[k] = f32((1 - d) * L[k] + d * shape(L[k], g, d));
					R[k] = f32((1 - d) * R[k] + d * shape(R[k], g, d));
				}
				return;
			}
			for (let k = 0; k < n; k++) {
				const d = amount.next();
				const g = 1 + d * 5;
				L[k] = f32((1 - d) * L[k] + d * shape(L[k], g, d));
				R[k] = f32((1 - d) * R[k] + d * shape(R[k], g, d));
			}
		},
		update(q) {
			if (q.type !== p.type) return false;
			amount.to(clamp01(num(q.amountPct, 0) / 100), frames);
			return true;
		}
	};
}
/** Good Bits crunch (applyCrunch): every n-th sample held n samples, then quantised. */
function crunchKernel(p) {
	const bits = Math.max(1, Math.min(16, Math.round(num(p.bits, 16))));
	const rate = Math.max(1, Math.min(32, Math.round(num(p.rateDivide, 1))));
	const hasBits = bits < 16;
	const hasRate = rate > 1;
	const same = (q) => q.bits === p.bits && q.rateDivide === p.rateDivide;
	if (!hasBits && !hasRate) return {
		process() {},
		update: same
	};
	const step = 2 / Math.pow(2, bits);
	let index = 0;
	let heldL = 0;
	let heldR = 0;
	return {
		process(L, R, n) {
			for (let k = 0; k < n; k++) {
				if (!hasRate || index % rate === 0) {
					heldL = L[k];
					heldR = R[k];
				}
				index++;
				L[k] = hasBits ? f32(Math.round(heldL / step) * step) : heldL;
				R[k] = hasBits ? f32(Math.round(heldR / step) * step) : heldR;
			}
		},
		update: same
	};
}
/** Tone: Good Bits' one-pole low-pass (makeOnePoleLP) per channel. 20 kHz and above = off. */
function toneKernel(sampleRate, p) {
	const same = (q) => q.hz === p.hz;
	if (!(p.hz < 2e4)) return {
		process() {},
		update: same
	};
	const lpL = makeOnePoleLP(sampleRate, p.hz);
	const lpR = makeOnePoleLP(sampleRate, p.hz);
	return {
		process(L, R, n) {
			for (let k = 0; k < n; k++) {
				L[k] = f32(lpL(L[k]));
				R[k] = f32(lpR(R[k]));
			}
		},
		update: same
	};
}
//#endregion
//#region src/engines/builtin.ts
/**
* The built-in audio engines: The Good Bits' three output stages (its lo-fi chain: OUTPUT
* STAGE, DRIVE, CRUNCH), with Good Bits' own parameter names, ranges, defaults and labels, and
* Core's TONE (Good Bits' one-pole low-pass, already part of Core's combined processor).
*
* Parameter ids are Good Bits' settings field names, so a value means the same thing in every
* application and in Good Bits' own settings.
*/
var AUDIO = {
	kind: "audio",
	inputs: ["audio"],
	outputs: ["audio"],
	realtime: true,
	offline: true,
	latency: 0
};
var GOOD_BITS = "The Good Bits (lo-fi chain, js/outputstage.js)";
var OUTPUT_STAGE_ENGINE = {
	...AUDIO,
	id: "goodbits.output-stage",
	name: "Output stage",
	version: 1,
	description: "A character mode (filters, wow and flutter, noise, compression) blended by intensity and mix.",
	origin: GOOD_BITS,
	category: "character",
	seeded: true,
	params: [
		{
			id: "mode",
			type: "enum",
			label: "Character",
			default: "cassette",
			options: OUTPUT_STAGES.filter((s) => s.key !== "clean").map((s) => ({
				value: s.key,
				label: s.label,
				description: s.description
			}))
		},
		{
			id: "mixPct",
			type: "continuous",
			label: "Mix",
			min: 0,
			max: 100,
			step: 1,
			default: 100,
			unit: "%",
			smooth: true,
			description: "Final wet/dry blend"
		},
		{
			id: "intensityPct",
			type: "continuous",
			label: "Intensity",
			min: 0,
			max: 100,
			step: 1,
			default: 50,
			unit: "%",
			smooth: true,
			description: "How strongly the mode differs from the dry signal"
		}
	],
	createKernel: (sr, p, seed) => outputStageKernel(sr, {
		mode: String(p.mode),
		mixPct: Number(p.mixPct),
		intensityPct: Number(p.intensityPct)
	}, seed)
};
var DRIVE_ENGINE = {
	...AUDIO,
	id: "goodbits.drive",
	name: "Drive",
	version: 1,
	description: "Memoryless saturation: tape (soft), tube (asymmetric), diode (hard clip) or fuzz.",
	origin: GOOD_BITS,
	category: "saturation",
	params: [{
		id: "type",
		type: "enum",
		label: "Type",
		default: "tape",
		options: DRIVE_TYPES.map((d) => ({
			value: d.key,
			label: d.label,
			description: d.description
		}))
	}, {
		id: "amountPct",
		type: "continuous",
		label: "Amount",
		min: 0,
		max: 100,
		step: 1,
		default: 40,
		unit: "%",
		neutral: 0,
		smooth: true
	}],
	createKernel: (sr, p) => driveKernel(sr, {
		type: String(p.type),
		amountPct: Number(p.amountPct)
	})
};
var CRUNCH_ENGINE = {
	...AUDIO,
	id: "goodbits.crunch",
	name: "Crunch",
	version: 1,
	description: "Bit-depth reduction and sample-and-hold rate reduction, with no anti-alias filter (the aliasing is the sound).",
	origin: GOOD_BITS,
	category: "lo-fi",
	params: [{
		id: "bits",
		type: "integer",
		label: "Bit depth",
		min: 1,
		max: 16,
		default: 8,
		unit: "bit",
		neutral: 16
	}, {
		id: "rateDivide",
		type: "integer",
		label: "Rate divide",
		min: 1,
		max: 32,
		default: 1,
		unit: "x",
		neutral: 1,
		description: "Every n-th sample is held for n samples"
	}],
	createKernel: (_sr, p) => crunchKernel({
		bits: Number(p.bits),
		rateDivide: Number(p.rateDivide)
	})
};
var TONE_ENGINE = {
	...AUDIO,
	id: "core.tone",
	name: "Tone",
	version: 1,
	description: "A gentle one-pole low-pass (6 dB per octave).",
	origin: "Slop Factory Core (The Good Bits one-pole low-pass)",
	category: "filter",
	params: [{
		id: "hz",
		type: "continuous",
		label: "Cutoff",
		min: 200,
		max: 2e4,
		step: 100,
		default: 8e3,
		unit: "Hz",
		neutral: 2e4,
		scale: "log"
	}],
	createKernel: (sr, p) => toneKernel(sr, { hz: Number(p.hz) })
};
/** Every built-in audio engine, in Good Bits' chain order. Immutable. */
var BUILTIN_AUDIO_ENGINES = Object.freeze([
	OUTPUT_STAGE_ENGINE,
	DRIVE_ENGINE,
	CRUNCH_ENGINE,
	TONE_ENGINE
]);
/** The Good Bits' own selection (its original three stages). */
var GOOD_BITS_ENGINE_IDS = Object.freeze([
	OUTPUT_STAGE_ENGINE.id,
	DRIVE_ENGINE.id,
	CRUNCH_ENGINE.id
]);
//#endregion
//#region src/engines/registry.ts
/**
* Engine registries. A registry is an ordinary object an application creates and owns (there is
* no global list): it holds the engines that application supports, in the order its menus show
* them. `coreEngines()` gives a fresh registry of the built-in engines, optionally restricted to
* the ones the application can use.
*/
var ID = /^[a-z0-9][a-z0-9._-]*$/;
/** Problems with an engine definition (empty when it is usable). */
function checkEngine(def) {
	const errs = [];
	if (!ID.test(def.id ?? "")) errs.push(`invalid id "${def.id}"`);
	if (!def.name) errs.push("missing name");
	if (!Number.isInteger(def.version) || def.version < 1) errs.push("version must be a positive integer");
	if (def.kind !== "audio" && def.kind !== "midi") errs.push(`unknown kind "${def.kind}"`);
	if (def.kind === "audio" && typeof def.createKernel !== "function") errs.push("audio engines need createKernel");
	if (def.kind === "midi" && typeof def.createProcessor !== "function") errs.push("MIDI engines need createProcessor");
	const seen = /* @__PURE__ */ new Set();
	for (const p of def.params ?? []) {
		if (seen.has(p.id)) errs.push(`duplicate parameter "${p.id}"`);
		seen.add(p.id);
		errs.push(...checkParam(p));
	}
	for (const pr of def.presets ?? []) for (const k of Object.keys(pr.params)) if (!seen.has(k)) errs.push(`preset "${pr.key}" sets unknown parameter "${k}"`);
	return errs;
}
function checkParam(p) {
	const errs = [];
	if ((p.type === "continuous" || p.type === "integer") && !(p.min < p.max)) errs.push(`parameter "${p.id}": min must be below max`);
	if (p.type === "enum" && !p.options.length) errs.push(`parameter "${p.id}": no options`);
	if (p.type === "continuous" && p.scale === "log" && !(p.min > 0)) errs.push(`parameter "${p.id}": a log scale needs min > 0`);
	if (repairParam(p, p.default) !== p.default) errs.push(`parameter "${p.id}": default out of range`);
	return errs;
}
var EngineRegistry = class EngineRegistry {
	defs = /* @__PURE__ */ new Map();
	constructor(defs = []) {
		for (const d of defs) this.register(d);
	}
	/** Add an engine. Throws on an invalid definition or a duplicate id. */
	register(def) {
		const errs = checkEngine(def);
		if (errs.length) throw new Error(`engine "${def.id}": ${errs.join("; ")}`);
		if (this.defs.has(def.id)) throw new Error(`engine "${def.id}" is already registered`);
		this.defs.set(def.id, def);
		return this;
	}
	/** Remove an engine (configurations that use it keep it as unavailable). */
	unregister(id) {
		return this.defs.delete(id);
	}
	has(id) {
		return this.defs.has(id);
	}
	get(id) {
		return this.defs.get(id);
	}
	audio(id) {
		const d = this.defs.get(id);
		return d?.kind === "audio" ? d : void 0;
	}
	midi(id) {
		const d = this.defs.get(id);
		return d?.kind === "midi" ? d : void 0;
	}
	/** Engines in registration order. */
	list(filter = {}) {
		return [...this.defs.values()].filter((d) => !filter.kind || d.kind === filter.kind);
	}
	/** A new registry with only these engines (in this registry's order); unknown ids are ignored. */
	only(ids) {
		const want = new Set(ids);
		return new EngineRegistry(this.list().filter((d) => want.has(d.id)));
	}
};
/** A fresh registry of the built-in engines (all of them, or only `ids`). */
function coreEngines(ids) {
	const r = new EngineRegistry(BUILTIN_AUDIO_ENGINES);
	return ids ? r.only(ids) : r;
}
OUTPUT_STAGES.filter((s) => s.key !== "clean");
function cleanFx() {
	return {
		bypass: false,
		inDb: 0,
		outDb: 0,
		outputStage: {
			enabled: false,
			mode: "cassette",
			mixPct: 100,
			intensityPct: 50
		},
		drive: {
			enabled: false,
			type: "tape",
			amountPct: 30
		},
		crunch: {
			enabled: false,
			bits: 12,
			rateDivide: 2
		},
		tone: {
			enabled: false,
			hz: 8e3
		}
	};
}
var withStages = (patch) => (b) => {
	const c = cleanFx();
	return {
		...b,
		bypass: false,
		outputStage: {
			...c.outputStage,
			enabled: false,
			...patch.outputStage
		},
		drive: {
			...c.drive,
			enabled: false,
			...patch.drive
		},
		crunch: {
			...c.crunch,
			enabled: false,
			...patch.crunch
		},
		tone: {
			...c.tone,
			enabled: false,
			...patch.tone
		}
	};
};
var FX_PRESETS = [
	{
		key: "clean",
		label: "CLEAN",
		description: "No processing.",
		apply: () => cleanFx()
	},
	{
		key: "12bit",
		label: "12-BIT",
		description: "Crunch to 12 bits with the rate held every 2 samples, a touch of tape drive, Tone at 10 kHz.",
		apply: withStages({
			drive: {
				enabled: true,
				type: "tape",
				amountPct: 15
			},
			crunch: {
				enabled: true,
				bits: 12,
				rateDivide: 2
			},
			tone: {
				enabled: true,
				hz: 1e4
			}
		})
	},
	{
		key: "bitcrush",
		label: "BITCRUSH",
		description: "Crunch to 8 bits, rate held every 4 samples.",
		apply: withStages({ crunch: {
			enabled: true,
			bits: 8,
			rateDivide: 4
		} })
	},
	{
		key: "rate",
		label: "RATE REDUCE",
		description: "Sample-rate reduction only: every 6th sample held.",
		apply: withStages({ crunch: {
			enabled: true,
			bits: 16,
			rateDivide: 6
		} })
	},
	{
		key: "drive",
		label: "DRIVE",
		description: "Tube drive at 40 %.",
		apply: withStages({ drive: {
			enabled: true,
			type: "tube",
			amountPct: 40
		} })
	},
	{
		key: "cassette",
		label: "CASSETTE",
		description: "Good Bits Cassette output stage.",
		apply: withStages({ outputStage: {
			enabled: true,
			mode: "cassette",
			mixPct: 100,
			intensityPct: 60
		} })
	},
	{
		key: "vinyl",
		label: "VINYL",
		description: "Good Bits Vinyl output stage.",
		apply: withStages({ outputStage: {
			enabled: true,
			mode: "vinyl",
			mixPct: 100,
			intensityPct: 50
		} })
	},
	{
		key: "radio",
		label: "AM RADIO",
		description: "Good Bits AM Radio output stage.",
		apply: withStages({ outputStage: {
			enabled: true,
			mode: "amRadio",
			mixPct: 100,
			intensityPct: 70
		} })
	}
];
//#endregion
//#region src/engines/chain.ts
/**
* Output-chain configuration and its headless controller.
*
* A chain is a straightforward serial list of stages: SOURCE -> stage 1 -> stage 2 -> ... ->
* OUTPUT. A configuration is plain JSON (engine ids, order, enabled state, parameter values),
* safe to store in any application's settings or project file; it never contains AudioNodes or
* other browser objects.
*
* A stage whose engine the application does not have (a project from another application, or
* an engine removed since) is kept, unchanged, as an unavailable stage: it passes audio through,
* the interface can show and remove it, and saving the configuration does not lose it.
*/
var CHAIN_VERSION = 1;
/** Stages a chain may hold. */
var MAX_STAGES = 8;
var emptyChain = () => ({
	version: 1,
	bypass: false,
	stages: []
});
var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var isPrimitive = (v) => typeof v === "boolean" || typeof v === "string" || typeof v === "number" && Number.isFinite(v);
function nextStageId(stages) {
	let n = 0;
	for (const s of stages) {
		const m = /^s(\d+)$/.exec(s.id);
		if (m) n = Math.max(n, Number(m[1]));
	}
	return `s${n + 1}`;
}
/**
* A valid configuration from stored data: missing or broken fields filled, parameters of known
* engines validated, stages of unknown engines kept as they are, duplicate ids renumbered,
* at most MAX_STAGES stages. Never throws.
*/
function repairChain(src, engines) {
	return repairChainWith(src, (id) => engines?.audio(id));
}
/** repairChain with any engine lookup (MIDI chains use their MIDI engines). */
function repairChainWith(src, find) {
	const o = isObj(src) ? src : {};
	const stages = [];
	const ids = /* @__PURE__ */ new Set();
	for (const raw of Array.isArray(o.stages) ? o.stages : []) {
		if (stages.length >= 8) break;
		if (!isObj(raw) || typeof raw.engine !== "string" || !raw.engine) continue;
		const def = find(raw.engine);
		let params;
		if (def) params = repairParams(def.params, raw.params);
		else {
			params = {};
			if (isObj(raw.params)) {
				for (const [k, v] of Object.entries(raw.params)) if (isPrimitive(v)) params[k] = v;
			}
		}
		let id = typeof raw.id === "string" && raw.id && !ids.has(raw.id) ? raw.id : "";
		if (!id) id = nextStageId([...stages, ...[...ids].map((i) => ({ id: i }))]);
		ids.add(id);
		const st = {
			id,
			engine: raw.engine,
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
			params
		};
		const v = def ? def.version : typeof raw.v === "number" ? raw.v : void 0;
		if (v !== void 0) st.v = v;
		stages.push(st);
	}
	return {
		version: 1,
		bypass: typeof o.bypass === "boolean" ? o.bypass : false,
		stages
	};
}
/** Does the chain change audio at all? (False: nothing enabled, or bypassed.) */
function chainActive(c, engines) {
	return !c.bypass && c.stages.some((s) => s.enabled && (!engines || !!engines.audio(s.engine)));
}
/** Stages whose engine is not in `engines` (shown as unavailable). */
function unavailableStages(c, engines) {
	return c.stages.filter((s) => !engines.audio(s.engine));
}
/**
* The seed each stage's kernel gets: the chain seed for the first stage of each engine, a
* derived one for further stages of the same engine. A stage's seed therefore does not change
* when stages of other engines are added, removed or moved.
*/
function stageSeeds(c, seed) {
	const count = /* @__PURE__ */ new Map();
	return c.stages.map((s) => {
		const k = count.get(s.engine) ?? 0;
		count.set(s.engine, k + 1);
		return k === 0 ? seed >>> 0 : (Math.imul((seed ^ k * 2654435761) >>> 0, 2246822507) ^ k) >>> 0;
	});
}
/**
* The stages of a combined output-processor setting (Core's OutputFxSettings), in its order:
* output stage, drive, crunch, tone. Its input and output gain are not stages and are not
* carried over.
*/
function chainFromFx(fx) {
	const c = emptyChain();
	c.bypass = fx.bypass;
	const add = (engine, params) => c.stages.push({
		id: nextStageId(c.stages),
		engine: engine.id,
		enabled: true,
		params: repairParams(engine.params, params),
		v: engine.version
	});
	if (fx.outputStage.enabled) add(OUTPUT_STAGE_ENGINE, { ...fx.outputStage });
	if (fx.drive.enabled) add(DRIVE_ENGINE, { ...fx.drive });
	if (fx.crunch.enabled) add(CRUNCH_ENGINE, { ...fx.crunch });
	if (fx.tone.enabled) add(TONE_ENGINE, { ...fx.tone });
	return c;
}
/** Core's processing presets (CLEAN, 12-BIT, BITCRUSH, ...) as chains. */
var CHAIN_PRESETS = Object.freeze(FX_PRESETS.map((p) => ({
	key: p.key,
	label: p.label,
	description: p.description,
	config: chainFromFx(p.apply(cleanFx()))
})));
/** Presets whose every engine is available. */
function presetsFor(engines, presets = CHAIN_PRESETS) {
	return presets.filter((p) => p.config.stages.every((s) => !!engines.audio(s.engine)));
}
/** Which preset (if any) a configuration currently equals (stage ids ignored). */
function matchChainPreset(c, presets = CHAIN_PRESETS) {
	const key = (x) => JSON.stringify(x.stages.map((s) => [
		s.engine,
		s.enabled,
		s.params
	]));
	const k = key(c);
	return presets.find((p) => key(p.config) === k)?.key ?? null;
}
/**
* A headless controller for one chain: the operations an interface needs, validated against
* the application's registry, with change notifications. It holds no audio; applications pass
* `config` to a chain node (live), to the renderer (export) and to their settings storage.
* Every change produces a new configuration object (the old one is never mutated).
*/
var OutputChain = class {
	registry;
	maxStages;
	cfg;
	listeners = /* @__PURE__ */ new Set();
	constructor(registry, config, maxStages = 8) {
		this.registry = registry;
		this.maxStages = maxStages;
		this.cfg = repairChain(config, registry);
	}
	get config() {
		return this.cfg;
	}
	get stages() {
		return this.cfg.stages;
	}
	/** The audio engines the application offers, in its order. */
	available() {
		return this.registry.list({ kind: "audio" });
	}
	stage(id) {
		return this.cfg.stages.find((s) => s.id === id);
	}
	/** The stage's engine, or undefined when it is unavailable in this application. */
	engine(stage) {
		const s = typeof stage === "string" ? this.stage(stage) : stage;
		return s ? this.registry.audio(s.engine) : void 0;
	}
	get canAdd() {
		return this.cfg.stages.length < Math.min(this.maxStages, 8);
	}
	subscribe(fn) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
	commit(next) {
		this.cfg = next;
		for (const fn of [...this.listeners]) fn(next);
	}
	mapStage(id, fn) {
		const i = this.cfg.stages.findIndex((s) => s.id === id);
		if (i < 0) return false;
		const next = fn(this.cfg.stages[i]);
		if (!next) return false;
		const stages = [...this.cfg.stages];
		stages[i] = next;
		this.commit({
			...this.cfg,
			stages
		});
		return true;
	}
	/** Add a stage with the engine's defaults (at the end, or at `index`). Returns its id. */
	add(engineId, index = this.cfg.stages.length) {
		const def = this.registry.audio(engineId);
		if (!def || !this.canAdd) return null;
		const st = {
			id: nextStageId(this.cfg.stages),
			engine: def.id,
			enabled: true,
			params: defaultParams(def.params),
			v: def.version
		};
		const stages = [...this.cfg.stages];
		stages.splice(Math.max(0, Math.min(stages.length, index)), 0, st);
		this.commit({
			...this.cfg,
			stages
		});
		return st.id;
	}
	remove(id) {
		if (!this.stage(id)) return false;
		this.commit({
			...this.cfg,
			stages: this.cfg.stages.filter((s) => s.id !== id)
		});
		return true;
	}
	/** Move a stage to a new position (clamped). */
	moveTo(id, index) {
		const from = this.cfg.stages.findIndex((s) => s.id === id);
		if (from < 0) return false;
		const to = Math.max(0, Math.min(this.cfg.stages.length - 1, index));
		if (to === from) return false;
		const stages = [...this.cfg.stages];
		const [s] = stages.splice(from, 1);
		stages.splice(to, 0, s);
		this.commit({
			...this.cfg,
			stages
		});
		return true;
	}
	/** Move a stage up (-1) or down (+1). */
	move(id, delta) {
		const i = this.cfg.stages.findIndex((s) => s.id === id);
		return i >= 0 && this.moveTo(id, i + delta);
	}
	/** Swap a stage's engine for another (same position and enabled state, the new engine's defaults). */
	replace(id, engineId) {
		const def = this.registry.audio(engineId);
		if (!def) return false;
		return this.mapStage(id, (s) => s.engine === engineId ? null : {
			...s,
			engine: def.id,
			params: defaultParams(def.params),
			v: def.version
		});
	}
	setEnabled(id, enabled) {
		return this.mapStage(id, (s) => s.enabled === enabled ? null : {
			...s,
			enabled
		});
	}
	/** Set one parameter (validated: clamped, rounded, or refused for unknown parameters). */
	setParam(id, param, value) {
		return this.setParams(id, { [param]: value });
	}
	setParams(id, patch) {
		return this.mapStage(id, (s) => {
			const def = this.registry.audio(s.engine);
			if (!def) return null;
			const params = { ...s.params };
			let changed = false;
			for (const [k, v] of Object.entries(patch)) {
				const p = def.params.find((x) => x.id === k);
				if (!p || v === void 0) continue;
				const r = repairParam(p, v);
				if (params[k] !== r) {
					params[k] = r;
					changed = true;
				}
			}
			return changed ? {
				...s,
				params
			} : null;
		});
	}
	/** Back to the engine's defaults. */
	resetParams(id) {
		return this.mapStage(id, (s) => {
			const def = this.registry.audio(s.engine);
			return def ? {
				...s,
				params: defaultParams(def.params)
			} : null;
		});
	}
	/** Apply one of the stage's engine presets. */
	applyEnginePreset(id, key) {
		const pr = this.engine(id)?.presets?.find((p) => p.key === key);
		return !!pr && this.setParams(id, pr.params);
	}
	/** Bypass (or restore) the whole chain. */
	setBypass(bypass) {
		if (this.cfg.bypass !== bypass) this.commit({
			...this.cfg,
			bypass
		});
	}
	/** Replace the configuration (validated). */
	load(config) {
		this.commit(repairChain(config, this.registry));
	}
	/** Replace the stages with a preset's (only if every engine it uses is available). */
	applyPreset(preset) {
		if (!preset.config.stages.every((s) => this.registry.audio(s.engine))) return false;
		this.commit(repairChain({
			...preset.config,
			bypass: false
		}, this.registry));
		return true;
	}
	clear() {
		this.commit({
			...this.cfg,
			stages: []
		});
	}
};
//#endregion
//#region src/engines/stream.ts
/**
* The output chain as a block processor. The same class runs inside the chain AudioWorklet
* (live AudioContext and OfflineAudioContext) and over plain buffers (`renderChain`), so what
* an application plays and what it exports come from one implementation.
*
* Changes while running never click:
* - a parameter the engine can change in place ramps (mix, intensity, drive amount);
* - any other parameter change builds a new kernel for that stage and crossfades to it;
* - enabling or bypassing a stage, or the whole chain, crossfades between processed and dry
*   (a re-enabled stage starts from fresh state);
* - adding, removing, reordering or replacing stages builds the new chain and crossfades from
*   the old one.
* With nothing changing, a stage's output is exactly its kernel's output, and a disabled stage
* or a bypassed chain is exactly the input.
*/
/** Samples over which a structural, bypass or kernel change crossfades (about 12 ms at 44.1 kHz). */
var CHAIN_FADE = 512;
var sameParams = (a, b) => {
	const ka = Object.keys(a);
	return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};
var StageRunner = class {
	def;
	stage;
	sampleRate;
	seed;
	kernel = null;
	old = null;
	fadeLeft = 0;
	wet;
	constructor(def, stage, sampleRate, seed) {
		this.def = def;
		this.stage = stage;
		this.sampleRate = sampleRate;
		this.seed = seed;
		this.wet = new Ramp(stage.enabled ? 1 : 0);
		if (def && stage.enabled) this.kernel = this.create();
	}
	create() {
		return this.def ? this.def.createKernel(this.sampleRate, this.stage.params, this.seed) : null;
	}
	update(stage) {
		const prev = this.stage;
		this.stage = stage;
		if (!this.def) return;
		if (stage.enabled && !prev.enabled) {
			if (this.wet.steady && this.wet.value === 0) {
				this.kernel = this.create();
				this.old = null;
				this.fadeLeft = 0;
			}
			this.wet.to(1, 512);
		} else if (!stage.enabled && prev.enabled) this.wet.to(0, 512);
		if (sameParams(prev.params, stage.params) || !this.kernel) return;
		if (this.kernel.update?.(stage.params)) return;
		if (!this.old) {
			this.old = this.kernel;
			this.fadeLeft = 512;
		}
		this.kernel = this.create();
	}
	process(L, R, n, s) {
		const k = this.kernel;
		const w = this.wet;
		if (!k || w.steady && w.value === 0) return;
		const blend = !w.steady || w.value !== 1;
		if (blend) {
			s.dL.set(L.subarray(0, n));
			s.dR.set(R.subarray(0, n));
		}
		if (this.old) {
			const { oL, oR } = s;
			oL.set(L.subarray(0, n));
			oR.set(R.subarray(0, n));
			this.old.process(oL, oR, n);
			k.process(L, R, n);
			for (let i = 0; i < n && this.fadeLeft > 0; i++, this.fadeLeft--) {
				const t = 1 - this.fadeLeft / 512;
				L[i] = oL[i] + (L[i] - oL[i]) * t;
				R[i] = oR[i] + (R[i] - oR[i]) * t;
			}
			if (this.fadeLeft <= 0) this.old = null;
		} else k.process(L, R, n);
		if (blend) {
			const { dL, dR } = s;
			for (let i = 0; i < n; i++) {
				const g = w.next();
				L[i] = dL[i] + (L[i] - dL[i]) * g;
				R[i] = dR[i] + (R[i] - dR[i]) * g;
			}
		}
	}
};
var structure = (c) => JSON.stringify(c.stages.map((s) => [s.id, s.engine]));
var ChainStream = class {
	engines;
	sampleRate;
	seed;
	cfg;
	runners;
	oldRunners = null;
	fadeLeft = 0;
	wet;
	scratch = {
		dL: /* @__PURE__ */ new Float32Array(128),
		dR: /* @__PURE__ */ new Float32Array(128),
		oL: /* @__PURE__ */ new Float32Array(128),
		oR: /* @__PURE__ */ new Float32Array(128)
	};
	cL = /* @__PURE__ */ new Float32Array(128);
	cR = /* @__PURE__ */ new Float32Array(128);
	xL = /* @__PURE__ */ new Float32Array(128);
	xR = /* @__PURE__ */ new Float32Array(128);
	constructor(engines, config, sampleRate, seed) {
		this.engines = engines;
		this.sampleRate = sampleRate;
		this.seed = seed;
		this.cfg = repairChain(config, engines);
		this.runners = this.build();
		this.wet = new Ramp(this.cfg.bypass ? 0 : 1);
	}
	get config() {
		return this.cfg;
	}
	/** True when the chain leaves audio unchanged and nothing is fading. */
	get idle() {
		return !this.oldRunners && this.wet.steady && (this.wet.value === 0 || !chainActive(this.cfg, this.engines));
	}
	build() {
		const seeds = stageSeeds(this.cfg, this.seed);
		return this.cfg.stages.map((s, i) => new StageRunner(this.engines.audio(s.engine), s, this.sampleRate, seeds[i]));
	}
	set(config) {
		const next = repairChain(config, this.engines);
		const prev = this.cfg;
		this.cfg = next;
		if (next.bypass !== prev.bypass) {
			if (!next.bypass && this.wet.steady && this.wet.value === 0) {
				this.runners = this.build();
				this.oldRunners = null;
				this.fadeLeft = 0;
			}
			this.wet.to(next.bypass ? 0 : 1, 512);
		}
		if (structure(next) !== structure(prev)) {
			if (!this.oldRunners) {
				this.oldRunners = this.runners;
				this.fadeLeft = 512;
			}
			this.runners = this.build();
			return;
		}
		next.stages.forEach((s, i) => this.runners[i].update(s));
	}
	/** Start every stage's state afresh (noise, filters, counters), with no crossfade. */
	reset() {
		this.oldRunners = null;
		this.fadeLeft = 0;
		this.wet = new Ramp(this.cfg.bypass ? 0 : 1);
		this.runners = this.build();
	}
	grow(n) {
		if (this.cL.length >= n) return;
		this.scratch = {
			dL: new Float32Array(n),
			dR: new Float32Array(n),
			oL: new Float32Array(n),
			oR: new Float32Array(n)
		};
		this.cL = new Float32Array(n);
		this.cR = new Float32Array(n);
		this.xL = new Float32Array(n);
		this.xR = new Float32Array(n);
	}
	run(runners, L, R, n) {
		for (const r of runners) r.process(L, R, n, this.scratch);
	}
	/** Process a stereo block in place. */
	process(L, R, n = L.length) {
		const w = this.wet;
		if (w.steady && w.value === 0) return;
		this.grow(n);
		const blend = !w.steady || w.value !== 1;
		if (blend) {
			this.cL.set(L.subarray(0, n));
			this.cR.set(R.subarray(0, n));
		}
		if (this.oldRunners) {
			const { xL, xR } = this;
			xL.set(L.subarray(0, n));
			xR.set(R.subarray(0, n));
			this.run(this.oldRunners, xL, xR, n);
			this.run(this.runners, L, R, n);
			for (let i = 0; i < n && this.fadeLeft > 0; i++, this.fadeLeft--) {
				const t = 1 - this.fadeLeft / 512;
				L[i] = xL[i] + (L[i] - xL[i]) * t;
				R[i] = xR[i] + (R[i] - xR[i]) * t;
			}
			if (this.fadeLeft <= 0) this.oldRunners = null;
		} else this.run(this.runners, L, R, n);
		if (blend) {
			const { cL, cR } = this;
			for (let i = 0; i < n; i++) {
				const g = w.next();
				L[i] = cL[i] + (L[i] - cL[i]) * g;
				R[i] = cR[i] + (R[i] - cR[i]) * g;
			}
		}
	}
};
var builtin = null;
/**
* Run a chain over whole buffers: the offline path, the same code as the worklet. One channel
* in gives one channel out (processed as identical left and right, as Good Bits does); the
* input is not modified.
*/
function renderChain(channels, sampleRate, config, seed, opts = {}) {
	const engines = opts.engines ?? (builtin ??= coreEngines());
	const L = Float32Array.from(channels[0] ?? []);
	const R = Float32Array.from(channels[1] ?? channels[0] ?? []);
	const s = new ChainStream(engines, config, sampleRate, seed >>> 0);
	if (!s.idle) {
		const block = Math.max(1, opts.blockSize ?? 128);
		for (let i = 0; i < L.length; i += block) {
			const n = Math.min(block, L.length - i);
			s.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
		}
	}
	return channels.length > 1 ? [L, R] : [L];
}
//#endregion
//#region src/engines/constants.ts
/** The AudioWorklet processor name registered by the chain worklet. */
var OUTPUT_CHAIN_PROCESSOR = "slopfactory-output-chain";
//#endregion
//#region src/engines/node.ts
/**
* Output-chain nodes for any BaseAudioContext (live or offline).
*
* `loadOutputChain(ctx, moduleUrl)` registers the chain worklet once per context. The module URL
* comes from the application's bundler (for Vite: `import url from
* '@slopfactory/core/chain-worklet.js?url'`), so Core makes no assumption about how it is served.
*
* Without AudioWorklet (an insecure context or an old browser) `createChainNode` returns a
* plain stereo pass-through and reports `processing: false`, so audio still plays, unprocessed.
*/
var loaded = /* @__PURE__ */ new WeakMap();
function loadOutputChain(ctx, moduleUrl) {
	let byUrl = loaded.get(ctx);
	if (!byUrl) loaded.set(ctx, byUrl = /* @__PURE__ */ new Map());
	let p = byUrl.get(moduleUrl);
	if (!p) {
		p = (async () => {
			try {
				if (!ctx.audioWorklet) return false;
				await ctx.audioWorklet.addModule(moduleUrl);
				return true;
			} catch {
				return false;
			}
		})();
		byUrl.set(moduleUrl, p);
	}
	return p;
}
/** A stereo node that runs a chain. Mono sources are up-mixed to two channels. */
function createChainNode(ctx, config = emptyChain(), opts) {
	let current = config;
	if (opts.available && typeof AudioWorkletNode !== "undefined") {
		const node = new AudioWorkletNode(ctx, opts.processor ?? "slopfactory-output-chain", {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [2],
			channelCount: 2,
			channelCountMode: "explicit",
			channelInterpretation: "speakers",
			processorOptions: {
				config,
				seed: (opts.seed ?? 1) >>> 0,
				...opts.resetAt !== void 0 ? { resetAt: opts.resetAt } : {}
			}
		});
		return {
			node,
			processing: true,
			get config() {
				return current;
			},
			set(c) {
				current = c;
				node.port.postMessage({
					type: "config",
					config: c
				});
			},
			reset(at) {
				node.port.postMessage({
					type: "reset",
					at
				});
			},
			dispose() {
				node.disconnect();
				node.port.onmessage = null;
				node.port.close();
			}
		};
	}
	const g = ctx.createGain();
	g.channelCount = 2;
	g.channelCountMode = "explicit";
	g.channelInterpretation = "speakers";
	return {
		node: g,
		processing: false,
		get config() {
			return current;
		},
		set(c) {
			current = c;
		},
		reset() {},
		dispose() {
			g.disconnect();
		}
	};
}
//#endregion
//#region src/engines/processor.ts
/**
* The output-chain AudioWorklet processor. It only moves blocks in and out of a ChainStream, so
* live playback (AudioContext) and offline rendering (OfflineAudioContext) run exactly the same
* DSP code as `renderChain`.
*
* `registerChainProcessor(engines)` registers it for a set of engines. Core's own worklet file
* (`chain-worklet.js`) registers the built-in engines; an application with engines of its own
* builds a worklet entry that calls this with its engine list.
*
* Messages: { type: 'config', config } changes the chain (crossfaded where needed);
*           { type: 'reset', at } restarts every stage's state at context time `at` (seconds).
*/
function registerChainProcessor(engines, name = OUTPUT_CHAIN_PROCESSOR) {
	const registry = new EngineRegistry(engines);
	class OutputChainProcessor extends AudioWorkletProcessor {
		stream;
		resetAt = null;
		constructor(options) {
			super(options);
			const po = options.processorOptions ?? {};
			this.stream = new ChainStream(registry, po.config ?? emptyChain(), sampleRate, (po.seed ?? 1) >>> 0);
			if (typeof po.resetAt === "number") this.resetAt = po.resetAt;
			this.port.onmessage = (e) => {
				const m = e.data;
				if (m.type === "config" && m.config) this.stream.set(m.config);
				else if (m.type === "reset") this.resetAt = typeof m.at === "number" ? m.at : 0;
			};
		}
		process(inputs, outputs) {
			const out = outputs[0];
			const L = out[0];
			const R = out[1] ?? out[0];
			const inp = inputs[0] ?? [];
			if (inp.length > 0) {
				L.set(inp[0]);
				R.set(inp[1] ?? inp[0]);
			} else {
				L.fill(0);
				R.fill(0);
			}
			if (this.resetAt !== null && currentTime >= this.resetAt) {
				this.stream.reset();
				this.resetAt = null;
			}
			this.stream.process(L, R, L.length);
			return true;
		}
	}
	registerProcessor(name, OutputChainProcessor);
}
//#endregion
//#region src/engines/midi.ts
/**
* A serial chain of MIDI engines with note safety built in.
*
* Engines transform note-ons and channel messages; they never end notes. The chain records, for
* every note-on it receives, the note-ons that left the chain because of it, and when that note
* ends (note-off, or note-on with velocity 0) it sends the matching note-offs itself, no
* earlier than the note-ons they end. So bypassing, removing, reordering or re-configuring an
* engine while notes are held, or stopping the transport, can never leave a note stuck:
* whatever an engine did to a note-on, its note-off follows the recorded result.
*
* Where two held notes produce the same output note (same channel and key), the output note-off
* is sent when the last of them ends. System messages (clock, start, stop, song position) pass
* through untouched, in order.
*
* No MIDI engine is built in yet (The Good Bits has no MIDI processing to extract); this is the
* contract and plumbing that future MIDI engines plug into.
*/
var isNoteOn = (b) => (b[0] & 240) === 144 && (b[2] ?? 0) > 0;
var isNoteOff = (b) => (b[0] & 240) === 128 || (b[0] & 240) === 144 && (b[2] ?? 0) === 0;
var noteKey = (b) => (b[0] & 15) * 128 + (b[1] & 127);
var MidiEngineChain = class {
	engines;
	out;
	cfg;
	stages = [];
	/** input note -> the output notes it produced, with their note-on times */
	held = /* @__PURE__ */ new Map();
	/** output note -> number of input notes holding it */
	holders = /* @__PURE__ */ new Map();
	constructor(engines, config, out) {
		this.engines = engines;
		this.out = out;
		this.cfg = repairChainWith(config, (id) => this.engines.midi(id));
		this.build();
	}
	get config() {
		return this.cfg;
	}
	/** Output notes currently sounding. */
	get sounding() {
		return this.holders.size;
	}
	create(s) {
		return this.engines.midi(s.engine)?.createProcessor(s.params) ?? null;
	}
	build() {
		this.stages = this.cfg.stages.map((s) => ({
			cfg: s,
			proc: this.create(s)
		}));
	}
	/** Change the chain. Held notes keep their recorded outputs and end correctly. */
	set(config) {
		const next = repairChainWith(config, (id) => this.engines.midi(id));
		const old = new Map(this.stages.map((s) => [s.cfg.id, s]));
		this.cfg = next;
		this.stages = next.stages.map((c) => {
			const prev = old.get(c.id);
			if (prev && prev.cfg.engine === c.engine && prev.proc) {
				if (JSON.stringify(prev.cfg.params) === JSON.stringify(c.params) || prev.proc.update?.(c.params)) return {
					cfg: c,
					proc: prev.proc
				};
			}
			return {
				cfg: c,
				proc: this.create(c)
			};
		});
	}
	run(msg) {
		let msgs = [msg];
		if (this.cfg.bypass) return msgs;
		for (const s of this.stages) {
			if (!s.cfg.enabled || !s.proc) continue;
			const next = [];
			for (const m of msgs) s.proc.process(m, (o) => !isNoteOff(o.bytes) && next.push({
				bytes: [...o.bytes],
				time: o.time
			}));
			msgs = next;
		}
		return msgs;
	}
	release(input, time) {
		const outs = this.held.get(input);
		if (!outs) return;
		this.held.delete(input);
		for (const o of outs) {
			const n = (this.holders.get(o.key) ?? 1) - 1;
			if (n > 0) {
				this.holders.set(o.key, n);
				continue;
			}
			this.holders.delete(o.key);
			this.out({
				bytes: [
					128 | Math.floor(o.key / 128),
					o.key % 128,
					0
				],
				time: Math.max(time, o.time)
			});
		}
	}
	/** Send one message into the chain. */
	send(msg) {
		const b = msg.bytes;
		if (!b.length) return;
		if (b[0] >= 240) {
			this.out({
				bytes: [...b],
				time: msg.time
			});
			return;
		}
		if (isNoteOff(b)) {
			this.release(noteKey(b), msg.time);
			return;
		}
		if (!isNoteOn(b)) {
			for (const m of this.run(msg)) this.out(m);
			return;
		}
		const input = noteKey(b);
		this.release(input, msg.time);
		const outs = [];
		for (const m of this.run(msg)) {
			if (isNoteOn(m.bytes)) {
				const k = noteKey(m.bytes);
				outs.push({
					key: k,
					time: m.time
				});
				this.holders.set(k, (this.holders.get(k) ?? 0) + 1);
			}
			this.out(m);
		}
		if (outs.length) this.held.set(input, outs);
	}
	/** End every note the chain started (no earlier than its note-on) and reset the engines. */
	panic(time) {
		for (const input of [...this.held.keys()]) this.release(input, time);
		for (const s of this.stages) s.proc?.reset?.();
	}
	/** Transport stop: the same as panic. */
	stop(time) {
		this.panic(time);
	}
};
//#endregion
export { BUILTIN_AUDIO_ENGINES, CHAIN_FADE, CHAIN_PRESETS, CHAIN_VERSION, CRUNCH_ENGINE, ChainStream, DRIVE_ENGINE, EngineRegistry, GOOD_BITS_ENGINE_IDS, MAX_STAGES, MidiEngineChain, OUTPUT_CHAIN_PROCESSOR, OUTPUT_STAGE_ENGINE, OutputChain, TONE_ENGINE, chainActive, chainFromFx, checkEngine, coreEngines, createChainNode, defaultParams, emptyChain, formatParam, isValidParam, loadOutputChain, matchChainPreset, presetsFor, registerChainProcessor, renderChain, repairChain, repairChainWith, repairParam, repairParams, stageSeeds, unavailableStages };

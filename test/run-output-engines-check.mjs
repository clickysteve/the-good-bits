// Browser check for the move of the lo-fi stages onto Slop Factory Core's output engines.
// Requires the "playwright" package: npm install --no-save playwright && npx playwright install chromium
// (or set CHROMIUM_PATH). Serves the repository itself, so no separate server is needed.
//
// 1. The page loads with no errors; the Output stage / Drive / Crunch controls are filled from
//    the engines' metadata (10 characters, 4 drive types, Good Bits' slider ranges).
// 2. The real export path - heavy-dsp-worker.js, a module worker importing the vendored Core
//    file - produces byte-identical WAVs to the same chain run in Node.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { applyLofiChain, deriveRegionSeed } from "../js/outputstage.js";
import { applyFades } from "../js/dsp.js";
import { encodeWav } from "../js/audio-codec.js";
import { signal } from "./outputstage-golden.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
  const path = normalize(join(root, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  try {
    const body = await readFile(path.endsWith("/") ? join(path, "index.html") : path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(0);
const port = server.address().port;

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(err.message));
page.on("console", (msg) => {
  if (msg.type() === "error" && !/essentia|jsdelivr|ERR_CONNECTION|net::|Failed to load resource/.test(msg.text())) errors.push(msg.text());
});
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "load" });
await page.waitForTimeout(500);

const ui = await page.evaluate(() => {
  const attrs = (id) => {
    const el = document.getElementById(id);
    return [el.min, el.max, el.step, el.value].join("/");
  };
  return {
    modes: [...document.querySelectorAll("#outputstage-mode-select option")].map((o) => o.value),
    drives: [...document.querySelectorAll("#drive-type-select option")].map((o) => o.value),
    mix: attrs("outputstage-mix-slider"),
    intensity: attrs("outputstage-intensity-slider"),
    amount: attrs("drive-amount-slider"),
    bits: attrs("crunch-bits-slider"),
    rate: attrs("crunch-rate-slider"),
  };
});
check("character select lists the 10 Output stage modes", ui.modes.join() === "cassette,reelToReel,damaged,vinyl,boombox,amRadio,vhs,busComp,lathe,phone", ui.modes.join());
check("drive type select lists the 4 shapes", ui.drives.join() === "tape,tube,diode,fuzz", ui.drives.join());
check("slider ranges and defaults unchanged", [ui.mix, ui.intensity, ui.amount, ui.bits, ui.rate].join(" ") === "0/100/1/100 0/100/1/50 0/100/1/40 1/16/1/8 1/32/1/1", JSON.stringify(ui));

// the export worker, with the real message protocol
const lofi = {
  outputStage: { enabled: true, mode: "cassette", mixPct: 90, intensityPct: 70 },
  drive: { enabled: true, type: "diode", amountPct: 25 },
  crunch: { enabled: true, bits: 9, rateDivide: 2 },
};
const regions = [signal(30000, 44100, true), signal(17000, 44100, false)];
const fromWorker = await page.evaluate(
  async ({ lofi, regions }) => {
    const w = new Worker(new URL("./js/heavy-dsp-worker.js", location.href), { type: "module" });
    const res = await new Promise((resolve, reject) => {
      w.onmessage = (e) => resolve(e.data);
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage({ type: "processRegions", requestId: 1, sampleRate: 44100, bitDepth: 24, fadeInSamples: 32, fadeOutSamples: 64, stretchRatio: 1, seed: 11, lofi, regions: regions.map((channels) => ({ channels: channels.map((c) => Float32Array.from(c)) })) });
    });
    w.terminate();
    if (res.type !== "processRegionsResult") return { error: res.message };
    const hex = async (blob) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { hashes: await Promise.all(res.results.map((r) => hex(r.blob))) };
  },
  { lofi, regions: regions.map((r) => r.map((c) => Array.from(c))) },
);
const expected = await Promise.all(
  regions.map(async (channels, i) => {
    const out = applyLofiChain(channels, 44100, lofi, deriveRegionSeed(11, i));
    applyFades(out, 32, 64);
    return createHash("sha256").update(Buffer.from(await encodeWav(out, 44100, 24).arrayBuffer())).digest("hex");
  }),
);
check("export worker WAVs are byte-identical to the Node chain", !fromWorker.error && JSON.stringify(fromWorker.hashes) === JSON.stringify(expected), fromWorker.error ?? "");
check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);

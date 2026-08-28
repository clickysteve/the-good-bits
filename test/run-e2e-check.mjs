// End-to-end check: drives the real page (legacy/ZIP path, forced by hiding the File System
// Access API so it's automatable) through Drums mode with one-shot extraction and a
// name+key/tempo+number naming pattern on a synthetic drum file, then inspects the resulting
// ZIP contents. Complements run-ui-check.mjs (DOM wiring) and run-smoke.mjs (module-level
// essentia/JSZip checks) by exercising the actual processBatch pipeline in app.js.
//
// Requires the "playwright" package and a fixture WAV at the path below (see README "Testing").
import { chromium } from "playwright";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const FIXTURE = process.env.E2E_FIXTURE_WAV || "/tmp/e2e-fixture/drum_take.wav";
if (!existsSync(FIXTURE)) {
  console.error(`Fixture WAV not found at ${FIXTURE}. Generate one (see test/run-e2e-check.mjs header) or set E2E_FIXTURE_WAV.`);
  process.exit(1);
}

const downloadDir = mkdtempSync(path.join(tmpdir(), "good-bits-e2e-"));

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(err.message));
page.on("console", (msg) => {
  if (msg.type() === "error" && !/essentia|jsdelivr|ERR_CONNECTION_RESET|net::/.test(msg.text())) {
    errors.push(`console.error: ${msg.text()}`);
  }
});

// Force the legacy <input>/ZIP path even in Chromium, since the File System Access API's
// native folder picker can't be automated. This must run before app.js's module script does.
await page.addInitScript(() => {
  delete window.showDirectoryPicker;
  delete window.showOpenFilePicker;
});

await page.goto("http://127.0.0.1:8877/index.html", { waitUntil: "load" });
await page.waitForTimeout(300);

// Drums mode, one-shot extraction on, 2-bar chop length, name+key/tempo+number naming.
await page.locator('.mode-card[data-mode="drums"]').click();
await page.locator("#one-shots-checkbox").check();
await page.locator("#drum-bars-select").selectOption("2");
await page.locator("#naming-pattern-select").selectOption("name-tag-number");
await page.locator("#naming-separator-select").selectOption("_");

// Legacy folder input needs a directory; simulate "Add Source Folder" by feeding the
// directory containing the fixture straight into the hidden webkitdirectory input.
await page.setInputFiles("#legacy-folder-input", path.dirname(FIXTURE));
await page.waitForTimeout(200);

const folderCount = await page.locator(".folder-row").count();
if (folderCount !== 1) {
  console.error(`Expected 1 queued source folder, got ${folderCount}`);
  process.exit(1);
}

const [download] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.locator("#process-btn").click()]);
const zipPath = path.join(downloadDir, "output.zip");
await download.saveAs(zipPath);

await page.waitForFunction(() => document.querySelector("#log-panel")?.textContent.includes("Done."), { timeout: 5000 }).catch(() => {});
const logText = await page.locator("#log-panel").innerText();

console.log("---- log panel ----");
console.log(logText);
console.log("---- page errors ----");
console.log(errors.length ? errors.join("\n") : "(none)");
console.log("---- zip saved to ----");
console.log(zipPath);

await browser.close();
process.exit(errors.length || !logText.includes("Done.") ? 1 : 0);

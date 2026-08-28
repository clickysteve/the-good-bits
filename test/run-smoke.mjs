// Requires the "playwright" package: npm install --no-save playwright && npx playwright install chromium
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleMsgs = [];
page.on("console", (msg) => consoleMsgs.push(`[console:${msg.type()}] ${msg.text()}`));
page.on("pageerror", (err) => consoleMsgs.push(`[pageerror] ${err.message}`));

const resp = await page.goto("http://127.0.0.1:8877/test/browser-smoke.html", { waitUntil: "load", timeout: 20000 }).catch((e) => {
  console.error("goto failed:", e.message);
  return null;
});
console.log("goto status:", resp && resp.status());
await page
  .waitForFunction(() => document.getElementById("out").textContent.includes("SMOKE_TEST_DONE"), { timeout: 30000 })
  .catch((e) => console.error("waitForFunction:", e.message));

const text = await page.textContent("#out").catch((e) => `(could not read #out: ${e.message})`);
console.log("---- page output ----");
console.log(text);
console.log("---- console/page log ----");
console.log(consoleMsgs.join("\n"));

await browser.close();
process.exit(text.includes("FAIL") || !text.includes("SMOKE_TEST_DONE") ? 1 : 0);

// Requires the "playwright" package: npm install --no-save playwright && npx playwright install chromium
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(err.message));
page.on("console", (msg) => {
  if (msg.type() === "error" && !/essentia|jsdelivr|ERR_CONNECTION_RESET|net::/.test(msg.text())) {
    errors.push(`console.error: ${msg.text()}`);
  }
});

await page.goto("http://127.0.0.1:8877/index.html", { waitUntil: "load" });
await page.waitForTimeout(500);

const checks = {};
checks.title = await page.title();
checks.modeCardCount = await page.locator(".mode-card").count();
checks.processDisabledInitially = await page.locator("#process-btn").isDisabled();
checks.paramSlidersForPhrases = await page.locator("#params-panel input[type=range]").count();

await page.locator('.mode-card[data-mode="drums"]').click();
await page.waitForTimeout(100);
checks.paramSlidersForDrums = await page.locator("#params-panel input[type=range]").count();
checks.drumActiveClass = await page.locator('.mode-card[data-mode="drums"]').getAttribute("class");

await page.locator('.mode-card[data-mode="rhodes"]').click();
await page.waitForTimeout(100);
checks.paramSlidersForRhodes = await page.locator("#params-panel input[type=range]").count();

checks.outputBannerText = await page.locator("#output-banner").textContent();
checks.fsaSupportedInPage = await page.evaluate(() => "showDirectoryPicker" in window);

console.log(JSON.stringify(checks, null, 2));
console.log("---- page errors ----");
console.log(errors.length ? errors.join("\n") : "(none)");

await browser.close();
process.exit(errors.length ? 1 : 0);

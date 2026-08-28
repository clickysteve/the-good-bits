// Requires the "playwright" package: npm install --no-save playwright && npx playwright install chromium
// Serve the app first: npx http-server -c-1 . -p 8877
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
await page.waitForTimeout(400);

const checks = {};
checks.title = await page.title();
checks.versionBadgeText = await page.locator("#version-badge").textContent();
checks.headingIsGoodBits = /The Good Bits/.test(await page.locator(".page-header h1").innerText());

checks.addFilesBtnExists = await page.locator("#add-files-btn").count();
checks.splitSubfoldersCheckboxExists = await page.locator("#split-subfolders-checkbox").count();
checks.autoParamsCheckboxExists = await page.locator("#auto-params-checkbox").count();
checks.autoParamsCheckedByDefault = await page.locator("#auto-params-checkbox").isChecked();
checks.paramsPanelShowsAutoNote = (await page.locator(".params-auto-note").count()) === 1;
checks.paramsPanelHasNoSlidersWhileAuto = (await page.locator("#params-panel input[type=range]").count()) === 0;

// Untick Auto -> sliders should appear
await page.locator("#auto-params-checkbox").uncheck();
await page.waitForTimeout(100);
checks.slidersAppearWhenAutoOff = (await page.locator("#params-panel input[type=range]").count()) > 0;

// Re-check Auto -> sliders should hide again
await page.locator("#auto-params-checkbox").check();
await page.waitForTimeout(100);
checks.slidersHideWhenAutoOnAgain = (await page.locator("#params-panel input[type=range]").count()) === 0;

checks.outputBannerText = await page.locator("#output-banner").textContent();
checks.bannerMentionsOldApp = /old app/i.test(checks.outputBannerText);
checks.pageTextMentionsOldApp = /old (macos )?app/i.test(await page.locator("body").innerText());

// Drum-only options should be hidden until Drums mode is selected.
checks.drumOptionsHiddenByDefault = await page.locator("#drum-options").isHidden();
await page.locator('.mode-card[data-mode="drums"]').click();
await page.waitForTimeout(100);
checks.drumOptionsVisibleForDrums = await page.locator("#drum-options").isVisible();
checks.barOptions = await page.locator("#drum-bars-select option").allTextContents();
checks.oneShotsCheckboxExists = await page.locator("#one-shots-checkbox").count();
checks.oneShotsUncheckedByDefault = !(await page.locator("#one-shots-checkbox").isChecked());

// Back to phrases -> hidden again.
await page.locator('.mode-card[data-mode="phrases"]').click();
await page.waitForTimeout(100);
checks.drumOptionsHiddenAgain = await page.locator("#drum-options").isHidden();

// Output naming panel.
checks.namingPatternOptions = await page.locator("#naming-pattern-select option").count();
checks.namingSeparatorDefault = await page.locator("#naming-separator-select").inputValue();
checks.namingFolderTagCheckedByDefault = await page.locator("#naming-folder-tag-checkbox").isChecked();

console.log(JSON.stringify(checks, null, 2));
console.log("---- page errors ----");
console.log(errors.length ? errors.join("\n") : "(none)");

await browser.close();
process.exit(errors.length ? 1 : 0);

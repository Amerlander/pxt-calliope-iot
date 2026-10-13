// Checks that the feed field lists the dashboard's feeds once someone posts
// them (pxt-calliope fieldeditors/iotFeedOptions.ts). A frame inside the
// editor posts the message, as the simulator panel would.
//
//   node tools/editor/feedoptions.mjs <project-name> <out.png> [editor-url]
//
// The project (pxt-calliope/projects/, fresh, empty main.blocks) must use the
// feed "temp" in a send block.
import { createRequire } from "node:module";
const require = createRequire("C:/GIT/calliope-dev/editors/calliope-campus/package.json");
const { chromium } = require("@playwright/test");

const [name, out, base = "http://localhost:3232"] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const logs = [];
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));

await page.goto(`${base}/index.html?ws=fs&lang=en&nocookiebanner=1`);
const card = page.locator(".ui.card, .project-card, [role=listitem]").filter({ hasText: name }).first();
await card.waitFor({ timeout: 90000 });
await card.click();
await page.waitForSelector(".monaco-editor, .blocklyMainBackground", { state: "attached", timeout: 90000 });
await page.waitForTimeout(6000);
await page.getByText("Go back").click({ timeout: 3000 }).catch(() => {});
await page.getByText("Blocks", { exact: true }).first().click();
await page.waitForTimeout(6000);

// The list as pxt builds it: open the field that shows "temp", read the menu.
async function listOfTempField() {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const field = page.locator(".blocklyBlockCanvas text").filter({ hasText: /^temp$/ }).first();
  await field.click();
  await page.waitForTimeout(800);
  const items = await page.locator(".blocklyDropDownDiv .blocklyMenuItem, .blocklyDropDownDiv [role=option]").allTextContents();
  return items.map((t) => t.trim()).filter(Boolean);
}

const before = await listOfTempField();
const posted = await page.evaluate(() => {
  const frame = document.createElement("iframe");
  frame.style.display = "none";
  document.body.appendChild(frame);
  // Run inside the frame, so the message's source is the frame (the way a
  // simx panel posts), not the editor window itself.
  frame.contentWindow.eval(
    'parent.postMessage({ type: "calliope-iot-feeds", feeds: ["pumpe", "licht", "temp", "bad name!"] }, "*")'
  );
  return true;
});
await page.waitForTimeout(500);
const after = await listOfTempField();
await page.screenshot({ path: out });
console.log(JSON.stringify({ before, posted, after, logs }, null, 2));
await browser.close();

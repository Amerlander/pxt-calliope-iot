// Opens a project of the local editor's file workspace (pxt serve, projects/)
// and asks for Blocks, then reports what the canvas shows. Used for the D5
// check: does a feed input render as a block when no Campus file is around?
//
//   node tools/editor/blockscheck.mjs <project-name> <out.png> [editor-url]
//   ROUNDTRIP=1 ...   also switch back to JavaScript and print the code pxt
//                     regenerates from the blocks
//
// The project must sit in pxt-calliope/projects/ (the editor runs with
// ?ws=fs), with an empty main.blocks so pxt decompiles main.ts. Use a fresh
// project per run: reopening one the editor already saved can end in a 409
// and an "Auto-Save Disabled" dialog.
import { createRequire } from "node:module";
const require = createRequire("C:/GIT/calliope-dev/editors/calliope-campus/package.json");
const { chromium } = require("@playwright/test");

const [name, out, base = "http://localhost:3232"] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const logs = [];
page.on("console", (m) => {
  if (m.type() === "error" || /duplicate|shadow|Invalid block/i.test(m.text())) logs.push(`${m.type()}: ${m.text()}`);
});
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));

async function dismissDialogs() {
  const modals = await page.locator(".ReactModal__Content, .ui.modal.visible").allTextContents();
  for (const t of modals) logs.push(`dialog: ${t.trim().slice(0, 200)}`);
  if (modals.length) {
    await page.getByRole("button", { name: /Continue|OK|Close/i }).first().click({ timeout: 2000 }).catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
  }
}

await page.goto(`${base}/index.html?ws=fs&lang=en&nocookiebanner=1`);
// Home screen: the project card carries the project name.
const card = page.locator(".ui.card, .project-card, [role=listitem]").filter({ hasText: name }).first();
await card.waitFor({ timeout: 90000 });
await card.click();
await page.waitForSelector(".monaco-editor, .blocklyMainBackground", { state: "attached", timeout: 90000 });
await page.waitForTimeout(6000);
await dismissDialogs();
// Close the README side panel if it opened, then ask for Blocks: that switch
// is what pxt refuses when the XML names a block that does not exist.
await page.getByText("Go back").click({ timeout: 3000 }).catch(() => {});
await page.getByText("Blocks", { exact: true }).first().click();
await page.waitForTimeout(6000);
await dismissDialogs();

const report = await page.evaluate(() => {
  const ws = document.querySelector(".blocklyWorkspace .blocklyBlockCanvas");
  const texts = ws ? Array.from(ws.querySelectorAll("text")).map((t) => t.textContent.trim()).filter(Boolean) : [];
  return { blockCount: ws ? ws.querySelectorAll(".blocklyDraggable").length : 0, texts };
});
await page.screenshot({ path: out });

let js = [];
if (process.env.ROUNDTRIP) {
  await page.getByText("JavaScript", { exact: true }).first().click();
  await page.waitForTimeout(5000);
  await dismissDialogs();
  js = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".monaco-editor .view-line")).map((l) => l.textContent.replace(/\u00a0/g, " "))
  );
}
console.log(JSON.stringify({ ...report, texts: report.texts.join(" | "), js, logs: logs.slice(0, 20) }, null, 2));
await browser.close();

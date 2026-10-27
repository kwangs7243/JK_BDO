import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const root = new URL("../../", import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), "bdo-trade-mode-"));
const socket = createServer();
await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.env.PYTHON ?? "python", ["-B", "-c",
  `from local_app.backend.app import create_app; create_app(${JSON.stringify(join(temporary, "test.sqlite3"))}, testing=True).run(host='127.0.0.1', port=${port}, use_reloader=False, threaded=True)`],
  { cwd: root, windowsHide: true, stdio: "ignore", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/api/health`)).ok) break; } catch {}
    if (attempt >= 100) throw Error("Isolated app did not start");
    await delay(150);
  }
  browser = await chromium.launch({ executablePath: process.env.BDO_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [], nativeDialogs = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => { nativeDialogs.push(dialog.type()); void dialog.dismiss(); });
  await page.goto(`${origin}/barter/`);
  await page.waitForFunction(() => document.querySelectorAll(".inventory-row").length === 70);
  const idle = () => page.evaluate(() => import("/assets/js/persistence.js").then(m => m.whenPersistenceIdle()));
  const select = page.locator("#brief-session-mode");
  assert.equal(await select.isDisabled(), true, "no working session starts disabled");
  await page.evaluate(async () => {
    await (await import("/assets/js/persistence.js")).saveInventory({"갈퀴 꽃 씨앗 주머니":{stock:100},"괴생물 촉수":{stock:0}});
    await (await import("/assets/js/trade-ui.js")).applyLiveTradeRows([{island:"베이루와 섬",fromItem:"갈퀴 꽃 씨앗 주머니",toItem:"괴생물 촉수",reqAmount:1,count:3,yield:3}], "new");
  });
  await page.locator('[data-workspace-view="briefing"]').click();
  assert.equal(await select.isDisabled(), false, "freshly recognized session enables mode without a reload");
  await select.selectOption("inner"); await idle();
  let snapshot = await fetch(`${origin}/api/bootstrap`).then(r => r.json());
  assert.equal(snapshot.workingSession.config.ship.mode, "inner", "changed mode is persisted in the current session");
  assert.ok(snapshot.workingSession.schedule.speed.length, "mode change still calculates a schedule");
  await select.selectOption("none"); await idle();
  snapshot = await fetch(`${origin}/api/bootstrap`).then(r => r.json());
  assert.equal(snapshot.workingSession.config.ship.mode, "none");
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#app-content").getAttribute("aria-busy") === "false");
  assert.equal(await select.isDisabled(), false);
  assert.equal(await select.inputValue(), "none");
  await page.evaluate(async () => { await (await import("/assets/js/persistence.js")).resetWorkingSession(); });
  assert.equal(await select.isDisabled(), true, "reset session disables the control again");
  await page.evaluate(async () => {
    await (await import("/assets/js/trade-ui.js")).applyLiveTradeRows([{island:"베이루와 섬",fromItem:"갈퀴 꽃 씨앗 주머니",toItem:"괴생물 촉수",reqAmount:1,count:3,yield:3}], "new");
  });
  assert.equal(await select.isDisabled(), false, "a second fresh session re-enables the control");
  assert.deepEqual(errors, []); assert.deepEqual(nativeDialogs, []);
  console.log("PASS: fresh recognition enables trade mode, mode changes save and calculate, reload/reset/new-session cycle");
} finally {
  await browser?.close();
  server.kill();
  if (server.exitCode === null) await new Promise(resolve => server.once("exit", resolve));
  await rm(temporary, { recursive: true, force: true });
}

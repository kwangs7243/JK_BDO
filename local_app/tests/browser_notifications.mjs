import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const root = new URL("../../", import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), "bdo-notices-"));
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
  const guarded = () => page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(await guarded(), false, "clean startup does not ask about changes");
  await page.locator("#open-settings").click();
  const speed = page.locator("#ship-speed");
  const original = await speed.inputValue();
  await speed.fill(String(Number(original) + 1));
  assert.equal(await guarded(), true, "an actual unsaved setting stays protected");
  await speed.fill(original);
  assert.equal(await guarded(), false, "reverting a setting clears the guard");
  await speed.fill(String(Number(original) + 2));
  await page.locator("#ship-root button").click();
  await idle();
  await page.waitForFunction(() => document.querySelector("#runtime-status").textContent.includes("선박 설정 저장을 확인"));
  assert.equal(await guarded(), false, "successfully saved settings do not ask again");

  await page.evaluate(() => {
    const select = document.createElement("select");
    select.innerHTML = '<option value="speed">쾌속</option><option value="balance">균형</option>';
    document.querySelector("#settings-dialog").append(select);
    select.focus(); select.value = "balance";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.id = "view-only-test";
  });
  assert.equal(await guarded(), false, "a dialog view selector is not an unsaved editor");
  await page.evaluate(() => document.querySelector("#view-only-test").remove());
  await page.locator("#settings-dialog [data-close-dialog]").click();
  await page.evaluate(() => { document.querySelector("#trade-json-input").value = '[{"island":"test"}]'; });
  assert.equal(await guarded(), true, "unapplied JSON stays protected even without focus");
  await page.evaluate(() => { document.querySelector("#trade-json-input").value = "  "; });
  assert.equal(await guarded(), false, "cleared/applied JSON does not leave a stale warning");

  const baseline = await page.evaluate(() => fetch("/api/bootstrap").then(r => r.json()));
  await page.evaluate(() => runAlgorithmAllModes());
  await page.locator(".app-notice").waitFor();
  assert.match(await page.locator(".app-notice p").textContent(), /교환 리스트가 비어/);
  await page.locator(".app-notice-close").click();
  assert.equal(await page.locator(".app-notices").evaluate(node => node.matches(":popover-open")), false);
  await page.locator("#open-settings").click();
  await page.evaluate(() => window.BDONotifications.notice("교섭력이 부족합니다.\n설정에서 확인하세요. <b>원문</b>", "warning"));
  await page.locator(".app-notice").waitFor();
  assert.equal(await page.locator(".app-notice p b").count(), 0, "messages render as text");
  assert.equal(await page.locator(".app-notice-close").evaluate(node => {
    const r = node.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === node;
  }), true, "notice remains readable and clickable above a modal");
  for (const width of [1600, 800]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => { document.body.style.zoom = "1.3"; });
    const rect = await page.locator(".app-notice").boundingBox();
    assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1, `notice fits viewport ${width}`);
  }
  await page.locator(".app-notice-close").click();
  await page.evaluate(async () => {
    const root = document.querySelector("#tuning-root");
    const field = root.querySelector("input");
    field.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    field.value = String(Number(field.value) + 1);
    const { markDraftSaved } = await import("/assets/js/leave-guard.js");
    markDraftSaved(root);
  });
  assert.equal(await guarded(), false, "applied temporary tuning does not retain an old baseline");
  const after = await page.evaluate(() => fetch("/api/bootstrap").then(r => r.json()));
  assert.deepEqual(after, baseline, "displaying notices and changing view controls do not write data");
  assert.deepEqual(nativeDialogs, [], "scheduler warnings no longer open native alerts");
  assert.deepEqual(errors, []);
  console.log("PASS: notifications, modal visibility, narrow/zoom layout, saved/unsaved/view-only leave guards; isolated SQLite");
} finally {
  await browser?.close();
  server.kill();
  if (server.exitCode === null) await new Promise(resolve => server.once("exit", resolve));
  await rm(temporary, { recursive: true, force: true });
}

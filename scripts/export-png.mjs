#!/usr/bin/env node
/**
 * 把画板导成 PNG，直接落到本地文件。
 *
 * 顶栏那个「导出 PNG」是浏览器下载：文件名只写在 <a download> 上，href 是个
 * 不透明的 blob: URL。谁不认这个属性，谁就只能拿 blob 的 UUID 当文件名——
 * 于是就出现了「下载下来没有 .png 后缀、还找不着文件」。最容易踩的是被
 * Playwright / CDP 接管着的那个 Chrome（--user-data-dir=~/.chrome-cdp）：
 * 只要自动化连着，浏览器里所有下载都被它劫到临时目录，名字换成 UUID，
 * 除非自动化那边显式 saveAs。人手点的那次也一样会被劫走。
 *
 * 所以批量导出别走那个浏览器。这个脚本自己起一个干净的无头 Chromium，
 * 走同一条导出链路（同一份截图代码、同一个文件名），落盘时按建议名写文件。
 *
 *   node scripts/export-png.mjs b_xxx b_yyy          导指定的几块板
 *   node scripts/export-png.mjs --group "Agent 体系"  导某个分组
 *   node scripts/export-png.mjs --all                导全部
 *
 * 选项：
 *   --out DIR      落盘目录（默认 ~/Downloads/画板导出-YYYY-MM-DD）
 *   --base URL     画板服务地址（默认 http://127.0.0.1:8567）
 *   --settle MS    截图前等版面稳定的时间（默认 3000，图多的板可以调大）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

const base = (option("--base", "http://127.0.0.1:8567") || "").replace(/\/+$/, "");
const settle = Number(option("--settle", 3000));
const group = option("--group", null);
const all = args.includes("--all");
const stamp = new Date().toISOString().slice(0, 10);
const outDir = path.resolve(option("--out", path.join(os.homedir(), "Downloads", `画板导出-${stamp}`)));
// 位置参数就是板 id；选项的值不能被当成板 id 收进来
const optionValues = new Set(["--out", "--base", "--group", "--settle"].map((n) => option(n, null)));
const wanted = args.filter((a) => a.startsWith("b_") && !optionValues.has(a));

if (!wanted.length && !group && !all) {
  console.error("要导哪块板？给板 id（b_ 开头），或用 --group / --all。详见脚本头部注释。");
  process.exit(2);
}

/** 拉板列表：--group / --all 要靠它，指定 id 时也用它拿板名做提示 */
async function listBoards() {
  const response = await fetch(`${base}/api/boards`);
  if (!response.ok) throw new Error(`画板服务没响应（${response.status}）：${base}`);
  const body = await response.json();
  return body.boards || [];
}

const { chromium } = await import("@playwright/test").catch(() => {
  console.error("缺 @playwright/test（devDependency）。先 npm install，再 npx playwright install chromium。");
  process.exit(2);
});

const boards = await listBoards().catch((error) => {
  console.error(`✗ ${error.message}`);
  process.exit(1);
});
const byId = new Map(boards.map((board) => [board.id, board]));
const missing = wanted.filter((id) => !byId.has(id));
if (missing.length) {
  console.error(`没有这几块板：${missing.join("、")}`);
  process.exit(1);
}
const targets = all ? boards : group ? boards.filter((board) => board.group === group) : wanted.map((id) => byId.get(id));

if (!targets.length) {
  console.error(group ? `没有分组叫「${group}」。` : "没找到要导的板。");
  process.exit(1);
}

function uniquePath(file) {
  const ext = path.extname(file);
  const stem = file.slice(0, -ext.length || undefined);
  let candidate = file;
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = `${stem}(${n})${ext}`;
  return candidate;
}

fs.mkdirSync(outDir, { recursive: true });
console.log(`导出 ${targets.length} 块板 → ${outDir}\n`);

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } });
const failures = [];
const skipped = [];

for (const [index, board] of targets.entries()) {
  const label = `[${index + 1}/${targets.length}] ${board.name}`;
  // 空板没什么可截的，别让它在那儿等选择器超时
  if (board.counts && !board.counts.cards) {
    console.log(`· ${label} → 画板还是空的，跳过`);
    skipped.push(board.name);
    continue;
  }
  const page = await context.newPage();
  try {
    await page.goto(`${base}/?board=${board.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".react-flow__node", { timeout: 60_000 });
    // 图片 / mermaid / svg 卡是渲完才进 DOM 的，等一手再截，否则图上会有空卡
    await page.waitForTimeout(settle);

    await page.locator('.top-btn[aria-label="导出"]').click();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 300_000 }),
      page.locator(".layout-menu .cm-item", { hasText: "导出 PNG" }).click(),
    ]);
    // 文件名用浏览器收到的建议名——和你在页面上点导出拿到的是同一个。
    // 重名会撞（板名截到 40 字、同名板不少），撞了就加序号，别默默覆盖上一张
    const file = uniquePath(path.join(outDir, download.suggestedFilename()));
    await download.saveAs(file);
    const { size } = fs.statSync(file);
    console.log(`✓ ${label} → ${path.basename(file)}（${(size / 1048576).toFixed(1)}MB）`);
  } catch (error) {
    // 空板导不出来是正常结果：画布上的报错文案比 Playwright 的超时有用
    const toast = await page.locator(".toast").first().textContent().catch(() => null);
    console.log(`✗ ${label} → ${toast || error.message.split("\n")[0]}`);
    failures.push(board.name);
  } finally {
    await page.close();
  }
}

await browser.close();
const done = targets.length - failures.length - skipped.length;
console.log(`\n完成：${done} 成功，${skipped.length} 跳过，${failures.length} 失败。`);
if (failures.length) {
  console.log(`失败的：${failures.join("、")}`);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * 性能对照基准：拿同一块板，量「首屏 / 切板 / 静置轮询 / 写盘」四件事。
 *
 * 单实例：
 *   node scripts/bench-perf.mjs --board b_xxx
 * 改造前后对照（两个实例跑同一份数据）：
 *   node scripts/bench-perf.mjs --board b_xxx --base http://127.0.0.1:8567 --against http://127.0.0.1:8568
 * （--base 默认就是 8567；对照的那一端自己起在别的口上——端口被占会自动顺延，实际口见 `<data>/port`）
 *
 * 浏览器部分要 playwright（devDependency 已有）；只想看服务端数字就加 --no-browser。
 */
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const base = opt("base", "http://127.0.0.1:8567").replace(/\/+$/, "");
const against = opt("against", "");
const idleSeconds = Number(opt("idle", 35));
const withBrowser = !args.includes("--no-browser");
const HEADERS = { "content-type": "application/json", "x-board-web": "1" };

async function pickBoard(root) {
  const explicit = opt("board", "");
  if (explicit) return explicit;
  const { boards } = await fetch(`${root}/api/boards`, { headers: HEADERS }).then((r) => r.json());
  // 默认挑卡片最多的那块——性能问题都在大板上
  return [...boards].sort((a, b) => (b.counts?.cards || 0) - (a.counts?.cards || 0))[0]?.id;
}

/** 服务端：响应体积（压缩前后）、条件拉取、写盘耗时、写盘期间的并发读延迟。 */
async function serverSide(root, boardId) {
  const bytes = async (headers) => {
    const res = await fetch(`${root}/api/boards/${boardId}`, { headers });
    const buf = await res.arrayBuffer();
    const encoding = res.headers.get("content-encoding") || "无";
    // fetch 会自动解压，buf 拿到的是解压后的大小；要看真正过网的字节得读 content-length
    const wire = Number(res.headers.get("content-length") || 0);
    return { size: encoding === "无" || !wire ? buf.byteLength : wire, encoding };
  };
  const plain = await bytes({ ...HEADERS, "accept-encoding": "identity" });
  const packed = await bytes({ ...HEADERS, "accept-encoding": "gzip" });

  const board = await fetch(`${root}/api/boards/${boardId}`, { headers: HEADERS }).then((r) => r.json());
  const since = board.board.updatedAt;
  const probe = await fetch(`${root}/api/boards/${boardId}?since=${since}`, { headers: HEADERS });
  const probeBody = await probe.text();

  const time = async (fn) => {
    const start = Date.now();
    await fn();
    return Date.now() - start;
  };
  const write = () =>
    fetch(`${root}/api/boards/${boardId}/state`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ viewport: board.board.viewport || { x: 0, y: 0, zoom: 1 } }),
    }).then((r) => r.json());
  await write();
  const writes = [];
  for (let i = 0; i < 5; i += 1) writes.push(await time(write));

  const read = () => fetch(`${root}/api/boards`, { headers: HEADERS }).then((r) => r.arrayBuffer());
  const idleRead = await time(read);
  const inflight = write();
  await new Promise((resolve) => setTimeout(resolve, 2));
  const blocked = await Promise.all([time(read), time(read), time(read)]);
  await inflight;

  return {
    plainKB: Math.round(plain.size / 1024),
    packedKB: Math.round(packed.size / 1024),
    encoding: packed.encoding,
    probeBytes: probeBody.length,
    writeMs: writes,
    idleReadMs: idleRead,
    blockedReadMs: blocked,
  };
}

/** 浏览器：首屏就绪、首屏 JS/API 流量、画布 DOM 节点数、静置时的轮询开销。 */
async function browserSide(root, boardId) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const started = Date.now();
  await page.goto(`${root}/?board=${boardId}`, { waitUntil: "networkidle" });
  const firstPaint = Date.now() - started;
  await page.waitForTimeout(1500);
  const load = await page.evaluate(() => {
    const res = performance.getEntriesByType("resource");
    const sum = (match) =>
      Math.round(res.filter(match).reduce((total, r) => total + (r.transferSize || r.encodedBodySize || 0), 0) / 1024);
    return {
      jsKB: sum((r) => r.name.includes("/_next/static/chunks")),
      apiKB: sum((r) => r.name.includes("/api/")),
      apiReqs: res.filter((r) => r.name.includes("/api/")).length,
      nodes: document.querySelectorAll(".react-flow__node").length,
    };
  });
  await page.evaluate(() => {
    window.__benchMark = performance.getEntriesByType("resource").length;
    window.__benchAt = performance.now();
  });
  await page.waitForTimeout(idleSeconds * 1000);
  const idle = await page.evaluate(() => {
    const res = performance.getEntriesByType("resource").slice(window.__benchMark).filter((r) => r.name.includes("/api/"));
    const seconds = (performance.now() - window.__benchAt) / 1000;
    const kb = res.reduce((total, r) => total + (r.transferSize || r.encodedBodySize || 0), 0) / 1024;
    return { reqs: res.length, perMinKB: Math.round((kb / seconds) * 60) };
  });
  await browser.close();
  return { firstPaint, ...load, idle };
}

async function report(root, boardId, label) {
  const server = await serverSide(root, boardId);
  console.log(`\n【${label}】${root}  画板 ${boardId}`);
  console.log(`  整板响应        ${server.plainKB} KB → ${server.packedKB} KB（content-encoding: ${server.encoding}）`);
  console.log(`  条件拉取无变化   ${server.probeBytes} 字节`);
  console.log(`  PUT /state      ${server.writeMs.join(", ")} ms`);
  console.log(`  只读延迟        空闲 ${server.idleReadMs} ms / 写盘期间 ${server.blockedReadMs.join(", ")} ms`);
  if (!withBrowser) return;
  const ui = await browserSide(root, boardId);
  console.log(`  首屏就绪        ${ui.firstPaint} ms`);
  console.log(`  首屏 JS / API   ${ui.jsKB} KB / ${ui.apiKB} KB（${ui.apiReqs} 次请求）`);
  console.log(`  画布 DOM 节点    ${ui.nodes}`);
  console.log(`  静置轮询        ${ui.idle.perMinKB} KB/分钟（${ui.idle.reqs} 次 / ${idleSeconds}s）`);
}

const boardId = await pickBoard(base);
if (!boardId) throw new Error("没有可测的画板，用 --board 指定");
await report(base, boardId, "本次");
if (against) await report(against.replace(/\/+$/, ""), boardId, "对照");
console.log("");

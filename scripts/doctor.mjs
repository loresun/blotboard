#!/usr/bin/env node
/**
 * 一键诊断（`npm run doctor`）——**用着用着出问题时**跑的那条命令。
 *
 * 与 `npm run check` 的分工：check 管「代码对不对」（提交前跑），doctor 管
 * 「这台跑着的画板现在是什么状态」（出问题时跑）。输出是一份可以**直接贴进 issue**
 * 的 Markdown：报告里该有的东西一次给全，省掉「你先 curl 一下 health / 看看日志 /
 * 数数板子」这三四个来回。
 *
 * 三条硬约束：
 *  1. **只读**。一个字节都不写画板的数据目录——排障工具把现场改坏是最糟的结局。
 *  2. **不打印 token 本身**，只报「生效 token 来自哪一类来源」（env / 共用 settings /
 *     数据目录自管）。报告是要贴到公开 issue 里去的（红线 9）。
 *  3. **本机绝对路径按 `~` 折叠**。同上：贴出去的东西不该暴露这台机器的目录结构。
 *
 * 用法：
 *   node scripts/doctor.mjs                        自动发现地址
 *   node scripts/doctor.mjs --base http://…:8567   指定地址
 *   BLOTBOARD_URL=… node scripts/doctor.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkWebAssets } from "./check-web-assets.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = os.homedir();

/* ── 地址发现：与 MCP server（bin/blotboard-mcp.mjs）同一套三级逻辑 ────────
   env BLOTBOARD_URL → `<数据目录>/port`（画板启动时写的**实际落位**端口，
   默认 8567 被占会顺延）→ 默认 8567。少了中间那级，端口一顺延这里就诊断了个空。 */
function resolveBase() {
  const argIndex = process.argv.indexOf("--base");
  if (argIndex >= 0 && process.argv[argIndex + 1]) {
    return { base: process.argv[argIndex + 1].replace(/\/+$/, ""), from: "--base 参数" };
  }
  if (process.env.BLOTBOARD_URL) {
    return { base: process.env.BLOTBOARD_URL.replace(/\/+$/, ""), from: "环境变量 BLOTBOARD_URL" };
  }
  const candidates = [
    process.env.BLOTBOARD_DATA_DIR ? path.join(path.resolve(process.env.BLOTBOARD_DATA_DIR), "port") : null,
    path.join(process.cwd(), "data", "port"),
    path.join(ROOT, "data", "port"),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      const port = Number(fs.readFileSync(file, "utf8").trim());
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        return { base: `http://127.0.0.1:${port}`, from: `${tilde(file)}（画板启动时写的实际端口）` };
      }
    } catch {
      /* 下一个候选 */
    }
  }
  return { base: "http://127.0.0.1:8567", from: "默认端口（没找到 port 文件）" };
}

/** 本机绝对路径折叠成 `~/…`：报告要贴到公开 issue 里，不该带出目录结构。 */
function tilde(value) {
  if (typeof value !== "string") return value;
  return HOME && value.startsWith(HOME) ? `~${value.slice(HOME.length)}` : value;
}

/**
 * 本机数据目录里的 token（找不到就 null）。
 *
 * 只用来**读**：`/api/health` 的绝对路径字段只发给带 token 的调用方
 * （见 app/api/health/route.ts 的理由），带上它诊断才看得到数据目录与磁盘那几项。
 * 诊断远程实例时这里自然是 null，报告照旧降级——那条分支本来就在。
 * 红线不变：token **只用于请求头，永不进报告**（红线 9）。
 */
function localToken() {
  const candidates = [
    process.env.BLOTBOARD_TOKEN || null,
    process.env.BLOTBOARD_INTERNAL_TOKEN || null,
    process.env.BLOTBOARD_DATA_DIR ? path.join(path.resolve(process.env.BLOTBOARD_DATA_DIR), "token") : null,
    path.join(process.cwd(), "data", "token"),
    path.join(ROOT, "data", "token"),
  ].filter(Boolean);
  for (const item of candidates) {
    if (!path.isAbsolute(item)) return item; // env 给的是 token 本身，不是路径
    try {
      const value = fs.readFileSync(item, "utf8").trim();
      if (value) return value;
    } catch {
      /* 下一个候选 */
    }
  }
  return null;
}

const TOKEN = localToken();

/**
 * 只对**回环地址**带 token。
 *
 * 诊断可以指向别人的画板（`--base http://100.x.x.x:8567`），而 token 是本机的秘密——
 * 无差别地挂在每个请求上，等于把自己的钥匙送给被诊断的那台机器。
 * 绝对路径那几项本来也只有「同一台机器」才有意义，范围正好对上。
 */
function sendsToken(base) {
  if (!TOKEN) return false;
  try {
    const host = new URL(base).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "127.0.0.1" || host === "::1" || host === "localhost" || /^127\./.test(host);
  } catch {
    return false;
  }
}

async function getJson(base, url, { method = "GET", body, timeoutMs = 4000 } = {}) {
  try {
    const headers = {};
    if (body) headers["content-type"] = "application/json";
    if (sendsToken(base)) headers["x-auth-key"] = TOKEN;
    const response = await fetch(`${base}${url}`, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* 非 JSON 响应：只留状态码 */
    }
    return { status: response.status, data };
  } catch (error) {
    return { status: 0, data: null, error: String(error?.message || error) };
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatTime(ms) {
  if (!ms) return "—";
  const delta = Date.now() - ms;
  const mins = Math.round(delta / 60000);
  const rel = mins < 1 ? "刚刚" : mins < 60 ? `${mins} 分钟前` : mins < 1440 ? `${Math.round(mins / 60)} 小时前` : `${Math.round(mins / 1440)} 天前`;
  return `${new Date(ms).toISOString().replace("T", " ").slice(0, 19)} UTC（${rel}）`;
}

/** 目录递归占用与文件数。**只 stat 不读内容**，几百块板也是毫秒级。 */
function dirUsage(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          bytes += fs.statSync(full).size;
          files++;
        } catch {
          /* 正在被删的文件，跳过 */
        }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

/* ── 报告拼装 ─────────────────────────────────────── */

const lines = [];
const out = (line = "") => lines.push(line);
const kv = (key, value) => out(`| ${key} | ${value} |`);

async function main() {
  const { base, from } = resolveBase();
  out("## Blotboard 诊断报告");
  out("");
  out(`采集时间：\`${new Date().toISOString()}\`　·　诊断脚本 Node \`${process.version}\`　·　平台 \`${process.platform}/${process.arch}\``);
  out("");

  const health = await getJson(base, "/api/health");
  if (health.status !== 200 || !health.data) {
    out(`### ✗ 连不上画板`);
    out("");
    out(`| | |`);
    out(`| --- | --- |`);
    kv("试的地址", `\`${base}\``);
    kv("地址来自", from);
    kv("结果", health.status ? `HTTP ${health.status}` : `请求失败：\`${health.error || "无响应"}\``);
    out("");
    out("按这个顺序查（每一步都能独立确认）：");
    out("");
    out("1. **服务在跑吗**：`pm2 list`（或看你自己的启动方式）；没起就 `npm run build && npm start`。");
    out("2. **端口是不是顺延了**：默认 8567 被占会自动往后排。真实端口有三个来源——");
    out("   `<数据目录>/port` 文件、启动日志、`GET /api/health` 的 `port` 字段。");
    out("   拿到之后 `node scripts/doctor.mjs --base http://127.0.0.1:<真实端口>` 再来一次。");
    out("3. **是不是被地址闸门挡了**：server.mjs 只放行本机 / 私网 / Tailscale 直连，");
    out("   其余一律 403（此时上面会显示 `HTTP 403` 而不是请求失败）。从别的机器诊断请走内网地址。");
    out("4. **进程起来了但一直 500**：`pm2 logs blotboard --lines 50`；");
    out("   数据目录里有坏板文件时服务照常起，但 `/api/health` 的 `brokenBoards` 会点名是哪几个。");
    out("");
    console.log(lines.join("\n"));
    process.exitCode = 1;
    return;
  }

  const caps = await getJson(base, "/api/capabilities");
  const info = health.data;
  const capsData = caps.data || {};

  /* 数据目录：health 给的是 boards 目录（`<data>/boards`），数据根是它的上一级 */
  const boardsDir = info.dataDir || "";
  const dataRoot = boardsDir ? path.dirname(boardsDir) : "";
  const local = boardsDir && fs.existsSync(boardsDir); // 诊断脚本与画板在同一台机器上时才看得到磁盘

  out("### 概览");
  out("");
  out("| 项 | 值 |");
  out("| --- | --- |");
  kv("服务", `${info.service} \`${capsData.version || "?"}\``);
  kv("地址", `\`${base}\`（${from}）`);
  kv("端口", `配置 \`${info.port}\`　·　实际落位 \`${new URL(base).port || "80"}\`${String(info.port) !== (new URL(base).port || "80") ? " ← **不一致**，多半是端口被占后顺延了" : ""}`);
  kv(
    "数据目录",
    dataRoot
      ? `\`${tilde(dataRoot)}\`${local ? "" : "（诊断脚本不在同一台机器上，磁盘相关项跳过）"}`
      : "—（没带上 token，`/api/health` 不下发绝对路径；本机诊断请在数据目录旁边跑，或设 `BLOTBOARD_TOKEN`。磁盘相关项跳过）",
  );
  kv("token 生效源", describeTokenSource(info.tokenSource, info.tokenConfigured));
  kv("Node（诊断脚本）", `\`${process.version}\``);
  out("");

  out("### 画板数据");
  try {
    const web = await checkWebAssets(base);
    out("");
    out(`前端资源：${web.ok ? `✓ ${web.assets.length} 个 JS/CSS 均可加载，MIME 正确` : "✗ 页面或 JS/CSS 不可用（health 正常不代表界面正常）"}`);
    for (const asset of web.assets.filter((item) => !item.ok)) out(`- \`${asset.path}\`：HTTP ${asset.status}，类型 \`${asset.type || "无"}\``);
    if (!web.ok) {
      out("若刚构建过：停止旧进程后启动当前构建，再刷新浏览器；见 docs/DEPLOYMENT.md。");
      process.exitCode = 1;
    }
  } catch {
    out("前端资源：✗ 页面访问失败或超时。");
    process.exitCode = 1;
  }
  out("");
  out("| 项 | 值 |");
  out("| --- | --- |");
  kv("画板数", `${info.boards}`);
  const broken = info.brokenBoards || [];
  kv(
    "坏板文件",
    broken.length
      ? `**${broken.length} 个**：${broken.map((name) => `\`${name}\``).join("、")}　←　这几个文件 JSON 解析不了，服务照常起但它们读不出来`
      : "无",
  );
  if (local) {
    let newest = 0;
    let boardFiles = 0;
    try {
      for (const entry of fs.readdirSync(boardsDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        boardFiles++;
        const stat = fs.statSync(path.join(boardsDir, entry.name));
        if (stat.mtimeMs > newest) newest = stat.mtimeMs;
      }
    } catch {
      /* 读不了就留 0 */
    }
    kv("板文件数（含 `_index.json`）", `${boardFiles}`);
    kv("最近一次写入", formatTime(newest));
    const boards = dirUsage(boardsDir);
    kv("板目录占用", `${formatBytes(boards.bytes)}`);

    /* 快照：目录默认在 `<data>/checkpoints`；被 BLOTBOARD_CHECKPOINTS_DIR 挪走时这里会找不到 */
    const cpDir = path.join(dataRoot, "checkpoints");
    if (fs.existsSync(cpDir)) {
      const usage = dirUsage(cpDir);
      let orphans = 0;
      let boardsWithSnapshots = 0;
      for (const entry of fs.readdirSync(cpDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        boardsWithSnapshots++;
        if (!fs.existsSync(path.join(boardsDir, `${entry.name}.json`))) orphans++;
      }
      kv("快照占用", `${formatBytes(usage.bytes)}（${usage.files} 个文件，覆盖 ${boardsWithSnapshots} 块板）`);
      kv(
        "孤儿快照目录",
        orphans
          ? `${orphans} 个（对应的画板已经删了）　·　超过 \`BLOTBOARD_CHECKPOINT_ORPHAN_TTL_DAYS\`（默认 30 天）会自动清`
          : "0",
      );
    } else {
      kv("快照", "没找到 `<数据目录>/checkpoints`（快照关了，或被 `BLOTBOARD_CHECKPOINTS_DIR` 指到别处）");
    }
    try {
      const stat = fs.statfsSync(dataRoot);
      const free = stat.bavail * stat.bsize;
      const total = stat.blocks * stat.bsize;
      kv("磁盘余量", `${formatBytes(free)} / ${formatBytes(total)}（余 ${((free / total) * 100).toFixed(1)}%）${free < 500 * 1024 * 1024 ? "　←　**快满了**，原子写会失败" : ""}`);
    } catch {
      kv("磁盘余量", "—（拿不到 statfs）");
    }
  }
  out("");

  out("### 功能与集成");
  out("");
  out("| 能力 | 配置 | 可达性 |");
  out("| --- | --- | --- |");
  const features = info.features || {};
  const backend = capsData.tasks?.backend || (features.tasks ? "?" : "—");
  out(
    `| 任务后端 | \`${backend}\` | ${
      backend === "local"
        ? "内置本地后端，恒可用（不需要外部服务）"
        : info.runner
          ? "✓ 探得到"
          : "✗ **配了但探不到**——外部 Runner 挂了或地址写错；此时转 Issue / 发起任务会 502"
    } |`,
  );
  const aidocs = features.search
    ? await getJson(base, "/api/aidocs/search", { method: "POST", body: { query: "blotboard-doctor", limit: 1 } })
    : null;
  out(`| 知识库（资料卡） | ${features.search ? "`AIDOCS_URL` 已配" : "未配置 → 入口整个隐藏"} | ${describeProbe(features.search, aidocs)} |`);
  const books = features.library ? await getJson(base, "/api/books?q=blotboard-doctor") : null;
  out(`| 书库（图书卡） | ${features.library ? "`BOOK_LIBRARY_URL` 已配" : "未配置 → 入口整个隐藏"} | ${describeProbe(features.library, books)} |`);
  out("");

  const packs = capsData.cards || [];
  const enabled = packs.filter((pack) => pack.enabled);
  out("### 卡片包与规格");
  out("");
  out("| 项 | 值 |");
  out("| --- | --- |");
  kv("启用的卡片包", `${enabled.length} / ${packs.length}`);
  if (enabled.length) kv("启用清单", enabled.map((pack) => `\`${pack.type}\``).join(" "));
  const off = packs.filter((pack) => !pack.enabled);
  if (off.length) kv("停用的包", `${off.map((pack) => `\`${pack.type}\``).join(" ")}　（停用只挡新建，已有卡片照常显示与导出）`);
  kv("卡片规格", `启用 ${capsData.specs?.enabled?.length ?? "?"} / 共 ${capsData.specs?.total ?? "?"} 份`);
  kv(
    "改板安全网（快照）",
    capsData.checkpoints?.enabled
      ? `开，每块板留最近 ${capsData.checkpoints.keep} 份`
      : "**关**（`BLOTBOARD_CHECKPOINT_KEEP=0`）——批量改板前不会自动留底",
  );
  out("");

  out("<details><summary>原始 /api/health 与 /api/capabilities（已去掉密钥类字段）</summary>");
  out("");
  out("```json");
  out(JSON.stringify({ health: redact(info), capabilities: redact(capsData) }, null, 2));
  out("```");
  out("");
  out("</details>");

  console.log(lines.join("\n"));
}

function describeTokenSource(source, configured) {
  if (!configured) return "**没有可用 token**——写操作会一律 403；首次启动本该在 `<数据目录>/token` 自动生成一份，检查那个目录的写权限";
  const map = {
    env: "环境变量 `BLOTBOARD_INTERNAL_TOKEN`（服务启动时已同步进 `<数据目录>/token`）",
    "goal-agent-settings": "与任务后端共用（`BLOTBOARD_GOAL_AGENT_SETTINGS` 指向的 settings.json 里的 `internalApiToken`），同样同步进 `<数据目录>/token`",
    "data-dir": "数据目录自管（`<数据目录>/token`，首启自动生成）",
  };
  // 只报来源类型，永不打印值：agent 全员 403 那次的根因就是「拿的 token 与生效的 token 不是一份」，
  // 知道「生效的那份来自哪」就够定位，值本身没有任何诊断价值
  return `${map[source] || `\`${source}\``}　·　**值不打印**（自己 cat 那个文件看）`;
}

function describeProbe(configured, probe) {
  if (!configured) return "—";
  if (!probe) return "—";
  if (probe.status === 200) return "✓ 探得到";
  if (probe.status === 503) return "配置了却回 503——服务端认为没配（检查环境变量有没有真的传进进程）";
  if (probe.status === 0) return `✗ 请求本身失败：\`${probe.error}\``;
  return `✗ HTTP ${probe.status}${probe.status === 502 ? "——**地址配了但对端连不上**（服务挂了 / 地址写错 / 网络不通）" : ""}`;
}

/** 原始 JSON 里可能出现的密钥类字段一律抹掉；绝对路径折叠成 `~`。 */
function redact(value) {
  const secretish = /token|secret|key|password/i;
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const acc = {};
      for (const [key, item] of Object.entries(node)) {
        // tokenSource / tokenConfigured 是**结论**不是值，保留；其余带 token 字样的一律遮掉
        if (secretish.test(key) && !["tokenSource", "tokenConfigured"].includes(key) && typeof item === "string" && item.length > 8) {
          acc[key] = "<已遮蔽>";
        } else acc[key] = walk(item);
      }
      return acc;
    }
    return typeof node === "string" ? tilde(node) : node;
  };
  return walk(value);
}

main().catch((error) => {
  console.error(`诊断脚本自己出错了：${error?.stack || error}`);
  process.exit(1);
});

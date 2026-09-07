/**
 * blotboard 自定义 server：Next 之前只做一件事——「只接受本机 / 可信局域网直连」的地址闸门。
 *
 * 为什么不用 Next middleware：闸门必须看 TCP 连接的真实 remoteAddress，
 * middleware 只拿得到可伪造的 x-forwarded-for（Next 15 起 request.ip 也已移除）。
 * 判断就在下面的 isTrustedClientAddress：本机 / 私网 / Tailscale(100.64.0.0/10) / 链路本地
 * 放行，其余一律 403（`BLOTBOARD_ALLOW_PUBLIC_DIRECT=1` 可整个关掉这道闸门）。
 *
 *   node server.mjs          生产（先 npm run build）
 *   node server.mjs --dev    开发（Next dev，带 HMR）
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import next from "next";
import { ensureExcalidrawAssets } from "./scripts/sync-excalidraw-assets.mjs";
import { claimProductionServer } from "./scripts/build-guard.mjs";

const dev = process.argv.includes("--dev") || process.env.NODE_ENV === "development";
const wantedPort = Number(process.env.BLOTBOARD_PORT || 8567);
/** 端口被占时最多往后试几个（0 / BLOTBOARD_PORT_STRICT=1 = 不顺延，占了就报错退出）。 */
const portTries = process.env.BLOTBOARD_PORT_STRICT === "1" ? 1 : Math.max(1, Number(process.env.BLOTBOARD_PORT_TRIES || 10));
const hostname = process.env.BLOTBOARD_HOST || "127.0.0.1";
const allowPublicDirect = process.env.BLOTBOARD_ALLOW_PUBLIC_DIRECT === "1";

/**
 * 端口落位：想要的那个被占就往后顺延（8567 → 8568 → …）。
 *
 * 为什么先拿一个空 server 探而不是直接 listen 真服务：真服务的端口在 `next({ port })`
 * 与 `process.env.BLOTBOARD_PORT`（lib/config.ts 据此算 PUBLIC_URL、health 的 port）
 * 那里已经被读走了，等 listen 失败再改就晚了——探完再把结果写回环境变量，
 * 全进程只认同一个数。探测与真 listen 之间理论上有一瞬空窗，本机自用可以接受。
 *
 * 测试用 BLOTBOARD_PORT_STRICT=1 关掉顺延：那边端口是自己挑的，
 * 悄悄换一个只会让断言打在空处，不如当场报错。
 */
async function resolvePort(preferred, tries, host) {
  // 绑 0.0.0.0 时要连 127.0.0.1 一起探：macOS/Linux 上「别人占了 127.0.0.1:P」并不妨碍
  // 我们绑上 0.0.0.0:P，但之后走 127.0.0.1 的请求会落到那个更具体的绑定上——
  // 服务看着起来了，用户与 agent 却打不通。这种「起来了但不通」比直接报占用更难查。
  const hosts = ["0.0.0.0", "::", ""].includes(host) ? [host, "127.0.0.1"] : [host];
  const canBind = (port, on) =>
    new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port, on);
    });
  for (let candidate = preferred; candidate < preferred + tries; candidate += 1) {
    let free = true;
    for (const on of hosts) {
      if (!(await canBind(candidate, on))) {
        free = false;
        break;
      }
    }
    if (free) {
      if (candidate !== preferred) {
        console.log(`[blotboard] ${preferred} 被占用，改用 ${candidate}（自动顺延；BLOTBOARD_PORT_STRICT=1 可关掉）`);
      }
      return candidate;
    }
    if (tries === 1) break;
  }
  throw new Error(
    tries === 1
      ? `端口 ${preferred} 被占用（BLOTBOARD_PORT_STRICT=1 时不顺延）`
      : `${preferred}–${preferred + tries - 1} 全被占用，换个 BLOTBOARD_PORT 再来`,
  );
}

/** 本机 / 私网 / Tailscale(100.64.0.0/10) / 链路本地 视为可信。 */
export function isTrustedClientAddress(rawAddress) {
  let address = String(rawAddress || "").trim().toLowerCase();
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (address === "::1" || address === "127.0.0.1") return true;
  if (/^10\./.test(address) || /^192\.168\./.test(address) || /^169\.254\./.test(address)) return true;
  const match100 = /^100\.(\d{1,3})\./.exec(address);
  if (match100 && Number(match100[1]) >= 64 && Number(match100[1]) <= 127) return true;
  const match172 = /^172\.(\d{1,3})\./.exec(address);
  if (match172 && Number(match172[1]) >= 16 && Number(match172[1]) <= 31) return true;
  return address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd");
}

/**
 * CSP 的 frame-src（html 嵌入卡的纵深防御第二层）。
 *
 * 真正的闸门是**写入时**的域白名单（lib/embed-allow.ts + board-schema 的 normalizeHtmlField）：
 * 地址不在白名单里的卡片根本存不进去。这里只是再拦一道「页面上凭空冒出来的 iframe」。
 *
 * 默认的 `@private` 枚举不出来——CSP 的 host-source 不支持网段，而私网里的 host 是任意的。
 * 这时**不下发 frame-src**：与其写一条 `frame-src *` 假装有防护，不如老实承认
 * 这一层只在「白名单全是具体域名」时才生效。白名单怎么配见 README「HTML 嵌入卡」。
 *
 * 这里只做「规则 → CSP 源」的格式化，不重复实现 host 匹配（那份只在 lib/embed-allow.ts 里）。
 */
function frameSrcFromSpec(spec) {
  const entries = String(spec || "").split(/[\s,]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (!entries.length || entries.includes("@private")) return null;
  const sources = new Set(["'self'"]);
  for (const entry of entries) {
    if (entry === "@none") continue;
    const host = entry.startsWith("*.") ? `*.${entry.slice(2)}` : entry;
    // 条目可以带端口（host:8000）；没带就放行任意端口
    const hasPort = /:\d{1,5}$/.test(host) && !host.includes("]");
    const target = hasPort ? host : `${host}:*`;
    sources.add(`http://${target}`);
    sources.add(`https://${target}`);
    if (entry.startsWith("*.")) {
      const bare = entry.slice(2);
      sources.add(`http://${bare}:*`);
      sources.add(`https://${bare}:*`);
    }
  }
  return [...sources].join(" ");
}

const FRAME_SRC = frameSrcFromSpec(process.env.BLOTBOARD_HTML_ALLOW || "@private");
/**
 * object-src / base-uri 是白给的两条：画板从不用 <object>/<embed>，也从不改 base。
 * 刻意不上 script-src —— Next 的运行时靠 inline script 引导，一上就得整套 nonce 化，
 * 那是另一个量级的改动（真要做，得先把 Next 注入的每段 inline script 都过一遍）。
 */
const CSP = ["frame-ancestors 'self'", "object-src 'none'", "base-uri 'self'", FRAME_SRC ? `frame-src ${FRAME_SRC}` : ""]
  .filter(Boolean)
  .join("; ");

function securityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader("x-frame-options", "SAMEORIGIN");
  res.setHeader("content-security-policy", CSP);
}

/**
 * 开机把「这台部署实际生效的 token」摆到 `<数据目录>/token`。
 *
 * 三级优先级与 lib/config.ts 的 readInternalToken 完全一致（那边是请求期的真源）。
 * 关键在**后两句**：token 生效源可能是环境变量或 Goal Agent 的 settings.json，
 * 但 README / skill / MCP 一律教 agent「cat 数据目录下的 token」——
 * 生效源不是这个文件时，它就成了一份会骗人的旧值，agent 照着拿必然 403（真实踩过）。
 * 所以外部源存在时把生效值**镜像**回这个文件：一处读、处处对；对方轮换 token 后重启即同步。
 * 同机同用户、0600、且数据目录不进 git，镜像的代价可以接受。
 */
function ensureAgentToken() {
  const root = process.env.BLOTBOARD_ROOT ? path.resolve(process.env.BLOTBOARD_ROOT) : process.cwd();
  const dataDir = process.env.BLOTBOARD_DATA_DIR ? path.resolve(process.env.BLOTBOARD_DATA_DIR) : path.join(root, "data");
  const tokenFile = path.join(dataDir, "token");
  const current = (() => {
    try {
      return fs.readFileSync(tokenFile, "utf8").trim();
    } catch {
      return "";
    }
  })();

  // 生效源：env > Goal Agent settings.json > 本文件自管
  let effective = "";
  let source = "";
  if (process.env.BLOTBOARD_INTERNAL_TOKEN) {
    effective = process.env.BLOTBOARD_INTERNAL_TOKEN.trim();
    source = "BLOTBOARD_INTERNAL_TOKEN";
  } else if (process.env.BLOTBOARD_GOAL_AGENT_SETTINGS) {
    const file = path.resolve(process.env.BLOTBOARD_GOAL_AGENT_SETTINGS);
    try {
      effective = String(JSON.parse(fs.readFileSync(file, "utf8")).internalApiToken || "").trim();
    } catch (error) {
      // 读不到不是致命错：记一行就走，别把一个空值覆盖到本来好用的 token 文件上
      console.warn(`[blotboard] 读不到 ${file} 的 internalApiToken（${error?.message || error}）——token 镜像跳过`);
    }
    source = file;
  }

  if (effective) {
    if (current === effective) return;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenFile, `${effective}\n`, { mode: 0o600 });
    console.log(`[blotboard] 生效 token 来自 ${source}，已同步到 ${tokenFile}（agent 照旧 cat 这个文件）`);
    return;
  }

  // 自管形态：首启生成并提示一次——不然要等到第一个带 x-auth-key 的请求才懒生成，
  // 用户装完根本不知道钥匙在哪。
  if (current) return;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tokenFile, `${crypto.randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
  console.log(`[blotboard] 已生成 agent token：${tokenFile}（写 API 请求头 x-auth-key 用它）`);
}

async function main() {
  if (!dev) {
    const release = claimProductionServer(process.cwd());
    process.once("exit", release);
  }
  ensureAgentToken();
  // Excalidraw 的字体走 public/excalidraw-assets（见 lib/excalidraw-assets.ts）。
  // 放在这里而不是 npm 生命周期里：pm2 是直接 `node server.mjs` 起的，不过 npm scripts。
  try {
    const assets = ensureExcalidrawAssets();
    if (assets.synced) console.log(`[blotboard] excalidraw 字体${assets.reason}`);
  } catch (err) {
    console.warn(`[blotboard] excalidraw 字体同步失败（回退 CDN）：${err?.message || err}`);
  }

  // 先把端口敲定并写回环境变量：lib/config.ts 在 Next 里读它算 PUBLIC_URL 与 health.port，
  // 顺延后不同步，agent 拿到的自身地址就会指向一个没人监听的端口
  const port = await resolvePort(wantedPort, portTries, hostname);
  process.env.BLOTBOARD_PORT = String(port);

  const app = next({ dev, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const server = http.createServer((req, res) => {
    securityHeaders(res);
    if (!allowPublicDirect && !isTrustedClientAddress(req.socket?.remoteAddress)) {
      res.writeHead(403, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: "blotboard 只接受本机/可信局域网直连；公网请经本机 SSO 反向代理" }));
      return;
    }
    handle(req, res).catch((err) => {
      console.error("[blotboard] 请求处理失败");
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "服务内部错误" }));
    });
  });

  server.listen(port, hostname, () => {
    console.log(`[blotboard] ${dev ? "dev" : "prod"} 就绪 http://127.0.0.1:${port}（绑定 ${hostname}）`);
    /**
     * 关掉地址闸门是**一句 env 就能做到、却没有任何界面提示**的事，
     * 而 BLOTBOARD_HOST 默认就是 0.0.0.0（监听所有网络接口）。两件事凑一起 =
     * 任何能连到这个端口的人都能读写你的全部画板，画板本身没有账号体系拦得住他。
     * 不做 hard fail：已经把它放在反代 / Tailscale 后面的部署是正当用法，
     * 启动即退出会直接掐掉人家的服务。但必须在日志里喊一嗓子。
     */
    if (allowPublicDirect) {
      const wideOpen = ["0.0.0.0", "::", ""].includes(hostname);
      console.warn("");
      console.warn("[blotboard] ⚠️  BLOTBOARD_ALLOW_PUBLIC_DIRECT=1：IP 闸门已关闭");
      console.warn(`[blotboard] ⚠️  监听地址 ${hostname}${wideOpen ? "（所有网络接口）" : ""} + 闸门关闭`);
      console.warn("[blotboard] ⚠️  = 任何能连到这个端口的人都能读写你的画板（画板没有账号体系）");
      console.warn("[blotboard] ⚠️  正确做法：放在带鉴权的反向代理后面，或只经 Tailscale 访问；");
      console.warn("[blotboard] ⚠️  只想让本机用就把 BLOTBOARD_HOST 设成 127.0.0.1 并去掉这个开关。");
      console.warn("");
    }
    // 顺延之后端口不再是常数，落一份到数据目录：脚本与 agent 不用去翻 pm2 日志
    try {
      const dataDir = process.env.BLOTBOARD_DATA_DIR
        ? path.resolve(process.env.BLOTBOARD_DATA_DIR)
        : path.join(process.env.BLOTBOARD_ROOT ? path.resolve(process.env.BLOTBOARD_ROOT) : process.cwd(), "data");
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, "port"), `${port}\n`);
    } catch {
      /* 写不了不影响服务本身 */
    }
  });

  // 优雅关闭：先停止 accept，再主动掐掉 keep-alive 连接。
  // 只 server.close() 是不够的——浏览器/轮询留下的长连接会把进程吊住，
  // pm2 restart 就会留下一个「不监听端口但还活着」的僵尸，端口从此起不来。
  let closing = false;
  const shutdown = () => {
    if (closing) {
      process.exit(0);
      return;
    }
    closing = true;
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    // 兜底：2 秒内没退干净就硬退（不 unref，确保这个定时器一定会烧到）
    setTimeout(() => process.exit(0), 2000);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, shutdown);
}

main().catch((err) => {
  console.error("[blotboard] 启动失败", err);
  process.exit(1);
});

/**
 * 写操作鉴权（沿用 goal-agent 的两条通道，agent 侧零新概念）：
 *  - 浏览器：sameOrigin + x-board-web: 1（兼容 x-goal-agent-web: 1，老冒烟/老脚本不用改）
 *  - agent / 内部进程：x-auth-key == 内部 token（来源三级见 lib/config.ts readInternalToken）
 *
 * 「只接受本机 / 可信局域网直连」的地址闸门是另一道，在 server.mjs：它要的是 socket 的真实
 * remoteAddress，Next middleware 只拿得到可伪造的 x-forwarded-for，所以放不进这一层。
 */
import crypto from "node:crypto";
import { GOAL_AGENT_SETTINGS_FILE, tryReadInternalToken } from "./config";
import { forbidden } from "./http";
import type { BoardActor } from "./types";

export const WEB_HEADER = "x-board-web";
export const LEGACY_WEB_HEADER = "x-goal-agent-web";

/**
 * 403 的文案得**可操作**：agent 拿 curl 打写接口时并不知道 token 在哪，
 * 撞上一句「写操作校验失败」就只能瞎猜（真实踩坑）。这里把两条通道一次说完。
 *
 * 刻意只说「数据目录下的 token 文件」而不写绝对路径：数据目录可以用
 * BLOTBOARD_DATA_DIR 换位置，报错体是会被转发 / 贴进日志的东西，不该带本机路径。
 * 想知道具体在哪，`GET /api/capabilities` 的 auth 段与 `GET /api/skill` 都讲了。
 */
export const WRITE_AUTH_HINT =
  "写操作需要鉴权：把「数据目录下的 token 文件」的内容作为 x-auth-key 请求头传入" +
  "（数据目录默认是仓库里的 data/，BLOTBOARD_DATA_DIR 可换位置）。" +
  "这个文件永远是对的：token 生效源即使是环境变量或 Goal Agent 的 settings.json，" +
  "服务启动时也会把生效值同步进去——所以别去猜生效源，cat 它就行；" +
  "浏览器同源请求改带 x-board-web: 1。" +
  "生效源是哪个：GET /api/health 的 tokenSource 或 /api/capabilities 的 auth 段；完整用法：GET /api/skill。";

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // 非浏览器 / same-origin GET 不带 Origin
  const host = request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * token 比对走**定长时间**比较。
 *
 * `a === b` 在第一个不同的字节上就返回，逐字节的耗时差是可测的——攻击者拿一个
 * 能连到这个端口的位置反复试，理论上能一个字节一个字节地把 token 猜出来。
 * 画板的鉴权在同一台机器 / 同一个局域网里，网络抖动远大于这点时间差，
 * 实战难度很高；但换成 timingSafeEqual 的代价是零，没有理由把这条留在门上。
 *
 * 长度不同直接 false：timingSafeEqual 长度不等会抛，而「长度」本身不是秘密
 * （token 是固定的 48 位十六进制）。
 */
function tokenEquals(candidate: string, token: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function isAgentRequest(request: Request): boolean {
  const key = request.headers.get("x-auth-key");
  if (!key) return false;
  const token = tryReadInternalToken();
  return Boolean(token) && tokenEquals(key, token as string);
}

export function canWrite(request: Request): boolean {
  if (request.headers.get("x-auth-key")) return isAgentRequest(request);
  const web = request.headers.get(WEB_HEADER) === "1" || request.headers.get(LEGACY_WEB_HEADER) === "1";
  return sameOrigin(request) && web;
}

/**
 * 这次写操作是谁发起的——**从鉴权通道推断**，不看请求体里的自称。
 *
 * 带对了 x-auth-key 的只有 agent / 脚本（token 在磁盘上，浏览器拿不到也不该拿到）；
 * 其余走同源 + x-board-web 的就是页面自己。工作日志的 actor 用它，
 * 所以「谁改的」这一栏伪造不了：改称呼要先改到 token。
 */
export function actorOf(request: Request): BoardActor {
  return isAgentRequest(request) ? "agent" : "user";
}

/** token 到底从哪来（lib/config.ts readInternalToken 的三级）。 */
export type TokenSource = "env" | "goal-agent-settings" | "data-dir";

export interface AuthDescriptor {
  /** 写操作的鉴权头 */
  header: "x-auth-key";
  /** 浏览器同源请求走的头 */
  webHeader: "x-board-web";
  /** 鉴权不过的状态码（不是 401） */
  status: 403;
  source: TokenSource;
  /** token 文件的**相对表述**（绝对路径不进 API 响应，见 WRITE_AUTH_HINT） */
  tokenFile: string | null;
  tokenEnv: string | null;
  hint: string;
}

/**
 * 鉴权自描述：`/api/capabilities` 与 `/api/skill` 共用一份，省得两处口径漂移。
 * tokenFile 一律给相对表述（`<数据目录>/token`），绝不吐绝对路径。
 */
export function describeAuth(): AuthDescriptor {
  const base = { header: "x-auth-key", webHeader: "x-board-web", status: 403 } as const;
  if (process.env.BLOTBOARD_INTERNAL_TOKEN) {
    return {
      ...base,
      source: "env",
      tokenFile: null,
      tokenEnv: "BLOTBOARD_INTERNAL_TOKEN",
      hint: "本部署的 token 由环境变量 `BLOTBOARD_INTERNAL_TOKEN` 指定；服务启动时已把它同步进 `<数据目录>/token`，直接 cat 那个文件即可。",
    };
  }
  if (GOAL_AGENT_SETTINGS_FILE) {
    return {
      ...base,
      source: "goal-agent-settings",
      tokenFile: "<BLOTBOARD_GOAL_AGENT_SETTINGS 指向的 settings.json>.internalApiToken",
      tokenEnv: "BLOTBOARD_GOAL_AGENT_SETTINGS",
      hint: "本部署与 Goal Agent 共用 token（`BLOTBOARD_GOAL_AGENT_SETTINGS` 指向的 settings.json 里的 `internalApiToken`）；那个环境变量只存在于服务进程里，你的 shell 读不到——服务启动时已把生效值同步进 `<数据目录>/token`，cat 那个文件即可。",
    };
  }
  return {
    ...base,
    source: "data-dir",
    tokenFile: "<数据目录>/token",
    tokenEnv: "BLOTBOARD_DATA_DIR",
    hint: "token 在**数据目录下的 token 文件**（默认是仓库里的 `data/token`，首次启动自动生成；`BLOTBOARD_DATA_DIR` 可换位置）。",
  };
}

/** 写操作入口统一调用；不通过直接抛 403（状态码与 goal-agent 一致，文案换成能照做的）。 */
export function assertCanWrite(request: Request): void {
  if (!canWrite(request)) throw forbidden(WRITE_AUTH_HINT);
}

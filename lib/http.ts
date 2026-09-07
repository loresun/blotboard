/** 统一的 API 错误与响应形状（沿用上一代画板服务的 `{ ok, error }`，老脚本不用改）。 */
import zlib from "node:zlib";
import { TRUST_PROXY } from "./config";

export class ApiError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(message, 400);
}
export function notFound(message: string): ApiError {
  return new ApiError(message, 404);
}
export function conflict(message: string): ApiError {
  return new ApiError(message, 409);
}
export function forbidden(message = "写操作校验失败"): ApiError {
  return new ApiError(message, 403);
}

const NO_STORE = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export function ok(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, ...data }), { status, headers: NO_STORE });
}

export function fail(error: unknown): Response {
  const status = error instanceof ApiError ? error.statusCode : 500;
  // Only deliberately authored API errors are safe to send to unauthenticated readers.
  // Filesystem/JSON exceptions may contain paths or fragments of secret-bearing files.
  const message = error instanceof ApiError ? error.message : "服务内部错误，请检查服务配置与存储状态";
  if (status >= 500) {
    // Known API messages are deliberately public. Raw exceptions may include secrets,
    // so do not copy their messages or stack traces into persistent service logs.
    if (error instanceof ApiError) console.error(`[board] ${status} ${message}`);
    else console.error("[board] 500 unexpected internal error");
  }
  return new Response(JSON.stringify({ ok: false, error: message }), { status, headers: NO_STORE });
}

/* ── 响应压缩 ─────────────────────────────────────── */

/**
 * Next 只压页面与 `_next/static`，App Router 的 Route Handler 走的是另一条路径——
 * 实测 API 响应头里根本没有 content-encoding，一块 866 KB 的画板原样过网。
 * 同一份 JSON gzip 后只剩 36 KB（24 倍），代价 2.5 ms 且跑在 libuv 线程池里不占事件循环。
 *
 * 只压 JSON / 文本：上传的图片与 PDF 本来就是压缩格式，再压是白烧 CPU。
 */
const COMPRESSIBLE_TYPE = /^(?:application\/json|application\/javascript|image\/svg\+xml|text\/)/i;
/** gzip 头尾自带二十来字节，短响应压完可能更大，不如原样发。 */
const COMPRESS_MIN_BYTES = 1024;

const gzipAsync = (input: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    zlib.gzip(input, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)));
  });

function acceptsGzip(request: unknown): boolean {
  const headers = (request as Request | undefined)?.headers;
  if (!headers || typeof headers.get !== "function") return false;
  return /\bgzip\b/i.test(headers.get("accept-encoding") || "");
}

async function compress(request: unknown, response: Response): Promise<Response> {
  if (response.status === 204 || response.status === 304) return response;
  if (response.headers.has("content-encoding")) return response;
  if (!COMPRESSIBLE_TYPE.test(response.headers.get("content-type") || "")) return response;
  if (!acceptsGzip(request)) return response;

  const raw = Buffer.from(await response.arrayBuffer());
  // 体积不够就原样发。注意 body 已经被读掉了，必须用读出来的字节重建 Response
  if (raw.length < COMPRESS_MIN_BYTES) {
    return new Response(new Uint8Array(raw), { status: response.status, headers: response.headers });
  }
  let packed: Buffer;
  try {
    packed = await gzipAsync(raw);
  } catch {
    // 压缩失败不该让请求失败：原样发出去
    return new Response(new Uint8Array(raw), { status: response.status, headers: response.headers });
  }
  const headers = new Headers(response.headers);
  headers.set("content-encoding", "gzip");
  headers.set("content-length", String(packed.length));
  headers.append("vary", "accept-encoding");
  return new Response(new Uint8Array(packed), { status: response.status, headers });
}

/**
 * 把 handler 包成「异常统一转 { ok:false, error } + 状态码」的形式，
 * 并在同一个出口做响应压缩（所有 API 都经过这里，不用改 25 个路由文件）。
 */
export function route<A extends unknown[]>(
  handler: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    let response: Response;
    try {
      response = await handler(...args);
    } catch (error) {
      response = fail(error);
    }
    try {
      return await compress(args[0], response);
    } catch {
      return response;
    }
  };
}

/** 客户端写请求时声明的「我手上是哪一版」；没声明就返回 null（agent / 脚本都不带）。 */
/**
 * 用户此刻是从哪个地址访问画板的（拿不到 Host 就回空串）。
 *
 * 为什么要问这个：产物与指南里回指画板 / 知识库 / 书库的链接跟着它走——
 * 从 Tailscale 或局域网访问时写死 127.0.0.1，导出的文件换台机器打开全是死链。
 *
 * `x-forwarded-*` **默认不信**：它们是纯文本头，直连的客户端随手就能伪造，
 * 伪造成功的后果是导出文件里所有链接都指向攻击者那台机器。
 * 只有真站在反代后面（代理会覆盖客户端带来的值）才该信，所以走
 * `BLOTBOARD_TRUST_PROXY=1` 显式开启（见 lib/config.ts）。
 */
export function requestOrigin(request: Request): string {
  const forwardedHost = TRUST_PROXY ? request.headers.get("x-forwarded-host") : null;
  const host = forwardedHost || request.headers.get("host") || "";
  if (!host) return "";
  const forwardedProto = TRUST_PROXY ? request.headers.get("x-forwarded-proto") : null;
  return `${forwardedProto || "http"}://${host}`;
}

export const CLIENT_REVISION_HEADER = "x-board-since";

export function clientRevision(request: Request): number | null {
  const raw = Number(request.headers.get(CLIENT_REVISION_HEADER) || 0);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

const MAX_BODY_BYTES = 1024 * 1024;
/**
 * 带画布数据的接口用的放宽上限：一张 Excalidraw 卡就可能是
 * 400KB 的 .excalidraw JSON + 600KB 的缩略图 dataURL，1MB 的通用上限刚好卡死。
 */
export const MAX_CANVAS_BODY_BYTES = 4 * 1024 * 1024;
/**
 * 画板包导入用的上限：一份包里可以带附件字节（图 / PDF），4MB 那档一块带图的板就塞不下。
 * 峰值内存就是这个数（readBodyText 边收边数，越线立刻掐断），所以不能再往上放太多——
 * 真要搬几百 MB 的库，该拷数据目录，不是走 HTTP。
 */
export const MAX_IMPORT_BODY_BYTES = 48 * 1024 * 1024;

/**
 * 请求体读取：**边收边数，超了当场停**。
 *
 * 以前是 `content-length` 先看一眼、再 `await request.text()` 收完了才复查字节数——
 * 两个洞：`content-length` 是客户端自己写的（chunked 编码干脆没有这个头），
 * 而 `text()` 会把**整个**请求体读进内存才轮到那句复查。也就是说，一个不声明长度、
 * 一直往里灌的连接，能在「请求体过大」这句报错发出之前就把进程的内存吃光。
 *
 * 现在按 chunk 累加，越线立刻 `cancel()` 掉读取端并抛 400：峰值内存 = 上限，
 * 与对方实际发了多少无关。声明的 `content-length` 仍然先看一眼——诚实的客户端
 * 可以在一个字节都没发之前就收到 400，省掉一整趟传输。
 */
async function readBodyText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw badRequest("请求体过大");
  const body = request.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw badRequest("请求体过大");
      chunks.push(Buffer.from(value));
    }
  } catch (err) {
    // 对端可能还在发：主动取消，别让连接吊着（与 lib/uploads.ts 流式落盘同一手法）
    try {
      await reader.cancel();
    } catch {
      /* 对端已断 */
    }
    throw err;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 原样收下请求体的文本：导入要认 JSON 与 HTML 两种，不能先替调用方解析掉。 */
export async function readText(request: Request, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return readBodyText(request, maxBytes);
}

export async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, any>> {
  const raw = await readBodyText(request, maxBytes);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw badRequest("请求体不是合法 JSON");
  }
}

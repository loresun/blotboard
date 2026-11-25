/**
 * HTTP 流保护与轻量健康探针载荷工具（零外部依赖，仅使用 Node 内置能力）。
 *
 * 作用：
 *  1. 防止客户端提前断开（EPIPE / ECONNRESET / ERR_STREAM_DESTROYED）在响应写入或文件流读取时抛出未捕获异常；
 *  2. 响应关闭或请求中止时自动销毁关联的读流，避免文件句柄泄漏；
 *  3. 提供统一的 `/healthz` 与 `/health` 响应结构。
 */

const IGNORABLE_STREAM_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_PREMATURE_CLOSE",
  "ECONNABORTED",
]);

const GUARDED_EMITTERS = new WeakSet();

/**
 * 判断错误是否属于客户端提前断连引起的可忽略流错误。
 *
 * @param {unknown} err 捕获到的错误对象
 * @returns {boolean} 是否可安全忽略
 */
export function isIgnorableStreamError(err) {
  return Boolean(err && typeof err === "object" && typeof err.code === "string" && IGNORABLE_STREAM_CODES.has(err.code));
}

/**
 * 安全销毁可读/可写流，吞掉重复销毁引发的异常。
 *
 * @param {import("node:stream").Stream | null | undefined} stream 目标流对象
 */
function safeDestroy(stream) {
  if (!stream) return;
  try {
    if (typeof stream.destroy === "function" && !stream.destroyed) {
      stream.destroy();
    }
  } catch {
    // 忽略重复销毁错误
  }
}

/**
 * 为 HTTP 请求、响应及可选的底层数据流挂载断连保护，返回安全写入/结束句柄。
 *
 * @param {import("node:http").IncomingMessage | null | undefined} req 请求对象
 * @param {import("node:http").ServerResponse | null | undefined} res 响应对象
 * @param {import("node:stream").Stream | Array<import("node:stream").Stream> | null} [stream=null] 需要联动清理的流
 * @param {{ onError?: ((err: unknown) => void) | null }} [options={}] 额外错误回调
 * @returns {{ isWritable: () => boolean, safeWrite: (chunk: unknown, encoding?: BufferEncoding) => boolean, safeEnd: (chunk?: unknown, encoding?: BufferEncoding) => boolean, destroy: () => void }}
 */
export function attachSafeStreamGuards(req, res, stream = null, { onError = null } = {}) {
  const streams = Array.isArray(stream) ? stream.filter(Boolean) : stream ? [stream] : [];

  const handleErr = (err) => {
    for (const s of streams) safeDestroy(s);
    if (isIgnorableStreamError(err)) return;
    if (typeof onError === "function") onError(err);
  };

  const attachErr = (emitter) => {
    if (!emitter || typeof emitter.on !== "function" || GUARDED_EMITTERS.has(emitter)) return;
    GUARDED_EMITTERS.add(emitter);
    emitter.on("error", handleErr);
  };

  attachErr(req);
  attachErr(res);
  for (const s of streams) attachErr(s);

  const cleanupStreams = () => {
    if (!res || res.destroyed || !res.writableFinished) {
      for (const s of streams) safeDestroy(s);
    }
  };

  if (res && typeof res.on === "function") {
    res.on("close", cleanupStreams);
  }
  if (req && typeof req.on === "function") {
    req.on("aborted", cleanupStreams);
  }

  function isWritable() {
    return Boolean(res && !res.destroyed && !res.writableEnded && !res.writableFinished);
  }

  function safeWrite(chunk, encoding) {
    if (!isWritable()) return false;
    try {
      return encoding ? res.write(chunk, encoding) : res.write(chunk);
    } catch (err) {
      if (isIgnorableStreamError(err)) {
        cleanupStreams();
        return false;
      }
      throw err;
    }
  }

  function safeEnd(chunk, encoding) {
    if (!res || res.destroyed || res.writableEnded) return false;
    try {
      if (chunk === undefined) res.end();
      else if (encoding) res.end(chunk, encoding);
      else res.end(chunk);
      return true;
    } catch (err) {
      if (isIgnorableStreamError(err)) {
        cleanupStreams();
        return false;
      }
      throw err;
    }
  }

  return {
    isWritable,
    safeWrite,
    safeEnd,
    destroy: () => {
      for (const s of streams) safeDestroy(s);
    },
  };
}

/**
 * 构造统一的轻量健康检查 JSON 载荷。
 *
 * @param {string} service 服务名
 * @param {Record<string, unknown>} [extra={}] 附加字段（如 port、version）
 * @returns {Record<string, unknown>}
 */
export function r6HealthPayload(service, extra = {}) {
  return {
    ok: true,
    status: "ok",
    service,
    ...(extra && typeof extra === "object" ? extra : {}),
  };
}

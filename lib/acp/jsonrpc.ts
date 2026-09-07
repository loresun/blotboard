/**
 * 极小的 JSON-RPC 2.0 双向端点（newline-delimited JSON over stdio）——ACP 的线上格式。
 *
 * 为什么手写而不用官方库（@zed-industries/agent-client-protocol / @agentclientprotocol/sdk）：
 *  1. 客户端只用得到 4 个出站方法（initialize / session.new / session.prompt / session.cancel）
 *     和 2 类入站处理（session/update 通知、session/request_permission 请求），协议面极小；
 *  2. 官方库正处在包名迁移期（zed-industries → agentclientprotocol 两个名字并存），
 *     还带着 zod 依赖与 3.9MB 体积——为这点用量引一个会漂移的依赖不划算；
 *  3. 难点根本不在协议编解码，而在子进程生命周期（挂起的权限请求、cancel 收尾、
 *     服务重启兜底）——那些逻辑无论如何都要自己写，编解码手写反而全链路可控。
 * 线格式已对照本机 ACP 实现核实：一行一条 JSON-RPC 消息，无 Content-Length 头。
 */
import type { ChildProcess } from "node:child_process";

/** Bound incomplete and complete stdio frames before JSON.parse (UTF-16 code units). */
export const MAX_RPC_MESSAGE_CHARS = 1024 * 1024;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

type RequestHandler = (params: any) => Promise<unknown> | unknown;
type NotificationHandler = (params: any) => void;

interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

export class RpcRemoteError extends Error {
  code: number;
  constructor(error: JsonRpcError) {
    super(`agent 返回错误 ${error.code}：${error.message}`);
    this.code = error.code;
  }
}

export class JsonRpcPeer {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private closed = false;

  constructor(child: ChildProcess) {
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.feed(chunk));
  }

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** 出站请求。timeoutMs 传 0 = 不限时（session/prompt 可能跑很久）。 */
  request<T = any>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("agent 连接已关闭"));
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`agent ${method} 超时（${timeoutMs}ms 无响应）`));
          }, timeoutMs)
        : null;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** 挂着的出站请求全部失败 + 停止收发。子进程退出 / 主动收尾时调。 */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private send(message: Record<string, unknown>): void {
    try {
      this.child.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch {
      /* 子进程已死：出站请求会由 close() 统一拒绝 */
    }
  }

  private feed(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      if (index > MAX_RPC_MESSAGE_CHARS) {
        this.buffer = "";
        this.close("agent 协议消息超过大小上限");
        return;
      }
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        // agent 往 stdout 打了非协议内容（不该，但见过）：跳过这一行
        continue;
      }
      // A CLI may print valid JSON that is not an RPC object (null, arrays, scalars).
      // Ignore it rather than throwing inside a stream event and crashing the server.
      if (!message || typeof message !== "object" || Array.isArray(message)) continue;
      this.dispatch(message);
    }
    if (this.buffer.length > MAX_RPC_MESSAGE_CHARS) {
      this.buffer = "";
      this.close("agent 协议消息超过大小上限");
    }
  }

  private dispatch(message: any): void {
    // 响应（成功或错误）
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (message.error) {
        const error = message.error;
        if (typeof error.code === "number" && Number.isFinite(error.code) && typeof error.message === "string") {
          entry.reject(new RpcRemoteError(error));
        } else {
          entry.reject(new Error("agent 返回了无效的协议错误"));
        }
      } else entry.resolve(message.result);
      return;
    }
    // 入站请求（要回响应）
    if (message.id !== undefined && typeof message.method === "string") {
      const handler = this.requestHandlers.get(message.method);
      if (!handler) {
        // 能力最小化：initialize 已声明不支持 fs/terminal，agent 硬发就按协议回 -32601
        this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `client does not support ${message.method}` } });
        return;
      }
      Promise.resolve()
        .then(() => handler(message.params))
        .then((result) => this.send({ jsonrpc: "2.0", id: message.id, result: result ?? {} }))
        .catch((err) => {
          this.send({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32603, message: String((err as Error)?.message || err) },
          });
        });
      return;
    }
    // 通知
    if (typeof message.method === "string") {
      const handler = this.notificationHandlers.get(message.method);
      try {
        handler?.(message.params);
      } catch (err) {
        console.error(`[acp] 通知处理失败（${message.method}）：${String((err as Error)?.message || err)}`);
      }
    }
  }
}

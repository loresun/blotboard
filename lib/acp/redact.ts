/**
 * ACP 诊断文本的脱敏（stderr 摘要 / 检测报错共用）。
 *
 * 口径与 lib/auth.ts describeAuth 一致：**绝不发布原始诊断**——
 * 绝对路径换占位（「这台机器的目录长什么样」不白送人），spawn env 里够长的值
 * 一律当密钥整段抹掉。两处调用方（manager 的终态摘要、probe 的失败原因）
 * 共用同一份规则，免得一边补了另一边漏。
 */
import fs from "node:fs";
import { ACP_WORKSPACE_DIR, DATA_DIR } from "../config";

/** 短于这个长度的 env 值不当密钥（密钥不会短，而 `NODE_ENV=production` 这种会误伤） */
export const SECRET_MIN_CHARS = 16;

/** 疑似密钥清单：spawn env 里够长的值都算，内部 token 无条件算 */
export function collectSecrets(env: NodeJS.ProcessEnv, token?: string | null): string[] {
  const secrets = new Set<string>();
  if (token) secrets.add(token);
  for (const value of Object.values(env)) {
    if (typeof value === "string" && value.length >= SECRET_MIN_CHARS) secrets.add(value);
  }
  return [...secrets];
}

/**
 * 同一个目录在子进程眼里可能是另一串字符：macOS 的 /var 是 /private/var 的软链，
 * 子进程报的 `process.cwd()` 是 realpath，而画板手里的是原样路径——只按原样替换会漏成
 * `/private<工作目录>`。两种写法都收进来一起换。
 */
function pathVariants(dir: string): string[] {
  if (!dir) return [];
  const out = new Set([dir]);
  try {
    out.add(fs.realpathSync(dir));
  } catch {
    /* 目录可能还不存在：那就只用原样路径 */
  }
  return [...out];
}

/** 路径只留占位、疑似密钥整段抹掉 */
export function redactDiagnostic(line: string, opts: { cwd?: string | null; secrets?: string[] } = {}): string {
  const spots = [
    ...pathVariants(opts.cwd || "").map((from) => ({ from, to: "<工作目录>" })),
    ...pathVariants(ACP_WORKSPACE_DIR).map((from) => ({ from, to: "<工作目录>" })),
    ...pathVariants(DATA_DIR).map((from) => ({ from, to: "<数据目录>" })),
  ]
    .filter((spot) => spot.from)
    // 长片段先换：不然短片段（DATA_DIR）会把长路径（DATA_DIR/acp-workspace）切成两半
    .sort((a, b) => b.from.length - a.from.length);
  let out = line;
  for (const spot of spots) out = out.split(spot.from).join(spot.to);
  for (const secret of opts.secrets || []) out = out.split(secret).join("<疑似密钥>");
  return out;
}

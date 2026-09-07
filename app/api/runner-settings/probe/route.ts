import { probeAgentCommand, probePreset } from "@/lib/acp/probe";
import { findPreset } from "@/lib/acp/presets";
import { assertCanWrite } from "@/lib/auth";
import { badRequest, ok, readJson, route } from "@/lib/http";
import { getAgent } from "@/lib/runner-settings";

export const dynamic = "force-dynamic";

/** 同时最多探几个：探测会 spawn 真进程，别让人一把点出十几个 coding agent 来 */
const MAX_CONCURRENT = 3;
function inflight(): { n: number } {
  const g = globalThis as any;
  if (!g.__blotboardAcpProbeInflight) g.__blotboardAcpProbeInflight = { n: 0 };
  return g.__blotboardAcpProbeInflight;
}

/**
 * ACP 连通性检测（任务台「Runner 设置」的「检测」/「一键添加」前置）。
 *
 * 三种问法，都只做「握手一次然后杀掉」，**不发 prompt**（不花 token、不动文件）：
 *  - `{ presetKey }`   —— 探内置预设（首选命令不通会自动再试 npx 兜底）；
 *  - `{ agentId }`     —— 探注册表里已有的一条（用它自己的 cwd / env）；
 *  - `{ command, args, cwd, env }` —— 探正在编辑、还没保存的草稿。
 *
 * 写口鉴权：这条会 spawn 进程，与派单同级，绝不做成免鉴权的读口。
 */
export const POST = route(async (request: Request) => {
  assertCanWrite(request);
  const body = await readJson(request);
  const gate = inflight();
  if (gate.n >= MAX_CONCURRENT) throw badRequest(`同时最多检测 ${MAX_CONCURRENT} 个 agent，稍等一下再点`);
  gate.n += 1;
  try {
    if (typeof body.presetKey === "string" && body.presetKey) {
      const preset = findPreset(body.presetKey);
      if (!preset) throw badRequest(`没有这个预设：「${body.presetKey}」`);
      const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null;
      return ok({ result: await probePreset(preset, cwd) });
    }

    if (typeof body.agentId === "string" && body.agentId) {
      const agent = getAgent(body.agentId);
      if (!agent) throw badRequest(`agent 不存在：「${body.agentId}」`);
      return ok({
        result: await probeAgentCommand({ command: agent.command, args: agent.args, cwd: agent.cwd, env: agent.env }),
      });
    }

    const command = typeof body.command === "string" ? body.command.trim() : "";
    if (!command) throw badRequest("要检测什么：给 presetKey / agentId / command 三者之一");
    return ok({
      result: await probeAgentCommand({
        command,
        args: Array.isArray(body.args) ? body.args.map((item: unknown) => String(item ?? "")).slice(0, 50) : [],
        cwd: typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : null,
      }),
    });
  } finally {
    gate.n -= 1;
  }
});

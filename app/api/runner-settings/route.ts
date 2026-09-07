import { ACP_PRESETS } from "@/lib/acp/presets";
import { assertCanWrite } from "@/lib/auth";
import { TASK_BACKEND } from "@/lib/features";
import { ok, readJson, route } from "@/lib/http";
import { loadRunnerSettings, patchRunnerSettings, toPublic } from "@/lib/runner-settings";

export const dynamic = "force-dynamic";

/**
 * Runner 设置（ACP agent 注册表 + 权限档位，docs/RUNNER.md §4）。
 *
 * 只读回**脱敏形状**：agent 的 env 只给 key 名不给值（值可能是 API key，
 * 只在 spawn 子进程时注入，永不出服务端）。backend 一并带上——goal-agent / http
 * 后端下任务台据此显示「由外部 Runner 接管」，但配置本身仍可读写（切回 local 就生效）。
 */
// command/args/cwd are editable operational configuration and may contain private values.
// Apply the same authenticated channel as PATCH; the UI already sends x-board-web.
export const GET = route(async (request: Request) => {
  assertCanWrite(request);
  // presets 一并下发：面板据此渲染「一键添加」（内容是静态表，见 lib/acp/presets.ts）
  return ok({ backend: TASK_BACKEND, settings: toPublic(loadRunnerSettings()), presets: ACP_PRESETS });
});

/**
 * 改设置（agents 是完整替换列表；带已有 id 且不带 env 字段 = 保留存盘 env，
 * 语义见 lib/runner-settings.ts patchRunnerSettings 注释）。写口鉴权与其他写口同一套。
 */
export const PATCH = route(async (request: Request) => {
  assertCanWrite(request);
  const body = await readJson(request);
  const settings = patchRunnerSettings(body);
  return ok({ backend: TASK_BACKEND, settings: toPublic(settings) });
});

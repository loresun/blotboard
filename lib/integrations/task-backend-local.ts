/**
 * local 任务后端（开源默认，零依赖闭环）：
 *
 *  - createIssue / patchIssue → 落本地 `<data>/issues.json`（lib/issue-store.ts）；
 *  - launch → 不拉起任何进程，而是生成一份**完整 prompt**（Issue 正文 + 画板深链 +
 *    回写指引）挂成一个 run，人把它复制给任何 agent，agent 通过 /api/issues 的
 *    PATCH 回写状态（契约见 docs/RUNNER.md）；
 *  - getTask → 把 run 状态映射成任务卡轮询认的形状（{ task: { status, summary… } }），
 *    轮询侧一行不用改。
 *
 * 这样「任务功能」不再依赖外部 Runner：没配就走这条，配了 goal-agent / http
 * 后端时本文件完全不被触碰。
 */
import { ensureStartupSweep, startAcpRun } from "../acp/manager";
import { PUBLIC_URL } from "../config";
import { runnerProxyPath } from "../goal-agent";
import { ApiError, badRequest, notFound } from "../http";
import * as issues from "../issue-store";
import { getAgent, loadRunnerSettings } from "../runner-settings";
import type { TaskBackend } from "./task-backend";

const MODE_LABEL: Record<"implement" | "analyze", string> = {
  implement: "implement（直接动手实现，产出真实改动）",
  analyze: "analyze（只分析给结论，不要动手改任何东西）",
};

/**
 * 「发起任务」生成的完整 prompt：拿去粘给任何 agent 就能开工。
 * Issue 正文本身已含画板上下文 / 未解决评论 / 卡片 agent 指令（lib/issue-sync.ts 拼的），
 * 这里补的是三样别处没有的：深链、执行模式、回写指引（含 token 说明）。
 */
export function buildRunPrompt(issue: issues.LocalIssue, mode: "implement" | "analyze", runId: string): string {
  const base = PUBLIC_URL.replace(/\/+$/, "");
  const links: string[] = [];
  if (issue.boardId) {
    links.push(
      `- 来源画板卡片：${base}/?board=${encodeURIComponent(issue.boardId)}${
        issue.cardId ? `&card=${encodeURIComponent(issue.cardId)}` : ""
      }`,
    );
  }
  links.push(`- 任务台详情：${base}/tasks?issue=${encodeURIComponent(issue.id)}`);
  const api = `${base}/api/issues/${issue.id}`;
  return [
    `# 画板任务 ${issue.number}：${issue.title}`,
    "",
    issue.description || "（无正文）",
    "",
    "---",
    "",
    `执行模式：${MODE_LABEL[mode]}`,
    "",
    "相关链接：",
    ...links,
    "",
    "完成或受阻时，请通过画板 API 回报状态。写操作要带请求头 `x-auth-key`：",
    // token 的落点刻意只给**相对表述**：这段 prompt 会随 `GET /api/issues/:id`（免鉴权读口）
    // 一起吐出去，写绝对路径等于把「这台机器的目录长什么样」白送人。
    // 与 lib/auth.ts describeAuth 的 tokenFile 同一条口径（那边也只给 `<数据目录>/token`）。
    "token 取环境变量 `BLOTBOARD_INTERNAL_TOKEN`，或读数据目录下的 `token` 文件",
    "（数据目录默认是画板仓库里的 `data/`，`BLOTBOARD_DATA_DIR` 可换到别处）。",
    "```",
    `开工     PATCH ${api}/runs/${runId}   {"status":"running"}`,
    `完成     PATCH ${api}/runs/${runId}   {"status":"completed","note":"一句话说明结果"}`,
    `失败     PATCH ${api}/runs/${runId}   {"status":"failed","note":"卡在哪里"}`,
    `等输入   PATCH ${api}/runs/${runId}   {"status":"waiting","note":"需要人提供什么"}`,
    `补充备注 PATCH ${api}              {"note":"进度备注"}`,
    "```",
    "（协议详情见画板仓库 docs/RUNNER.md）",
  ].join("\n");
}

/** run → 任务卡轮询的形状。summary 给页脚 / 抽屉一句能看的话。 */
export function runAsTask(found: { issue: issues.LocalIssue; run: issues.LocalIssueRun }) {
  const { issue, run } = found;
  const acp = run.kind === "acp";
  const summary =
    run.note ||
    (run.status === "pending"
      ? "prompt 已生成，等着把它交给一个 agent（任务台或任务抽屉里可复制）"
      : run.status === "running" && acp
        ? `${run.agentName || "ACP agent"} 正在执行（进展看任务台）`
        : run.status === "completed"
          ? "agent 已回报完成"
          : "");
  return {
    task: {
      id: run.id,
      status: run.status,
      summary,
      updatedAt: run.updatedAt,
      // local 专属：完整 prompt 一并带回，任务抽屉的「复制 prompt」直接用
      prompt: run.prompt,
      issueId: issue.id,
      mode: run.mode,
      // acp run 的身份信息：任务抽屉 / 任务台据此换文案（谁在执行、去哪看流）
      kind: run.kind || "prompt",
      ...(acp ? { agentName: run.agentName || run.agentId || null } : {}),
    },
  };
}

export const localBackend: TaskBackend = {
  async createIssue(payload, origin) {
    const issue = issues.createIssue({
      title: payload.title,
      description: payload.description,
      priority: payload.priority,
      labels: payload.labels,
      boardId: origin?.boardId || null,
      cardId: origin?.cardId || null,
    });
    // 形状对齐 goal-agent：{ issue: { id, identifier/number… } }（board-service 认这两层）
    return { issue: { ...issue, identifier: issue.number } };
  },

  async patchIssue(issueId, payload) {
    // 不存在 → { issue: null }：与 goal-agent 的口径一致，issue-sync 靠它认出「已被删」
    const issue = issues.patchIssue(issueId, payload);
    return { issue };
  },

  async launch(issueId, payload, options) {
    const mode: "implement" | "analyze" = payload.mode === "analyze" ? "analyze" : "implement";

    // 带 agentId = ACP 派单：spawn 注册表里的那个 agent 跑这一个 run（docs/RUNNER.md §4）。
    // 不带 = 现状 copy-prompt 流程，一个字节都不变。
    if (options?.agentId) {
      const agent = getAgent(String(options.agentId));
      if (!agent) throw badRequest(`agent 不存在：「${options.agentId}」——先在任务台「Runner 设置」里注册`);
      const settings = loadRunnerSettings();
      const run = startAcpRun({
        issueId,
        agent,
        permissionMode: settings.permissionMode,
        mode,
        prompt: (issue, runId) => buildRunPrompt(issue, mode, runId),
      });
      return { sessionId: run.id, mode, issue: { id: issueId }, agent: { id: agent.id, name: agent.name } };
    }

    const run = issues.addRun(issueId, { mode, prompt: (issue, runId) => buildRunPrompt(issue, mode, runId) });
    return { sessionId: run.id, mode, issue: { id: issueId } };
  },

  async getTask(taskId) {
    // 服务重启兜底在第一次查询前先跑：不然重启后轮询会一直看到僵死的 running
    ensureStartupSweep();
    const found = issues.findRun(taskId);
    if (!found) throw notFound("任务不存在（local 后端只认发起任务时生成的 run id）");
    return runAsTask(found);
  },

  /**
   * 前端直通：白名单与远程后端同一份（未放行 404）。能就地服务的就地服务
   * （任务状态 / Issue 详情与回写 / 产出列表回空），只有「自由派单」这类
   * 必须有真 Runner 的路径回 501 并指路。
   */
  async proxy(method, subPath, _query, body) {
    const target = runnerProxyPath(subPath, method);
    if (!target) throw new ApiError("该 Runner 路径未开放", 404);

    const taskMatch = /^\/api\/tasks\/([A-Za-z0-9._-]+)$/.exec(target);
    if (taskMatch && method === "GET") return this.getTask(taskMatch[1]) as any;

    const issueMatch = /^\/api\/issues\/([A-Za-z0-9._-]+)$/.exec(target);
    if (issueMatch) {
      if (method === "GET") {
        const issue = issues.getIssue(issueMatch[1]);
        if (!issue) throw notFound("Issue 不存在");
        return { issue: { ...issue, identifier: issue.number } } as any;
      }
      // PATCH：任务抽屉里改标签 / 状态走这条（与 /api/issues/:id 是同一份数据）
      const issue = issues.patchIssue(issueMatch[1], (body as issues.PatchIssueInput) || {});
      if (!issue) throw notFound("Issue 不存在");
      return { issue: { ...issue, identifier: issue.number } } as any;
    }

    // local 模式没有产出登记：回空列表，任务抽屉自然显示「还没登记产出」
    if (target === "/api/artifacts" && method === "GET") return { artifacts: [] } as any;
    if (/^\/api\/artifacts\//.test(target)) throw notFound("local 后端没有产出登记");

    if (target === "/api/health") return { ok: true, service: "blotboard-local-tasks" } as any;

    if (target === "/api/tasks") {
      // Agent 抽屉的自由派单（POST /tasks）需要一个真的执行方，local 给不了
      throw new ApiError(
        "local 任务后端不支持直接派单——配置 BLOTBOARD_RUNNER_URL 或 GOAL_AGENT_RUNNER_URL 接入外部 Runner，或在任务卡上「生成任务 prompt」交给你的 agent",
        501,
      );
    }
    throw notFound("local 后端没有这条路径");
  },
};

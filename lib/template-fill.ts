/**
 * 「AI 填充」接缝：模板留下的待填提示词 → 派给 Goal Agent 的一句 goal。
 *
 * 关键约定：8567 **不做任何 LLM 调用**。模板里的 fillPrompt 是写给 Goal Agent 看的，
 * 这里只负责把它们拼成一条任务，真正生成内容与回写由 agent 用 board_* 工具/HTTP 完成。
 *
 * 待填标记落在卡片既有的 agentPrompt 字段上（不新增卡片字段）：
 * 带 FILL_MARK 前缀 = 这张卡来自模板且等着被填；正文一旦写上，它就自动从待填清单里退出，
 * 所以「AI 填充」可以反复点，不会把已经填好的卡冲掉。
 */
import type { BoardCard } from "./types";

export const FILL_MARK = "【模板待填】";

/** 这张卡的模板填充提示词；不是模板待填卡则返回 null */
export function fillPromptOf(card: Pick<BoardCard, "agentPrompt">): string | null {
  const prompt = card.agentPrompt || "";
  return prompt.startsWith(FILL_MARK) ? prompt.slice(FILL_MARK.length).trim() : null;
}

/** 还没填正文的模板卡；填过的（content 非空）不再算待填 */
export function pendingFillCards(cards: BoardCard[]): BoardCard[] {
  return cards.filter((card) => fillPromptOf(card) && !(card.content || "").trim());
}

export interface FillContext {
  boardId: string;
  boardName: string;
  /** agent 调 API 用的地址（本机回环最稳） */
  boardBase: string;
  /** 回报给用户的深链前缀（跟随用户此刻访问的 host） */
  boardLink: string;
  /** 待填卡片（调用方通常传 pendingFillCards 的结果） */
  cards: BoardCard[];
  /** 这批卡来自哪个模板；隔天再点「AI 填充」时不一定知道，可以不传 */
  templateName?: string;
  /** 模板级说明（template.agentPrompt） */
  templateAgentPrompt?: string;
}

const MAX_CARDS_IN_GOAL = 30;

/**
 * 拼一条给 Goal Agent 的填充任务。
 * 约束写得比较死（只填 content / 不改别的字段 / 每张 ≤200 字）是为了让填充是可预期的：
 * 模板的价值在骨架，agent 只该把肉填进去，不该顺手重排画板。
 */
export function buildFillGoal(ctx: FillContext): string {
  const cards = ctx.cards.slice(0, MAX_CARDS_IN_GOAL);
  const from = ctx.templateName ? `来源模板「${ctx.templateName}」` : "来自模板";
  const lines = [
    `# 画板模板填充`,
    ``,
    `给泼墨画板「${ctx.boardName}」（id \`${ctx.boardId}\`，服务在 ${ctx.boardBase}）填内容。这批卡${from}。`,
    ``,
    `## 先看板`,
    ``,
    `\`GET ${ctx.boardBase}/api/boards/${ctx.boardId}\` 读全量卡片——中心卡/主题卡的正文是这次填充的题目，`,
    `别只看下面的清单就动笔（清单里只有提示词，没有主题）。`,
    ``,
    `## 逐张填这些卡（只写 content）`,
    ``,
  ];
  for (const card of cards) {
    lines.push(`- \`${card.id}\`「${card.title || "未命名卡"}」：${fillPromptOf(card)}`);
  }
  if (ctx.cards.length > cards.length) {
    lines.push(`- …另有 ${ctx.cards.length - cards.length} 张待填卡，读全量后按同样规则处理`);
  }
  lines.push(
    ``,
    `## 怎么写回去`,
    ``,
    `- 有 \`board_update_card\` 工具就用工具；没有就 \`PATCH ${ctx.boardBase}/api/boards/${ctx.boardId}/cards/<cardId>\``,
    `  提交 \`{ "content": "..." }\`（写操作要请求头 \`x-auth-key\`，token 在画板数据目录的 token 文件或 BLOTBOARD_INTERNAL_TOKEN 环境变量里）。`,
    `- **只改 content**，不要动 title / x / y / w / h / color / agentPrompt，也不要新增或删除卡片与连线。`,
    `- 每张 ≤ 200 字，直接写结论，不要复述提示词、不要写「以下是我的建议」这类开场白。`,
    `- 提示词里要求「给 N 条」的，就恰好给 N 条。`,
    `- 待办卡（todo）例外：往 \`todo.items\` 里加条目，不要把清单塞进 content。`,
  );
  if (ctx.templateAgentPrompt) {
    lines.push(``, `## 模板补充说明`, ``, ctx.templateAgentPrompt);
  }
  lines.push(
    ``,
    `## 收尾`,
    ``,
    `回报「✓ 已填充 N 张卡」，并附深链 \`${ctx.boardLink}/?board=${ctx.boardId}\`。`,
  );
  return lines.join("\n");
}

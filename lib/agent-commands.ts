/**
 * Agent 指令：内置模板 + 用户自定义（存 <数据目录>/agent-commands.json）。
 *
 * 指令正文里写占位符，派发时按当前画板替换——所以换端口 / 换画板 / 换机器都不用改文案。
 * 这个文件前后端共享：占位符渲染在前端做，存储与校验在服务端做（lib/agent-command-store.ts）。
 *
 * 含 {userInput} 的指令是「问一句再派」：点执行时先让用户补一句要求，
 * 其余基础信息（地址 / 鉴权 / API / 现有卡片）由 {boardBrief} + {boardOutline} 自动带上。
 */

export const PLACEHOLDERS = {
  "{userInput}": "用户点执行时现填的一句话（写了它就会先弹输入框）",
  "{boardBrief}": "画板底料（短）：动哪块板 + 优先用 board_* 工具 + 细节读 skill",
  "{boardOutline}": "当前画板的卡片与连线清单（id + 类型 + 标题）",
  "{boardLink}": "回报给用户的深链前缀（跟随你此刻访问画板的地址，Tailscale 打开就是 Tailscale）",
  "{boardId}": "当前画板 id",
  "{boardName}": "当前画板名称",
  "{boardBase}": "画板服务地址（如 http://127.0.0.1:8567）",
  "{goalAgentWeb}": "Goal Agent 主界面地址（由 GOAL_AGENT_WEB_URL 配）",
} as const;

export interface AgentCommandContext {
  boardId: string;
  boardName: string;
  boardBase: string;
  /** 给用户看的链接前缀：跟随浏览器当前 origin，不是服务端配的回环地址 */
  boardLink: string;
  goalAgentWeb: string;
  /** 派出时用户现填的那句话；不需要输入的指令留空 */
  userInput?: string;
  /** 当前画板的卡片 / 连线清单，前端按当前快照生成 */
  boardOutline?: string;
}

export interface AgentCommand {
  id: string;
  icon: string;
  title: string;
  desc: string;
  prompt: string;
  builtin: boolean;
  /** 内置指令可以被隐藏，但不能被删除 */
  hidden?: boolean;
  /** 需要用户补一句时，输入框里的提示文案 */
  inputHint?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** 正文里写了 {userInput} 的指令 = 派出前先问用户一句。 */
export function commandNeedsInput(command: Pick<AgentCommand, "prompt">): boolean {
  return command.prompt.includes("{userInput}");
}

/**
 * 画板操作底料：只给「这次动哪块板 + 怎么下手」，具体 API / 鉴权 / 字段全在 skill 里。
 * 提示词短 = 用户一眼看得完，agent 也不会被一大段规格淹掉；要细节它自己去读 skill。
 */
export const BOARD_SKILL = "blotboard-8567";

export const BOARD_BRIEF = `## 这次动的板

用户的泼墨画板「{boardName}」（id \`{boardId}\`），服务在 {boardBase}。

## 怎么下手

- 先看板：\`board_list\` 工具，或 \`GET {boardBase}/api/boards/{boardId}\`。
- 写操作优先用 \`board_*\` 工具；工具够不着的（整板重排、连线语义/颜色、卡片级 agentPrompt、Markdown 导出、任务状态）走 HTTP。
- **鉴权、完整 API、字段定义、踩坑红线都在 skill \`${BOARD_SKILL}\` 里，需要时读它**，别自己试参数。
- 不替用户转 Issue / 发起执行任务，不改他手写的正文——除非这次明确要求。
- 完事说清改了哪几张卡/连线，并给深链 \`{boardLink}/?board={boardId}&card=<cardId>\`（用这个前缀，别换成别的地址）。`;

export function renderPrompt(prompt: string, ctx: AgentCommandContext): string {
  return prompt
    .replaceAll("{boardBrief}", BOARD_BRIEF)
    .replaceAll("{boardOutline}", ctx.boardOutline || "（当前画板没有卡片）")
    .replaceAll("{userInput}", (ctx.userInput || "").trim())
    .replaceAll("{boardId}", ctx.boardId)
    .replaceAll("{boardName}", ctx.boardName)
    .replaceAll("{boardBase}", ctx.boardBase)
    .replaceAll("{boardLink}", ctx.boardLink || ctx.boardBase)
    .replaceAll("{goalAgentWeb}", ctx.goalAgentWeb);
}

const TOKEN_NOTE =
  "写操作请求头 x-auth-key，token 在画板数据目录的 token 文件里（服务首启自动生成），也可用 BLOTBOARD_INTERNAL_TOKEN 环境变量指定";

export const BUILTIN_COMMANDS: AgentCommand[] = [
  {
    id: "builtin:freeform",
    icon: "sparkles",
    title: "自由指令（带画板底料）",
    desc: "自己写一句要求就派出去——画板地址、鉴权、全部 API、现有卡片清单自动附上。",
    builtin: true,
    inputHint: "例如：把左边三张引用卡的要点归纳成一张任务卡，并从每张引用卡连一条「行动」线过去",
    prompt:
      `{boardBrief}\n\n` +
      `## 当前画板快照\n\n{boardOutline}\n\n` +
      `（这只是清单；要看正文就 GET {boardBase}/api/boards/{boardId}，别凭标题猜内容。）\n\n` +
      `## 这次要做的事（用户原话）\n\n{userInput}\n\n` +
      `## 收尾\n\n` +
      `按用户这句话动手。范围拿不准就往小了做，做完在回答里写清：改了哪几张卡/连线、为什么、` +
      `以及受影响卡片的深链。用户没要求的事不要顺手做。`,
  },
  {
    id: "builtin:layout",
    icon: "wand",
    title: "整理画板布局",
    desc: "按卡片类型自动分列排布、对齐间距、清理重叠，不改内容。",
    builtin: true,
    prompt:
      `整理泼墨画板 {boardId}（「{boardName}」）的布局。要求：` +
      `1) 先 GET {boardBase}/api/boards/{boardId} 拿到全部卡片；` +
      `2) 按类型（引用→想法→任务→链接/文件）从左到右分列、同列纵向对齐排布，列距 480、行距 260，` +
      `保留每张卡 id/type/title/content/task/link/file/createdBy 字段不变，只改 x/y/w/h/z；` +
      `3) 用 PUT {boardBase}/api/boards/{boardId}/whole 提交 { cards, edges, viewport }（${TOKEN_NOTE}）；` +
      `4) 若你有可用的 board_* MCP 工具则优先用工具完成。完成后汇报排布规则和卡片数量。`,
  },
  {
    id: "builtin:idea-to-task",
    icon: "clipboard",
    title: "想法批量转任务",
    desc: "把这块板上的想法型文本/引用卡逐张转为任务卡（含目标文本），不自动发起执行。",
    builtin: true,
    prompt:
      `处理泼墨画板 {boardId}（「{boardName}」）：把「还是想法」的文本卡（type=text 且标题或正文包含要做的事）转成任务卡。要求：` +
      `1) GET {boardBase}/api/boards/{boardId} 读卡；` +
      `2) 对每张要转的卡 PATCH {boardBase}/api/boards/{boardId}/cards/<id>，` +
      `提交 { "type": "task", "task": { "goal": "<可执行目标句>", "priority": "medium" } }（服务端支持 type 互转，原 content 保留不动）；` +
      `3) ${TOKEN_NOTE}；4) 有 board_* MCP 工具则优先用工具。` +
      `不要替用户转 Issue 或发起任务。完成后列出转化清单。`,
  },
  {
    id: "builtin:action-plan",
    icon: "network",
    title: "基于画板生成行动计划",
    desc: "读整块板的卡片与连线关系，为每个想法卡生成一张任务卡并连上「行动」线。",
    builtin: true,
    prompt:
      `阅读泼墨画板 {boardId}（「{boardName}」，GET {boardBase}/api/boards/{boardId}），理解卡片与连线的想法脉络，然后：` +
      `1) 为每个尚未有下游任务卡的源头想法（引用卡/文本卡）创建 1 张任务卡` +
      `（POST {boardBase}/api/boards/{boardId}/cards，type=task，task.goal 写成可直接执行的目标，位置放在源卡右侧 480px）；` +
      `2) 用 POST {boardBase}/api/boards/{boardId}/edges 给「源卡 → 新任务卡」连 label 为「行动」的线；` +
      `3) ${TOKEN_NOTE}；4) 有 board_* MCP 工具则优先用。` +
      `不要修改用户已有卡片内容。完成后汇报新增了哪些任务卡。`,
  },
  {
    id: "builtin:progress-report",
    icon: "layers",
    title: "画板进展盘点",
    desc: "盘点所有画板里任务卡的状态与关联，输出一份结构化进展报告（只读不改）。",
    builtin: true,
    prompt:
      `盘点泼墨画板任务进展（只读，不修改任何数据）：` +
      `GET {boardBase}/api/boards 列出画板，GET {boardBase}/api/boards/tasks 拿全部任务卡；` +
      `对 status=running 且有 taskId 的卡，经 GET {goalAgentWeb}/api/runner/tasks/<taskId>（带请求头 x-goal-agent-web: 1）查最新状态和 summary。` +
      `输出 markdown 报告：按画板分组的任务状态表（想法/已建Issue/执行中/完成）、执行中任务的最新摘要、建议下一步关注的 3 件事。` +
      `报告写入工作目录 board-progress-report.md 并汇报路径。`,
  },
];

export const MAX_COMMAND_TITLE = 40;
export const MAX_COMMAND_DESC = 200;
export const MAX_COMMAND_PROMPT = 8000;
export const MAX_COMMAND_INPUT_HINT = 120;
/** 用户现填的那句话上限——别让整条 prompt 被一段长文顶爆 */
export const MAX_USER_INPUT = 4000;

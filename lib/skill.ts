/**
 * `/api/skill` 的拼装逻辑：现场生成「与本部署完全一致的 agent 指南」。
 *
 * 素材三块：
 *  1. `lib/skill-core.md` —— 与卡片包无关的核心章节（鉴权 / API 总表 / 评论 / 信封 / 深链 / 坑）；
 *  2. `cards/<type>/skill.md` —— 每个卡片包自带的小节，注册表（card-pack-store）驱动，
 *     **只拼启用的包**——装了什么说什么，skill 与部署永不漂移（OPEN-SOURCE-PLAN §6.4）；
 *  3. 代码生成的部分 —— 任务链路按 TASK_BACKEND 三选一、启用规格清单、能力摘要。
 *
 * 读取方式选**运行时读文件**而不是构建期打包：与模板（data/templates）、规格
 * （data/card-specs）同一套路——skill 片段是「随仓库走的资产」，运行时读省掉
 * bundler 配置，改一份 md 不用 rebuild 就能看到效果（生产下 Next 不会缓存 fs 读）。
 * 这个口一天被打不了几次，不做缓存。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, PUBLIC_URL } from "./config";
import { describeAuth } from "./auth";
import { FEATURES, TASK_BACKEND } from "./features";
import { listCardPacks } from "./card-pack-store";
import { listSpecs } from "./card-spec-store";
import { ENVELOPE_FORMAT, LEGACY_ENVELOPE_FORMATS } from "./card-spec-schema";
import { badRequest } from "./http";
import { RESOURCE_SPEC_ID, listResources } from "./resources";
import packageJson from "@/package.json";

/**
 * `?focus=` 的合法取值：**按 agent 手上的活分**，不是按文档目录分。
 *
 * 全量指南拼出来一两万字，而 agent 往往只是「往板上加几张卡」或「看看任务链路怎么回写」——
 * 让它整份读进上下文纯属浪费。这九个值覆盖九类活，可逗号分隔叠加。
 * 一个例外：**鉴权那节永远带上**（写接口没 token 一律 403，任何一类活都要先过这关），
 * 这条在 markdown 抬头也会写明，免得 agent 以为自己拿到的是残缺文档。
 */
export const SKILL_FOCUS = ["auth", "api", "cards", "comments", "specs", "envelope", "tasks", "links", "resources", "pitfalls"] as const;
export type SkillFocus = (typeof SKILL_FOCUS)[number];

export const SKILL_FOCUS_HINT: Record<SkillFocus, string> = {
  auth: "鉴权：token 在哪、用哪个头",
  api: "API 总表：读板 / 写板打哪个口",
  cards: "本部署启用的卡片包怎么建、专属字段与坑",
  comments: "评论工作流（用户交活的主要方式）",
  specs: "卡片规格与信封：结构化卡片怎么拼、怎么批量收发",
  envelope: "同 specs（信封是规格的另一半，两个词都认）",
  tasks: "任务链路：转 Issue、发起执行、回写契约",
  links: "深链约定：回报用户时给哪种链接",
  resources: "资源库：这台部署登记了哪些能直接装上用的 skill / 工具",
  pitfalls: "常见坑清单",
};

export interface SkillSection {
  id: string;
  title: string;
  body: string;
  /** 这节属于哪几类活（`?focus=` 按它筛；一节可以同时属于多类） */
  focus: SkillFocus[];
}

export interface SkillDocument {
  generatedAt: string;
  service: "blotboard";
  version: string;
  base: string;
  taskBackend: string;
  features: typeof FEATURES;
  /** 进了指南的卡片包（启用且依赖的服务已配置） */
  cards: string[];
  /** 启用但被略过的包（服务未配置，如 ref/book）——摘要里要交代，agent 不用瞎试 */
  cardsSkipped: string[];
  specs: string[];
  /** 引用资源库摘要（规格停用 / 未装时为 null——装了什么讲什么） */
  resources: { spec: string; page: string; api: string; total: number } | null;
  /** 本次筛了哪几类活；null = 全量 */
  focus: SkillFocus[] | null;
  sections: SkillSection[];
}

/**
 * token 怎么取的可复制片段：跟着部署的实际配置走（真源是 lib/auth.describeAuth，
 * 与 `/api/capabilities` 的 auth 段同一份）。**不写绝对路径**——这份指南会被复制、
 * 转发、贴进别人的 prompt，带上本机路径既没用也不该。
 */
/**
 * 三种生效源都给同一句 `cat 数据目录/token`。
 *
 * 曾经按源分岔，结果是最坑的一条：源为 goal-agent-settings 时教 agent 去读
 * `$BLOTBOARD_GOAL_AGENT_SETTINGS`——那个环境变量只存在于服务进程里，agent 自己的 shell
 * 是空的，照做必然失败；而 data/token 里躺着的又是早年自管形态的旧值，照拿必然 403。
 * 现在服务启动时会把生效值同步进 data/token（见 server.mjs 的 ensureAgentToken），
 * 所以这里只讲一条路——少一个岔口，就少一种踩空。
 */
function tokenShell(): string {
  const auth = describeAuth();
  const note =
    auth.source === "data-dir"
      ? "# 数据目录默认是仓库下的 data/（BLOTBOARD_DATA_DIR 可换），token 文件首次启动自动生成"
      : `# 本部署的 token 生效源是 ${auth.tokenEnv}，服务启动时已同步进这个文件——读它就行`;
  return [note, 'TOKEN=$(cat "${BLOTBOARD_DATA_DIR:-./data}/token")'].join("\n");
}

function readAsset(...parts: string[]): string | null {
  try {
    return fs.readFileSync(path.join(PROJECT_ROOT, ...parts), "utf8").trim();
  } catch {
    return null;
  }
}

/** 把一份 markdown 按 `## ` 切成分节（format=json 的结构；md 输出直接拼原文）。 */
function splitSections(markdown: string): SkillSection[] {
  const sections: SkillSection[] = [];
  const pattern = /^## +(.+)$/gm;
  const matches = [...markdown.matchAll(pattern)];
  matches.forEach((match, index) => {
    const start = match.index! + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index! : markdown.length;
    const title = match[1].trim();
    sections.push({
      id: `core-${index}`,
      title,
      body: markdown.slice(start, end).trim(),
      // 核心章节的 focus 在 buildSkillDocument 里按标题贴（这里只负责切分）
      focus: [],
    });
  });
  return sections;
}

/** 任务链路小节：按当前后端只讲用得上的那条路（RUNNER.md 是完整协议，这里是速查）。 */
function taskBackendSection(): SkillSection {
  if (TASK_BACKEND === "local") {
    return {
      id: "tasks",
      focus: ["tasks"],
      title: "任务链路（local 后端：Issue 就在画板里）",
      body: [
        "本部署没配外部 Runner，任务闭环全在画板本地：",
        "",
        "- 任务卡「转 Issue」（`POST /cards/{cid}/issue`）→ Issue 落画板数据目录的 issues.json，编号 L-1 起",
        "- 「发起执行」（`POST /cards/{cid}/launch`，body `{mode: implement|analyze, agentId?}`）两种玩法：",
        "  - 不带 `agentId` = 生成一份**完整 prompt**（Issue 正文 + 深链 + 回写指引）挂成待派 run，谁复制走谁执行；",
        "  - 带 `agentId` = 真拉起 Runner 设置里注册的 ACP agent 子进程跑（`GET /api/runner-settings` 看有哪些）。",
        "    同一 Issue 同时只允许一个在跑的 run（并发 409）。",
        "- **回写契约**（干完活要汇报，写口鉴权同上）：",
        "  - `PATCH /api/issues/{id}/runs/{runId}` `{status: running|waiting|completed|failed|aborted, note?}`",
        "  - `PATCH /api/issues/{id}` `{status?, labels?, note?}`（note 追加一条日志）",
        "  - run 状态会推动 Issue：running→in_progress、waiting/failed→blocked（进「等我处理」）、completed→done",
        "- 查账：`GET /api/issues?status=pending|in_progress|attention|done|aborted|all&board=&q=`（免鉴权），",
        "  `GET /api/issues/{id}` 给全字段 + runs + 完整 prompt；管理界面在 `/tasks` 任务台",
        "  （**本地 Issue 端点只有 local 后端才有**：接了外部 Runner 的部署打这个口会回 501 + 指路，那是设计不是坏了）",
        "",
        "完整协议（含 ACP 细节）见仓库 docs/RUNNER.md。",
      ].join("\n"),
    };
  }
  const backendName = TASK_BACKEND === "goal-agent" ? "Goal Agent Runner" : "自定义 http Runner";
  return {
    id: "tasks",
    focus: ["tasks"],
    title: `任务链路（${TASK_BACKEND} 后端：Issue 真源在外部 Runner）`,
    body: [
      `本部署把任务后端接到了 ${backendName}，红线一条：**Issue / 任务 / 会话的真源在 Runner，画板只存引用 id**，别在画板里复制业务状态。`,
      "",
      "- 任务卡「转 Issue」：`POST /cards/{cid}/issue`（幂等；画板上下文 + 未解决评论 + agentPrompt 自动拼进描述）",
      "- 单次覆盖上下文：body `{context: {mode: neighbors|upstream|downstream|all|none, types?: [...]}}`",
      "- 发起执行：`POST /cards/{cid}/launch` `{mode: implement|analyze}`（发起前画板会强制把最新正文推给 Runner）",
      "- 实时状态：`GET /api/boards/{id}/task-status`（batch 轮询 Runner，不落库）；跨板清单 `GET /api/boards/tasks`",
      "- **画板本地的 `/api/issues` 一律回 501 + 指路，这是设计不是坏了**（404 才是打错了口）：",
      "  本地 Issue 端点只在 local 后端下存在，本部署的真源在 Runner，别在画板里造第二份账本。",
      "  要看任务状态走 `GET /api/boards/{id}/task-status` 或 `GET /api/boards/tasks`，要看正文回 Runner 查",
      "",
      "Runner 协议的完整形状见仓库 docs/RUNNER.md（想换后端 / 自己实现一个也看它）。",
    ].join("\n"),
  };
}

/** 启用规格清单小节（只列启用的；字段表让 agent 按需现查，别在这里塞全量）。 */
function specsSection(specIds: string[], specRows: string[]): SkillSection {
  return {
    id: "specs",
    focus: ["specs", "envelope"],
    title: `已启用的卡片规格（${specIds.length} 份）`,
    body: [
      "建 data 规格卡 / 拼信封前，用 `GET /api/card-specs/{id}` 现查字段表（响应带人话说明块）。",
      "",
      "| 规格 id | 名称 | 用途 |",
      "| --- | --- | --- |",
      ...specRows,
    ].join("\n"),
  };
}

/**
 * 引用资源库小节：agent 的两类活都在这——「查有什么能用」与「发现好东西登记进来」。
 * 只在 agent-skill 规格启用时进指南（装了什么讲什么，与卡片包同一口径）。
 */
function resourcesSection(resourceIndex: ReturnType<typeof listResources>): SkillSection {
  const { total, counts } = resourceIndex;
  const kindBits = Object.entries(counts.kinds)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind}×${count}`)
    .join(" · ");
  return {
    id: "resources",
    focus: ["resources"],
    title: `引用资源库（${total} 条）`,
    body: [
      "这台部署维护着一个**引用资源库**：登记的都是能被 agent 直接装上用的外部资源（skill / MCP / CLI / 库），每条带安装方式、适配的 agent 与触发词。",
      "",
      "- **查有什么能用**：`GET /api/resources`（免鉴权）拿全量清单；`?q=关键词` 按 名称 / 用途 / 用法 / 安装 / 触发词 / 适配 agent 全文匹配，`?kind=skill&status=verified` 逐个过滤。响应带 `counts`（按类型 / 状态计数）与每条的画板深链。",
      "- **人看的页面**：`GET /resources`——给用户报「这里有什么资源」时给这个地址。",
      `- **登记新资源**：发现好东西就建一张 \`${RESOURCE_SPEC_ID}\` 规格卡（别另造存储）：\`POST /api/boards/{id}/cards\`，body \`{"type":"data","data":{"specId":"${RESOURCE_SPEC_ID}","fields":{"name":"…","purpose":"…","kind":"skill","url":"https://…","install":"…"}}\`；批量走信封并带上 \`source.externalId\`（同名资源再推一次是更新不是重复建卡）。字段表：\`GET /api/card-specs/${RESOURCE_SPEC_ID}\``,
      "- **状态要诚实**：`status` 五档（已验证 / 试用中 / 待装 / 不可用 / 已弃用）——没实测过的写「待装」，别冒充「已验证」；装完实测记得改状态并把手感写进 `notes`。",
      ...(total ? [""] : []),
      ...(total ? [`当前 ${total} 条${kindBits ? `（${kindBits}）` : ""}——每次以 \`GET /api/resources\` 实时返回为准，这份文档里的数字只是生成时刻的快照。`] : []),
    ].join("\n"),
  };
}

export function buildSkillDocument(base?: string): SkillDocument {
  const resolvedBase = (base || PUBLIC_URL).replace(/\/+$/, "");
  const packs = listCardPacks();
  const specs = listSpecs().filter((spec) => spec.enabled);
  // 引用资源库跟着规格走：规格启用才进指南与摘要（停用 ≠ 删数据，只是不再对外讲）
  const resourceIndex = specs.some((spec) => spec.id === RESOURCE_SPEC_ID) ? listResources() : null;

  // 启用的包才进指南；ref/book 还要求对应服务已配置——没配时入口整个隐藏，
  // 教 agent 建这两种卡只会撞 503，不如在摘要里说清「为什么没讲」
  const included: typeof packs = [];
  const skipped: string[] = [];
  for (const pack of packs) {
    if (!pack.enabled) continue;
    if (pack.type === "ref" && !FEATURES.search) {
      skipped.push(pack.type);
      continue;
    }
    if (pack.type === "book" && !FEATURES.library) {
      skipped.push(pack.type);
      continue;
    }
    included.push(pack);
  }

  const core = (readAsset("lib", "skill-core.md") || "")
    .replace(/<!--[\s\S]*?-->\s*/, "")
    .replaceAll("{{BASE}}", resolvedBase)
    .replaceAll("{{TOKEN_HINT}}", describeAuth().hint)
    .replaceAll("{{TOKEN_SHELL}}", tokenShell());

  const coreSections = splitSections(core);

  const packBodies = included.map((pack) => {
    const fragment = readAsset("cards", pack.type, "skill.md");
    return fragment || `### ${pack.label}（${pack.type}）\n\n（该卡片包没写使用说明，字段形状见仓库 cards/${pack.type}/）`;
  });
  const cardsSection: SkillSection = {
    id: "cards",
    focus: ["cards"],
    title: `已启用的卡片包（${included.length}/${packs.length}）`,
    body: [
      `建卡 \`POST /api/boards/{id}/cards\`，body 带 \`type\` 与对应专属字段。停用的包挡新建（400）但不影响已有卡片。${
        skipped.length ? `另有 ${skipped.map((type) => `\`${type}\``).join(" / ")} 包已启用但依赖的外部服务未配置，本部署建不了，略过不讲。` : ""
      }`,
      ...packBodies,
    ].join("\n\n"),
  };

  const specRows = specs.map((spec) => `| \`${spec.id}\` | ${spec.name} | ${spec.description.replace(/\|/g, "\\|")} |`);

  // 按标题关键词定位核心章节（不吃 skill-core.md 里的排列顺序），生成的小节插在约定的位置；
  // 顺手贴上 focus 标签——skill-core.md 是纯 markdown，标签只能在这里按标题给
  const coreByTitle = (keyword: string, focus: SkillFocus[], id: string): SkillSection | null => {
    const found = coreSections.find((section) => section.title.includes(keyword));
    return found ? { ...found, id, focus } : null;
  };
  const sections: SkillSection[] = [
    coreByTitle("鉴权", ["auth"], "auth"),
    coreByTitle("API", ["api"], "api"),
    cardsSection,
    // 安全网这节不单开一个 focus 值：它讲的是「打哪个口 + 别踩哪个坑」，
    // 跟着 api / pitfalls 走，agent 要哪一类活都不会漏掉它
    coreByTitle("改板安全网", ["api", "pitfalls"], "checkpoints"),
    coreByTitle("评论", ["comments"], "comments"),
    coreByTitle("规格与信封", ["specs", "envelope"], "envelope"),
    specsSection(specs.map((spec) => spec.id), specRows),
    ...(resourceIndex ? [resourcesSection(resourceIndex)] : []),
    taskBackendSection(),
    coreByTitle("深链", ["links"], "links"),
    coreByTitle("常见坑", ["pitfalls"], "pitfalls"),
  ].filter((section): section is SkillSection => Boolean(section));

  return {
    generatedAt: new Date().toISOString(),
    service: "blotboard",
    version: packageJson.version,
    base: resolvedBase,
    taskBackend: TASK_BACKEND,
    features: FEATURES,
    cards: included.map((pack) => pack.type),
    cardsSkipped: skipped,
    specs: specs.map((spec) => spec.id),
    resources: resourceIndex
      ? { spec: RESOURCE_SPEC_ID, page: "/resources", api: "/api/resources", total: resourceIndex.total }
      : null,
    focus: null,
    sections,
  };
}

/**
 * 猜错的那些值该往哪儿指。
 *
 * `SKILL_FOCUS` 是**按活分**的，不是按功能分的，所以「我只想改布局」这种明确的活
 * 反而没有同名的 focus——整理口在 API 总表那节里。光回一句「不是合法取值 + 十个候选」
 * 等于让 agent 自己去十个里面猜，而这十个名字里没有一个长得像「layout」。
 * 外部桥接 Skill 就是这么漂移出 `focus=layout` 的（它写的能力是真的，
 * 只是这台服务把它归在 `api` 那节）。
 *
 * 这里**不做静默别名**：静默接受等于把「写错了」和「本来就该这么写」混成一件事，
 * 下一份文档照抄错的那个。400 照旧，只是把正确的去处一并说清楚。
 */
const FOCUS_MISSES: { match: RegExp; hint: string }[] = [
  {
    match: /^(layouts?|tidy|arrange|position|geometry|布局|整理)$/,
    hint: "整理 / 布局不单开一类活：整理口 `POST /api/boards/{id}/tidy` 在 `api` 那节，十一种模式的清单看 `/api/capabilities` 的 layouts；只挪位置不动内容还有 `PUT /api/boards/{id}/state`",
  },
  {
    match: /^(export|import|bundle|backup|migrate|搬家|备份|导入|导出)$/,
    hint: "搬家（导出 / 导入 / 画板包）跟着 `api` 走：`GET /api/boards/export` 与 `POST /api/boards/import`",
  },
  { match: /^(card|卡片)$/, hint: "卡片那节叫 `cards`（复数）" },
  { match: /^(comment|批注|评论)$/, hint: "评论那节叫 `comments`（复数）" },
  { match: /^(spec|规格)$/, hint: "规格那节叫 `specs`（复数）；信封是它的另一半，`envelope` 也认" },
  { match: /^(task|issue|任务)$/, hint: "任务那节叫 `tasks`（复数）" },
  { match: /^(link|deeplink|深链)$/, hint: "深链那节叫 `links`（复数）" },
  { match: /^(pitfall|坑)$/, hint: "常见坑那节叫 `pitfalls`（复数）" },
];

/**
 * `?focus=cards,tasks` 的解析：不认识的值直接 400 并列出合法值。
 *
 * 为什么不静默忽略：写错一个 focus 就会拿到一份「少了几节」的指南，而 agent 无从分辨
 * 「这台部署没有这个能力」和「我参数打错了」——跟 color 那个 bug 是同一类错误。
 * 空 / 不传返回 null = 全量。
 */
export function parseSkillFocus(raw: string | null): SkillFocus[] | null {
  const wanted = (raw || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!wanted.length) return null;
  const bad = wanted.filter((item) => !(SKILL_FOCUS as readonly string[]).includes(item));
  if (bad.length) {
    const hints = [...new Set(bad.flatMap((item) => FOCUS_MISSES.filter((miss) => miss.match.test(item)).map((miss) => miss.hint)))];
    throw badRequest(
      `focus「${bad.join("、")}」不是合法取值——可选：${SKILL_FOCUS.join(" / ")}（可逗号分隔，不传 = 全量）` +
        (hints.length ? `。${hints.join("；")}` : ""),
    );
  }
  return [...new Set(wanted)] as SkillFocus[];
}

/** 按 focus 裁一份指南；鉴权那节永远留着（没 token 什么都干不了）。 */
export function focusSkillDocument(doc: SkillDocument, focus: SkillFocus[] | null): SkillDocument {
  if (!focus) return doc;
  const keep = new Set<SkillFocus>([...focus, "auth"]);
  return {
    ...doc,
    focus,
    sections: doc.sections.filter((section) => section.focus.some((tag) => keep.has(tag))),
  };
}

export function renderSkillMarkdown(doc: SkillDocument): string {
  const featureBits = [
    `任务后端 ${doc.taskBackend}`,
    doc.features.search ? "知识库检索 ✓" : "知识库检索 ✗",
    doc.features.library ? "书库 ✓" : "书库 ✗",
  ];
  return [
    "# Blotboard · 泼墨画板 —— 本部署的 agent 指南",
    "",
    `> 生成于 ${doc.generatedAt} · blotboard v${doc.version} @ ${doc.base}`,
    `> ${featureBits.join(" · ")} · 卡片包 ${doc.cards.length} 种 · 规格 ${doc.specs.length} 份${
      doc.resources ? ` · 引用资源 ${doc.resources.total} 条（\`${doc.resources.api}\`）` : ""
    } · 信封 \`${ENVELOPE_FORMAT}\`（兼收 ${LEGACY_ENVELOPE_FORMATS.map((format) => `\`${format}\``).join("/")}）`,
    `> 这份指南按部署实际启用的能力**现场拼装**——装了什么讲什么，不会过期。机器可读版：\`GET /api/capabilities\``,
    ...(doc.focus
      ? [
          `> ⚠️ 本次只输出 \`focus=${doc.focus.join(",")}\` 的章节（鉴权那节始终附上）。要全量就去掉 focus 参数；` +
            `可选值：${SKILL_FOCUS.join(" / ")}`,
        ]
      : []),
    "",
    ...doc.sections.map((section) => `## ${section.title}\n\n${section.body}\n`),
  ].join("\n");
}

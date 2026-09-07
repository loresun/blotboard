import { ok, route } from "@/lib/http";
import { describeAuth } from "@/lib/auth";
import { PORT } from "@/lib/config";
import { FEATURES, TASK_BACKEND } from "@/lib/features";
import { BOARD_ACTIVITY_ACTIONS, BOARD_CARD_TYPES } from "@/lib/types";
import { HISTORY_LIMIT, HISTORY_MAX_BYTES } from "@/lib/board-history";
import { checkpointKeep, checkpointsEnabled } from "@/lib/checkpoints";
import { listCardPacks } from "@/lib/card-pack-store";
import { LAYOUT_MODES } from "@/lib/layout";
import { SKILL_FOCUS, SKILL_FOCUS_HINT } from "@/lib/skill";
import { ENVELOPE_FORMAT, LEGACY_ENVELOPE_FORMATS } from "@/lib/card-spec-schema";
import { BOARD_BUNDLE_FORMAT, BOARD_BUNDLE_VERSION } from "@/lib/board-bundle";
import { listSpecs } from "@/lib/card-spec-store";
import { RESOURCE_SPEC_ID, listResources } from "@/lib/resources";
import packageJson from "@/package.json";

export const dynamic = "force-dynamic";

/**
 * 能力自描述（免鉴权只读，OPEN-SOURCE-PLAN §6.3）：agent / 兄弟服务探一次就知道
 * 这个部署「是什么、开了哪些可选集成、认哪些卡、收哪种信封」——不用再靠
 * skill 文档与部署之间的口头约定。/api/health 管「活没活着」，这里管「会什么」。
 */
export const GET = route(async () => {
  const specs = listSpecs();
  return ok({
    service: "blotboard",
    version: packageJson.version,
    port: PORT,
    features: FEATURES,
    /** 写操作怎么鉴权：agent 探一次就知道 token 在哪、用什么头，不用撞 403 再猜。
        tokenFile 是相对表述（`<数据目录>/token`），不吐本机绝对路径 */
    auth: describeAuth(),
    /** 任务后端种类（local / goal-agent / http，选择次序见 lib/features.ts）：
        agent 据此决定「转 Issue 落在哪、发起任务是派单还是生成 prompt」 */
    tasks: { backend: TASK_BACKEND },
    /** 卡片包清单（type + 开关）；cardTypes 是它的旧形状，兼容保留一个大版本后再撤 */
    // 带上 defaultEnabled：agent 看到 enabled:false 时能分清是「用户关掉了」还是
    // 「这个包本来就默认不装」——后者要先开开关才能建卡（cardPacks.toggle 指的就是那条口）
    cards: listCardPacks().map(({ type, enabled, defaultEnabled }) => ({
      type,
      enabled,
      defaultEnabled,
      ...(enabled ? {} : { requiresEnable: true }),
    })),
    cardPacks: {
      toggle: "PATCH /api/card-packs",
      hint: "停用的包不能新建这类卡（已有卡片照常显示与导出）；开：PATCH /api/card-packs {\"enabled\":{\"<type>\":true}}",
    },
    cardTypes: BOARD_CARD_TYPES,
    specs: {
      enabled: specs.filter((spec) => spec.enabled).map((spec) => spec.id),
      total: specs.length,
    },
    /**
     * 引用资源库（lib/resources.ts）：散在各板上的 agent-skill 规格卡的聚合视图。
     * agent 探到 `enabled: true` 就知道这台部署有资源可查（`GET /api/resources`）
     * 、发现好东西该往哪登记（建 agent-skill 规格卡）；`count` 是当前条数。
     */
    resources: {
      enabled: specs.some((spec) => spec.id === RESOURCE_SPEC_ID && spec.enabled),
      spec: RESOURCE_SPEC_ID,
      api: "/api/resources",
      page: "/resources",
      count: listResources().total,
    },
    envelope: { format: ENVELOPE_FORMAT, legacy: LEGACY_ENVELOPE_FORMATS },
    /**
     * 整块板 / 整批板的搬运（lib/board-bundle.ts）：与卡片信封分工不同——
     * 信封是「往一块已有的板里送卡片」，画板包是「把板本身端走 / 端回来」。
     * agent 探到这一节就知道备份、迁移、分享该打哪个口，不用再猜格式名。
     */
    transfer: {
      format: BOARD_BUNDLE_FORMAT,
      version: BOARD_BUNDLE_VERSION,
      export: "/api/boards/export?ids=b_a,b_b|group=项目|all=1&format=json|html|md",
      exportOne: "/api/boards/{id}/export?format=bundle",
      import: "POST /api/boards/import",
      modes: ["copy", "restore"],
      onConflict: ["skip", "replace", "copy"],
      accepts: ["画板包 JSON", "单块板 JSON（format=json）", "排版导出的 HTML（末尾带载荷）"],
      assets: "包里带附件字节（base64），总量上限 24 MB；HTML 产物的图片从正文 data URI 还原",
      hint: "导入默认 copy（一律新建、不动已有的板）；恢复自己的备份用 mode=restore&onConflict=replace",
    },
    /**
     * 改板安全网：批量写入前的自动快照（lib/checkpoints.ts）。
     * agent 探到 `enabled: true` 就知道「大改不用先手动备份，系统会打点；砸了让用户回滚」；
     * 探到 false（部署把 keep 设成 0）就该在动手前自己 `GET …/export?format=json` 留一份。
     */
    history: {
      list: "/api/boards/{id}/history",
      step: "POST /api/boards/{id}/history",
      actions: ["undo", "redo"],
      requiredVersionHeader: "x-board-since",
      maxEntries: HISTORY_LIMIT,
      maxBytes: HISTORY_MAX_BYTES,
      editMergeMs: 2000,
      persistent: true,
      viewportRecorded: false,
      taskExecutionReversible: false,
    },
    checkpoints: {
      enabled: checkpointsEnabled(),
      keep: checkpointKeep(),
      reasons: BOARD_ACTIVITY_ACTIONS,
      list: "/api/boards/{id}/checkpoints",
      restore: "POST /api/boards/{id}/checkpoints/{stamp}/restore",
      activity: "/api/boards/{id}/activity",
    },
    /** 服务端支持的整理模式（`POST /api/boards/{id}/tidy` 的 mode / MCP board_layout）：
        列出来 agent 就不用猜 mode 怎么拼、哪种模式是干什么的。真源 lib/layout.ts 的 LAYOUT_MODES */
    layouts: LAYOUT_MODES,
    /**
     * mermaid 的**诚实声明**：浏览器里跑的是真 mermaid（任意语法都渲得出来），
     * 但服务端导出（单文件 HTML / 排版打印）只有流程图能渲成矢量图，其余降级成源码块
     * （原因见 lib/mermaid-flow.ts 的抬头：把 mermaid 打进离线产物要 8MB，服务端跑它又缺 DOM 量文字）。
     * 不另开 `/api/mermaid-capabilities`：agent 探能力只该打一个口，多一个端点就多一处会漂移的真相。
     */
    mermaid: {
      clientRenders: "任意 mermaid 语法（卡面在浏览器里跑真 mermaid）",
      serverExport: ["flowchart"],
      serverFallback: "非流程图在服务端导出里降级成源码块，不会画错",
      /** 图表卡（chart）走的是同一条客户端渲染路径，但服务端导出的降级方式不同——
          它有结构化数据可摆，所以出数据表而不是源码块（见 cards/chart/export.ts） */
      chartCard: "chart 卡在浏览器里同样用 mermaid 渲染；服务端导出降级成数据表 + 一行说明",
    },
    /** 人话版的实操指南（按本部署启用内容现场拼装）；这里是机器可读清单，那里是给 agent 读的 */
    skill: "/api/skill",
    agentOnboarding: {
      page: "/agent",
      install: "/api/skill?format=install",
      quickstart: "/api/skill?format=md&focus=api,pitfalls,links",
      format: "SKILL.md",
      credentialsIncluded: false,
    },
    /** `/api/skill?focus=` 的合法取值：只要相关章节，别把一两万字全读进上下文。
        鉴权那节永远附带。字段单开一个而不是改 skill 的形状——已经有调用方拿 skill 直接拼 URL 了 */
    skillFocus: {
      usage: "/api/skill?focus=cards,tasks",
      values: SKILL_FOCUS.map((value) => ({ value, hint: SKILL_FOCUS_HINT[value] })),
      always: "auth",
      /** 这几类活**没有**同名 focus，写了会 400；照实说去哪儿找，别让调用方自己在十个名字里猜
          （外部桥接 Skill 就是这么把 focus 写成 `layout` 的） */
      notSections: [
        { wanted: "layout", where: "api", note: "整理口 POST /api/boards/{id}/tidy 在 api 那节；模式清单看本文件的 layouts" },
        { wanted: "export / import", where: "api", note: "搬家两条口 GET /api/boards/export 与 POST /api/boards/import 都在 api 那节" },
      ],
    },
  });
});

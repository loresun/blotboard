/**
 * `/llms.txt` 的正文：**现场拼装**这台部署的「我是谁 / 我怎么调」一页纸。
 *
 * 为什么不落成仓库里的静态文件：那份文件写的是某一台机器的地址、端口与开关，
 * 属于**部署状态而不是源码**（scripts/source-policy.mjs 的发布边界据此拒收根目录
 * 那个 llms.txt），而且换个端口、换个任务后端就当场过期，读它的 agent 无从察觉。
 *
 * 所以走 /api/skill 同一套路：静态的部分（接口表、坑、文件入口）写在代码里随仓库走，
 * 会变的部分（地址、端口、启用了什么、token 在哪）每次请求现算——**文档与部署永不漂移**。
 *
 * 这个口免鉴权，所以与 /api/health 同一条红线：**绝对路径不进正文**（`/Users/<名字>/…`
 * 会把机器主人的用户名和目录结构送出去）。token 的位置一律用 describeAuth() 的相对表述。
 */
import { PORT } from "./config";
import { describeAuth } from "./auth";
import { FEATURES, TASK_BACKEND, type TaskBackendKind } from "./features";
import { listCardPacks } from "./card-pack-store";
import { listSpecs } from "./card-spec-store";
import { LAYOUT_MODES } from "./layout";
import packageJson from "@/package.json";

/** 任务后端三选一，各自一句话——agent 据此知道「转 Issue 落在哪、发起任务是派单还是生成 prompt」。 */
const BACKEND_LABEL: Record<TaskBackendKind, string> = {
  local: "内置 local（Issue 落在数据目录，「发起任务」生成 prompt 供复制，不派单）",
  "goal-agent": "外部 Goal Agent Runner（`GOAL_AGENT_RUNNER_URL`）——Issue 与执行的真源在 Runner 那边",
  http: "通用 HTTP Runner（`BLOTBOARD_RUNNER_URL`）——Issue 与执行的真源在 Runner 那边",
};

/** 接口总表是仓库知识（跟着代码走），不随部署变，写死在这儿即可。 */
const ENDPOINTS: [string, string, string][] = [
  ["GET", "/api/health", "免鉴权健康 / 能力摘要（端口、boards 数、token 来源）"],
  ["GET", "/api/capabilities", "机器可读能力清单：卡片包、layouts、信封格式、skillFocus 合法值"],
  ["GET", "/api/boards", "列出所有画板（id / name / 计数），免鉴权"],
  ["GET", "/api/boards/{id}", "读单板（cards + edges + tasks + comments），免鉴权"],
  ["POST", "/api/boards", "新建画板，需 `x-auth-key`"],
  ["GET", "/api/boards/export", "一批板打成画板包（`?ids=`/`group=`/`all=1`，`format=json|html|md`），免鉴权"],
  ["POST", "/api/boards/import", "收一份导出文件（画板包 / 单板 JSON / 排版 HTML）立成新板，需 `x-auth-key`"],
  ["GET", "/api/docs", "帮助文档目录；`?slug=quickstart&format=md` 返回裸 Markdown"],
  ["GET", "/api/skill", "本部署专属 SKILL.md；`?format=md&focus=cards,tasks` 按主题裁剪"],
  ["GET", "/api/templates", "内置模板清单"],
  ["GET", "/api/card-specs", "已启用的卡片规格（每类一份字段 schema）"],
  ["GET", "/api/resources", "本部署登记的资源库（skill / MCP / CLI）"],
  ["GET", "/api/issues", "任务 / Issue 列表（写操作需 token）"],
  ["GET", "/agent", "agent 接入引导页（装 skill、复制提示词）"],
  ["GET", "/docs", "给人看的帮助文档（同 `/api/docs`）"],
];

/**
 * 渲染这台部署的 llms.txt。
 *
 * @param origin 调用方此刻访问的地址（`lib/http.ts` 的 requestOrigin 算出来的）。
 *   样例里的 base 跟着它走，与导出产物同一条理由：写死 127.0.0.1 换台机器全是死链。
 */
export function renderLlmsTxt(origin: string): string {
  const base = origin.replace(/\/+$/, "");
  const packs = listCardPacks();
  const enabledPacks = packs.filter((pack) => pack.enabled).length;
  const specs = listSpecs().filter((spec) => spec.enabled).length;
  const auth = describeAuth();
  const optional = [
    `资料卡检索（知识库）${FEATURES.search ? "已配置" : "未配置"}`,
    `图书卡（本机书库）${FEATURES.library ? "已配置" : "未配置"}`,
  ].join(" · ");

  return `# Blotboard 泼墨画板（人与任何 agent 共用的本地优先画板）

> Next.js + React Flow 写的一块画板，给人和给 agent 的是同一块板：卡片 + 连线，读接口免鉴权、写接口要 token。
> 这一页**由服务现场生成**，讲的就是你此刻访问的这台部署——端口、开关、token 位置都是当前生效值，不是某台机器的快照。

## 身份

- **服务地址**: ${base}
- **端口**: ${PORT}（\`BLOTBOARD_PORT\` 改；默认被占会顺延，\`BLOTBOARD_PORT_STRICT=1\` 关掉顺延）
- **版本**: ${packageJson.version}
- **框架**: Next.js + React + 自定义 \`server.mjs\`（可信地址闸门在 Next 之前）
- **数据源**: 数据目录下一块板一个 JSON（\`<数据目录>/boards/\`）；浏览器 IndexedDB 是可选的另一份数据世界
- **能力面**: ${enabledPacks}/${packs.length} 类卡片包已启用 · ${LAYOUT_MODES.length} 种整理布局 · ${specs} 份卡片规格（信封批量收发）· 任务→Issue
- **任务后端**: ${BACKEND_LABEL[TASK_BACKEND]}
- **可选集成**: ${optional}（口径是「配了地址才算有」，不探活不猜测）
- **写操作鉴权**: 请求头 \`${auth.header}\`（浏览器同源走 \`${auth.webHeader}\`）；${auth.hint}
- **可信地址闸门**: 默认只放本机 / 私网 / Tailscale(100.64/10) / 链路本地，其余一律 403（看 TCP \`remoteAddress\`，不是可伪造的 \`x-forwarded-for\`）；要监听 \`0.0.0.0\` 先读 README「放到公网前想清楚」

## 业务接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
${ENDPOINTS.map(([method, route, use]) => `| ${method} | \`${route}\` | ${use} |`).join("\n")}

## 调用样例

\`\`\`bash
# 健康与能力（免鉴权）
curl --noproxy '*' -sS ${base}/api/health | python3 -m json.tool
curl --noproxy '*' -sS ${base}/api/capabilities | python3 -m json.tool

# 读板
curl --noproxy '*' -sS ${base}/api/boards | python3 -m json.tool
curl --noproxy '*' -sS ${base}/api/boards/b_xxx | python3 -m json.tool

# 写板（token 见上面「写操作鉴权」，一律从数据目录的 token 文件取，别写死在脚本里）
curl --noproxy '*' -sS -X POST ${base}/api/boards \\
  -H "${auth.header}: $TOKEN" -H "content-type: application/json" \\
  -d '{"name":"第一块板"}'

# 拉本部署专属的 agent Skill（按主题裁剪）
curl --noproxy '*' -sS "${base}/api/skill?format=md&focus=cards,tasks,pitfalls"
\`\`\`

\`\`\`python
# Python (httpx)
import httpx
r = httpx.get("${base}/api/capabilities", timeout=5)
print(r.json()["cardTypes"][:5])
\`\`\`

## 必踩坑

- **端口别写死**：这台此刻监听 ${PORT}，被占时会自动顺延到下一个，所以别把它抄进脚本；权威值是 \`GET /api/health\` 的 \`port\` 字段与启动日志。
- **可信网段闸门**：默认只放本机 / 私网 / Tailscale / 链路本地直连。要对外必须过反代，别去关闸门。
- **token 不要硬编码**：三级来源（env \`BLOTBOARD_INTERNAL_TOKEN\` > \`BLOTBOARD_GOAL_AGENT_SETTINGS\` 指向的 settings.json > 数据目录自管），生效值启动时会镜像到数据目录的 token 文件，agent 一律现读那个文件。
- **生产 \`.next\` 不能被覆盖**：\`scripts/build-guard.mjs\` 会拒绝；\`npm run build\` 前先停掉同一个工作区的旧进程。
- **读免鉴权 / 写要 token**：GET 全部免鉴权；写操作必须带 \`${auth.header}\`（agent）或同源 + \`${auth.webHeader}\`（浏览器）。
- **停用的卡片包不能建卡**：\`GET /api/capabilities\` 的 \`cards\` 里 \`enabled:false\` 的类型要先开开关（\`PATCH /api/card-packs\`）。
- **npm 占位包**：npm 目录上还是占位包，别 \`npx blotboard\` 装；MCP 接入在仓库目录 \`npm link\`。
- **深链 \`?board=&card=\`** 稳定可用；\`/\` 是画板直达入口，第一次用走 \`/start\` 选数据归属。

## 文件入口

- \`server.mjs\`（自定义 Next 服务 + 可信地址闸门 + token 镜像）
- \`app/api/llms.txt/route.ts\` + \`lib/llms-txt.ts\`（**这一页**：现场拼装，不落静态文件）
- \`app/api/health/route.ts\`、\`app/api/capabilities/route.ts\`、\`app/api/boards/route.ts\`、\`app/api/skill/route.ts\`
- \`lib/http.ts\`（统一 \`{ok, error}\` 响应壳）、\`lib/auth.ts\`（token 校验）、\`lib/features.ts\`（功能开关唯一真源）
- \`README.md\`（部署、env 总表、「放到公网前想清楚」一节）、\`AGENTS.md\`（数据约定与 agent 协作规则）
`;
}

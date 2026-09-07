# goal-board 开源版方案 v2（Open Source Plan）

> 2026-09-01。基于两轮全库审查（私有耦合 + 品牌命名）+ runner 生态调研。
> **v2 变更（用户拍板）**：不在现仓库渐进改造，而是**新建项目、完全重构、跑在 8567**；
> 共用当前数据源；十几种卡片全部做成**预设插件**，可按需保留/去掉；
> 缺某种卡片的解析器不影响其他卡片——彻底可插拔。

---

## 0. 决策记录（2026-09-01）

| 决策 | 内容 |
| --- | --- |
| 落地方式 | **新项目 + 完全重构**，端口 **8567**，与 旧版画板 并行开发 |
| 数据 | **与 旧版画板 同一套数据格式**（每板一文件 + `_index.json` + uploads），8567 能直接读现有画板 |
| 卡片体系 | 现有卡片（起步 16 种，现 21 种）→ **预设插件包**，配置开关按需保留/去掉；无解析器的卡片优雅降级，不影响整板 |
| 命名 | ✅ **已定（2026-09-01）：Blotboard · 泼墨画板**。npm `blotboard` 空闲、GitHub 仅 0–1★ 小仓无冲突（已核查）。待办：npm 占位发布 + GitHub org + 域名（blotboard.dev / .app） |
| 协议 | MIT 全仓统一，无需 CLA（DCO 可选，见 §5） |
| Runner | 协议化 + 多适配器，对齐 ACP 生态（见 §4） |

---

## 1. Runner 生态调研：接任意 agent 的开源先例

「画板卡片 → 派给任意 agent」不是孤例，2025–2026 已长出一层标准和产品，直接拿来对齐：

### 1.1 ACP（Agent Client Protocol）——行业标准，优先对齐

- Zed 发起的开放 JSON-RPC 标准，被称为「coding agent 界的 LSP」：客户端（编辑器/面板）与 agent 之间的通用契约，打破「每个客户端 × 每个 agent 各写一遍集成」
- 现状：Gemini CLI 原生 `--acp`；Claude Code 经 `claude-agent-acp` 适配器；Codex/OpenCode/Qwen Code 等均有接入；JetBrains、Zed、Neovim、VS Code 插件都是 ACP 客户端
- **2026-01 上线了 ACP Registry**，agent 发现与接线的摩擦进一步降低；remote transport 在路线图上
- 对我们的意义：**8567 实现一个 ACP 客户端 runner，等于一次接入整个 agent 生态**——用户在配置里选「用哪个 agent」，就像编辑器里选外部 agent 一样

### 1.2 vibe-kanban（BloopAI）——最接近的产品同类

- 开源看板：卡片拖进「In Progress」自动开 git worktree、启动所配 agent、UI 里看 diff/日志、可开 PR
- 支持 10+ 执行器（Claude Code / Codex / Gemini CLI / Copilot / Amp / Cursor / OpenCode / Droid / Qwen…），核心抽象是 **executor profile**（每种 agent 一份「怎么拉起、怎么读输出」的配置）
- 已从商业产品转为社区维护的纯开源——验证了这个方向有需求，也说明纯卖这层功能变现难（对 §5 协议选择是个输入）
- 与我们的差异化：vibe-kanban 是**纯任务看板**；我们是**思考画布 + 任务派发**（卡片有十几种、有连线语义/评论/规格/信封），任务只是其中一环

### 1.3 coder/agentapi——现成的「万能适配器」

- Go 写的 HTTP API 服务器，用终端仿真统一控制 Claude Code / Aider / Goose / Gemini / Codex / Amp / Cursor CLI 等 10+ agent
- 对我们的意义：8567 的 `http` runner 直接把 agentapi 当后端，**零成本获得多 agent 支持**——不用自己维护每种 agent 的拉起逻辑

### 1.4 结论：8567 的 runner 层设计

```
runners/
  local/       内置 Issue 存储 + 「复制完整 prompt」（开源默认，零依赖闭环，永远保留）
  acp/         ★ 本机派单主力：ACP 客户端，spawn 任意 ACP agent 子进程（标准生态一接全通）
  http/        逃生口：跨机器 / 自定义后端（agentapi 即现成后端；goal-agent 私有适配也走这）
```

- **ACP 是双向协议**（JSON-RPC 2.0，已核实 2026-09）：画板 → agent 是 `session/new·prompt·cancel·load`；
  agent → 画板是 `session/update` 流式进展（消息块/思考/工具调用/计划）+ `session/request_permission` 权限回传。
  任务抽屉最难的三件事（实时 transcript、中断、权限确认）协议原生就有——**所以 ACP 进 v1，不放 v1.x**
- ACP 的两个现实约束（http 适配器因此保留）：① 目前是本机子进程模型，remote transport 尚在路线图——跨机器派单走 http→对端 agentapi；② 长时后台任务要 8567 自己管子进程生命周期 + 权限策略（用户不在时 request_permission 的自动批准档位/挂起）
- **Runner 协议**只有 4 个动作：`createIssue / patchIssue / launch / getTask`（现仓库审查确认调用点仅 5 处，形状已收敛）——写成 `docs/RUNNER.md`（MIT）
- 三方协议均无约束：agentapi MIT、vibe-kanban Apache-2.0、ACP 规范 Apache-2.0（均已核实）

---

## 2. 命名

**✅ 已定：Blotboard · 泼墨画板**（用户拍板，2026-09-01）。npm `blotboard` 404 空闲，GitHub 同名仓均 0–1★ 无冲突。品牌语义双关：plot（构思/情节/布局）+ 泼墨（挥洒、写意——「把想法摊开」的气质）。UI brand 用「泼墨画板」，英文语境 Blotboard；「画板/子画板」保留为通用词。

以下为定名前的候选记录（存档）。`goboard` 被占用。已核查 npm registry + GitHub（2026-09-01）：

| 候选 | npm | GitHub | 评价 |
| --- | --- | --- | --- |
| **tanban** | ✅ 空闲 | 仅 9★ 以下小仓 | **首选**。看板 kanban → 摊板 tanban；产品第一动词就是「把想法**摊**开」。中英都好念，独一无二 |
| everboard | ✅ 空闲 | 有 40★ EverBoard | 与 everywebcode 同族，但撞了小有名气的仓 |
| driftboard / cardfield / cardplane | ✅ 空闲 | 干净 | 意象偏弱 |
| agentboard / boardkit / goban / openboard / freeboard | ❌ 占用 | — | 排除 |

定名后立刻：npm 占位发布 + GitHub org + 域名（tanban.dev / tanban.app 下单前再查）。

UI 命名：brand 用产品名；「画板」保留为通用词；「子画板」是描述词可不改（要新鲜感可用「嵌套画板」）。

---

## 3. 8567 新项目架构：卡片全预设、彻底可插拔

### 3.0 四层分层与三级渲染（2026-09-01 讨论定型）

```
① 内核（headless，不认识任何卡片类型）：存储 · 公共 schema · API · 信封 · 评论 · 上传 · 鉴权
② 画布壳（渲染宿主）：React Flow 画布 · 工具条 · 侧栏 · 搜索 · 聚焦 · /nav 导航页
③ 卡片包 × 16：每种一个目录，同一接口，槽位全部可缺省
④ 横切服务：阅读模式 · 导出 · 搜索 —— 是内核的「遍历器」，对每张卡问
   「有自定义渲染吗？没有就用通用降级」。不是每种卡自己的功能。
```

渲染能力三级——**规格卡不是十六分之一种卡片，它是中间层的引擎**：

| 级 | 是什么 | 加一种卡的成本 |
| --- | --- | --- |
| Tier 0 | 内核兜底渲染：标题 + 正文 + 折叠字段表 | 零（未知类型自动落这） |
| Tier 1 | **规格卡引擎**：JSON 声明 display（title/subtitle/body/badges/link/time + 扩 `media` 槽含图） | 一个 JSON，热插拔 |
| Tier 2 | 代码卡片包：任意渲染器 + 数据源 + 服务端代理 | 一个目录 + rebuild |

**能力下沉原则**：每个 Tier 2 需求先问「能不能下沉为 Tier 1 的声明式特性」。
封面图下沉为 `media` 后，「图书卡」从代码插件退化成一份规格 JSON——Tier 1 越宽，
要写代码的场景越少，生态门槛越低。「svg+数据」组合卡是纯 Tier 1 需求。

### 3.1 目录骨架（插件优先，而不是先写死再抽）

```
core/                      # 画板内核：与任何卡片类型无关
  schema/                  #   卡片公共字段（id/title/content/x/y/w/h/z/color/agentPrompt）
                           #   + 未知类型兜底渲染（题 + 正文 + 折叠的原始字段表）
  storage/                 #   与 旧版画板 相同的数据格式（每板一文件 + _index.json，原子写 + mtime）
  api/                     #   boards / cards / edges / comments / state / whole / ingest / export
  envelope/                #   卡片信封（validate / strict / lenient / externalId 判重）
  auth/  origins/  embed-allow/
cards/                     # ★ 预设卡片包：21 种全部走同一接口，一种一个目录
  text/ task/ link/ quote/ image/ pdf/ todo/ mindmap/
  mermaid/ svg/ excalidraw/ board/ html/ data/(规格卡引擎)
  code/ table/ chart/       #   第二波（2026-09-02）：代码 / 表格 / 数据图
  ref/ book/               #   这两个默认关闭（开源版不带 provider，接口留着）
plugins/                   # 用户/私有插件目录（结构与 cards/ 完全一致，不进公开仓）
runners/                   # local / http / acp（见 §1.4）
data/card-specs/           # Tier-1 声明式规格（JSON 热插拔，沿用现有体系）
```

### 3.2 卡片插件接口（一种卡片 = 一个目录）

```ts
interface CardPack {
  type: string                          // 唯一 id，也是数据里的 card.type
  meta: { label; icon; defaultSize; defaultColor }
  schema: {                             // 服务端：专属字段的归一化/校验（现 board-schema 的分支拆进来）
    normalize(input): Field | null
    searchText?(card): string           // 全文检索贡献
  }
  ui?: {                                // 前端：缺省走通用渲染器
    CardFace?; FullView?; Editor?
    toolbar?: { button | drawer }       // 工具条入口；带采集抽屉的（书库/知识库）在这声明
  }
  export?: { html?(card, ctx); markdown?(card) }   // 服务端导出贡献
  provider?: DataProvider               // 出网数据源（仅 server 侧执行；书库/知识库/数据库卡用）
  routes?: RouteDef[]                   // 需要的服务端代理端点（如封面代理）
}
```

注册与开关：
- **与 React Flow 的关系（2026-09-01 定）**：沿用现仓库的单壳模式——React Flow 的 `nodeTypes` 只注册一种 `card` 节点（壳：四边 Handle 锚点 / NodeResizer / 选中态 / 评论挂点），卡片包只填壳内的 `CardFace` 槽位。**卡片包不映射成 React Flow nodeTypes**：壳的一致性不交给插件作者；避开官方「nodeTypes 必须是稳定常量」的重渲警告（开关驱动的动态 nodeTypes 会触发它）
- **官方组件优先（2026-09-01 用户拍板）**：画布层尽量用 React Flow 官方件实现，我们只自定义两样——**节点内容**（CardFace）与**输入输出**（Handle 布局 + 连线语义）。现仓库已经是这个底子（Background/Controls/MiniMap/SelectionMode/ConnectionMode、BaseEdge+EdgeLabelRenderer 的自定义边、ViewportPortal 的评论气泡、Handle+NodeResizer 的壳、getNodesBounds 导出），8567 重构时把剩余手写件换掉：

  | 现在手写 | 换成官方 | 备注 |
  | --- | --- | --- |
  | 卡头 ⋯ 菜单 / 悬停操作 | `NodeToolbar` | 跟随缩放、自动定位是现成的 |
  | 框选批量操作条 | `NodeToolbar`（`nodeId` 收数组，天然支持多选挂一条工具条） | 现在是手写浮层 |
  | EdgeToolbar（点线出工具条，手写绝对定位） | 并进自定义边的 `EdgeLabelRenderer` 内 | 与标签同层，跟随视口 |
  | 画布内浮层（搜索框等）的手写定位 | `Panel` | 官方的画布角落容器 |

  边界也写清楚：阅读模式 / 抽屉 / 导出 / 导航页是普通 React+DOM，不属于 React Flow 的地盘，不硬套。
- `lib/card-registry.ts` 构建期静态 import `cards/*` 与 `plugins/*`（**不做运行时装 JS**——浏览器热装第三方代码是安全窟窿；「装插件」= 放目录 + rebuild，自部署场景足够）
- 启用状态存 `<data>/card-packs.json`，UI 上与规格中心合并成一个「卡片中心」：**原生卡片包与数据规格同一套开关体验**（这套开关/降级逻辑规格体系已实现，直接推广）
- 环境无关的默认集：`text/task/link/quote/todo/mermaid/data` 默认开，其余用户自选

### 3.3 兼容性五条铁律

1. **未启用类型的专属字段原样透传，只存不洗**——最容易踩的坑：现在 board-schema 对不认识的字段是清洗掉的，插件化后「开板→保存」不能毁掉关掉的包的数据。**往返无损是第一铁律**。卡面降级成通用渲染（标题 + 「类型未启用」灰标 + 折叠字段表），关掉开关 ≠ 删数据，单卡解析失败只影响单卡
2. **信封双接受**：新格式名输出，`goal-board.cards` 照收，至少保一个大版本
3. **卡片包接口带 `apiVersion`**，接口刻意保持极小——小接口才稳得住
4. **规格只做加法演进**：加可选字段 OK；改 key 名 = 新规格；自动迁移继续明确不做
5. **建卡严、收卡宽**：新建未启用类型的卡 → 明确拒绝（agent 收到清楚报错）；信封收到本机没有的类型 → 收下并降级（strict/lenient 语义沿用）——传阅场景数据不拒之门外，日常创建不放垃圾进来

附：**Tier 2 卡片包随包附一份降级用规格声明**——对方没装代码包时按这份规格降级（体面卡），而不是掉到 Tier 0 裸字段表。

这样「数据库卡片 / 自定义格式规格 / svg+数据组合卡」三类需求全部覆盖：
- 纯数据形状 → Tier-1 规格 JSON（热插拔，不用写代码；规格字段类型扩 `svg`/`image` + `display.media` 槽位即覆盖 svg+数据组合）
- 要自定义渲染/数据源/服务端代理 → Tier-2 CardPack 目录

### 3.4 与 旧版画板 共用数据源

- **格式承诺**：8567 的 storage 读写与 旧版画板 完全同构（每板一 JSON + `_index.json` + `uploads/`），信封格式双接受（新名输出、`goal-board.cards` 照收）
- **开发期**：8567 指向 旧版画板 数据目录的**副本**（`cp -r` 一份），随便折腾
- **两写风险**：两个服务同时写同一数据目录会 last-write-win（mtime 感知只防「外部改动被覆盖」，不做合并）。**切换日**：旧版画板 停写（或直接停进程），`BLOTBOARD_DATA_DIR` 指向真实数据目录，8567 接管；旧版画板 保留只读兜底一段时间
- 迁移脚本不需要——格式同构是硬要求，靠 smoke 用真实数据副本回归

### 3.5 重构 ≠ 全部重写

「完全重构」指**骨架按插件优先重搭**；经过实战的模块直接移植（合计 ~12k 行、有 smoke 37 例 + e2e 37 例 + typecheck 护航）：

| 直接移植（改路径/拆分支进 CardPack） | 重写 |
| --- | --- |
| storage（原子写 + mtime）、board-schema 的公共部分、card-spec 全家（schema/store/ingest/信封）、export-html、mermaid-flow、excalidraw-svg、layout/dagre、embed-allow、auth/origins、comments、uploads | 应用壳与配置层（features/registry/runner 抽象）、Toolbar/编辑器的类型分发（改为 registry 驱动）、Agent 抽屉（改为 runner 驱动）、README/文档/skill |

---

## 4. Runner 层（第 5、6 条问题的最终形态）

- **内置 Issue 存储（local runner，开源默认）**：`<data>/issues.json`，任务卡转 Issue 落本地（复用现有上下文注入：连线上下游 + agentPrompt + 未解决评论——这段逻辑与后端无关）；「发起任务」v1 = 生成完整 prompt（Issue 正文 + 深链 + skill 指引）一键复制给任何 agent，agent 经 API 回写状态
- **http runner**：按 `docs/RUNNER.md` 协议对接任意后端；agentapi 是现成后端示范；goal-agent 是你的私有适配器
- **acp runner（v1.x）**：spawn ACP agent 子进程，配置里选 agent——对齐行业标准的差异化能力
- token 自管：首启在 `<data>/token` 生成并打印，不读任何外部 settings.json
- 红线不变：配了外部 runner 时「真源在 runner、画板只存引用 id」

### 4.1 任务台子页 `/tasks`（2026-09-01 定）

issues/runner 内置后，工作项需要画板之外的家——沿 `/nav` 的先例（独立页、新标签、可深链）：

```
/        画板（思考面）    /nav     导航（找板找卡）    /tasks   任务台（管 issues 与执行）
```

- **三栏**：左 = 镜头（待派 / 进行中 / **等我处理** / 已完成 / 已中止）+ 按板收窄；
  中 = issue 列表；右 = 详情（正文 · ACP 流式 transcript · 权限请求批准/拒绝 · 产出一键回板建卡）
- **模态框退役，只留一个实现**：画板顶栏「任务」→ 新标签打开 `/tasks?board=当前板`（与「导航」同构）
- **深链**：`/tasks?issue=i_xxx`；与 `/?board=&card=` 双向互跳；agent 回报给这个链接——外部入口
  （书签 / 其他工具 / IM 消息）都落在这
- **「等我处理」镜头是硬理由**：ACP `session/request_permission` 在用户不看画板时的落点；
  顶栏挂待处理计数徽标（同评论计数的模式）
- **孤儿 issue**（卡/板已删）只有列表页能显示——模态框的本板视角永远看不到
- **Runner 配置**：v1 做成任务台内的「Runner 设置」区（适配器 / agent 选择 / 权限策略档位 / token 查看）；
  `/settings` 独立页留给以后（卡片中心、嵌入白名单一起搬，M6+）

---

## 5. 开源协议

依赖全为 MIT/ISC（Excalidraw/React Flow/mermaid/roughjs/dagre 均无传染性）。**已定（2026-09-01）：MIT 全仓统一**：

- **全仓 MIT**：代码、CARD-SPEC、RUNNER 协议、信封 Schema、skill、客户端示例一个口径——传播优先，不设协议护栏
- **无需 CLA**（DCO 可选）：MIT 下外部贡献不产生协议锁死问题
- 发布时附 THIRD-PARTY-NOTICES（Excalidraw / React Flow / mermaid / roughjs / dagre / lucide）

Excalidraw 引入方式本身零障碍：npm 依赖（非 fork），字体 postinstall 从 node_modules 同步、不进 git——公开仓不携带资产，用户装包自动获得。

---

## 6. Agent 使用面（skills 与接口）

接口面已经非常 agent-friendly（信封 + validate 干跑 + externalId 判重 + `?format=prompt` 人话 Schema + 评论工作流 + `?format=md` 省 token 读板），是最大卖点。8567 的设计（2026-09-01 讨论定型）：**说两门标准语言 + 自描述 + skill 按部署拼装**：

1. **MCP server（agent → 画板方向）**：随仓库发布一个薄 MCP 入口（`npx <name> mcp`，内部代理 HTTP API），把 goal-agent 里 13 个 `board_*` 工具的体验普惠给所有 MCP 客户端——采用率关键一环，比让用户拼 curl 重要
2. **ACP runner（画板 → agent 方向）**：派单侧，见 §1.4/§4——两条协议正好对称
3. **`/api/capabilities` 自描述**：启用的卡片包 / 规格 / runner / schema 链接，agent 探一次全知道
4. **skill 按启用插件拼装，不再是静态大文件**：每个卡片包目录带自己的 SKILL 片段（怎么建卡、专属字段、红线），`GET /api/skill?format=md` 现场拼出与本部署完全一致的 agent 指南——装了什么说什么。直接消灭「skill 与部署漂移」问题（固定写入私人服务地址会让开源用户拿到不可用的指南）。对话展示卡片的 ```card 约定保留在核心片段
5. **仓库自带 `AGENTS.md`**：架构、测试命令、数据约定——任意 agent 打开仓库就能对话改代码
6. token 读 `<data>/token` 或 env；删 `--noproxy` 等个人环境备注

---

## 7. 隐私清洗清单（公开仓发布前逐条核销）

- [x] `data/card-specs/content-piece.json` example：真实姓名 → 已换虚构账号
- [x] `data/card-specs/source-account.json` example：真实公众号与平台主键 → 已虚构；hint 里的私有端口 → 已中性化
- [x] `data/card-specs/incident-fix.json` example：真实排障案例与 commit → 已换虚构示例
- [x] `data/card-specs/github-issue.json`：真实 GitHub 用户名/仓库 → `example/blotboard`、`octocat`
- [x] `data/card-specs/local-service.json`：真实路径/端口/pm2 痕迹 → 已虚构（仍默认装；「移入 examples/ 不默认装」留给插件化阶段）
- [x] `lib/export-html.ts:52` 注释里真实 Tailscale IP → `100.x.y.z` 示例
- [x] `app/layout.tsx` DOM 下发私有 settings 路径 → 已删（token 改三级自管，见 lib/config.ts）
- [x] README/docs：私有版 README 整份删除重写；私有域名、拓扑、内部路径不再出现
- [x] `ecosystem.config.cjs` → example 化（本机那份 gitignore）；迁移脚本不进公开仓
- [x] **公开源码不携带私有历史**：用 `npm run release:source` 生成当前提交的源码包，新建公开仓库时从该源码包开始；不要假定旧提交也经过了当前检查
- [x] 模板 13 份全通用可原样带走；规格 15 份换 example 后带走（飞书/公众号规格保留，中文生态合理默认）
- [x] **内部测试报告 / 私有 board·card id / 内部工单编号**：`docs/agent-test-report-2026-09-02.md`（含真实 board id、card id、内部任务编号 与私有部署细节）整份移出仓库；注释里的工单号（旧任务引用 等）与测试夹具里的内部编号一并中性化
- [x] **私有域名**：`lib/embed-allow.ts` 注释示例 私人域名 → `*.example.com`
- [x] **指向私有仓的死链**：`docs/SPEC.md §3.3`（该文件不在本仓）三处引用删除，规则就地写成自解释的一句话
- [x] **私有端口出现在用户可见文字里**：知识库 / 书库 / Goal Agent 的 私人服务端口 从 UI 文案、占位符、错误提示与封面兜底里换成中性说法（env 变量名与默认值不动，那是配置不是文案）
- [x] **绝对路径不进面向用户的文本**：local 后端 launch prompt 里的 token 文件绝对路径 → `<数据目录>/token` 相对表述（`/api/issues/:id` 是免鉴权读口）

---

## 8. 里程碑（v2 路线）

| 阶段 | 内容 | 估时 |
| --- | --- | --- |
| M1 定名建仓 | 确认名字 → npm 占位 + org + 域名；8567 仓库脚手架（core + registry + 空 CardPack 接口）| 1 天 |
| M2 内核移植 | storage/schema 公共层/API/信封/评论/导出移植；用 旧版画板 数据副本跑通读写 | 3–4 天 |
| M3 卡片包化 ✅ | 16 种卡片逐个装进 CardPack（先 text/task/link/quote/todo，后富卡片）；卡片中心开关 UI；降级路径 | 4–5 天 |
| ↳ 实际（2026-09-01）| 一次完成：`cards/<type>/{meta,schema,export,ui}` × 16 + 双注册表（`lib/card-registry(.client)?.ts`）；TYPE_META/ICON/兜底标题/GROUP_ORDER/信封类型/检索 haystack 全部注册表派生；透传铁律落地（未知 type 只存不洗、whole 单卡失败只降级）；开关存 `<data>/card-packs.json`（首启默认集 = 方案 7 种 ∪ 存量类型），GET/PATCH `/api/card-packs`，capabilities 增 `cards`；规格中心扩成卡片中心。smoke +6 组用例、e2e 全绿 | — |
| M4 runner 层 | local Issue 存储 + **acp 适配器（v1 主力）** + http 适配器 + `docs/RUNNER.md`；token 自管；**`/tasks` 任务台子页**（取代任务模态框，含 Runner 设置区） | 4–5 天 |
| ↳ 实际（2026-09-01）| **local / http / 任务台完成，acp 待下阶段**：任务后端三选一（`BLOTBOARD_RUNNER_URL` → `GOAL_AGENT_RUNNER_URL` → local），`features.tasks` 恒为 true、capabilities 报 `tasks.backend`；local = `<data>/issues.json`（`lib/issue-store.ts`，run + 日志 + 镜头桶）+ `/api/issues` 回写契约 + launch 生成完整 prompt；`/tasks` 三栏任务台上线（镜头计数 / 画板收窄 / 深链 `?issue=`、`?board=` / 孤儿 Issue / goal-agent 下是聚合镜像），TasksModal 退役；`docs/RUNNER.md`（MIT）落笔。Runner 设置区与 acp 适配器留到下阶段 | — |
| ↳ acp 补注（2026-09-01）| **acp 派单完成（阶段 D）**：ACP 做成 local 后端的第二种 launch 方式（带 `agentId` 即 spawn，不是第四种 TaskBackend）；JSON-RPC 客户端**手写**（`lib/acp/jsonrpc.ts`，官方库处包名迁移期且带 zod/3.9MB，协议面只有 4+2 个方法不值当）；会话管理 `lib/acp/manager.ts`（globalThis 内存表 + 重启扫描兜底 + cancel→5s→SIGTERM + 进程退出杀孤儿）；agent 注册表 `<data>/runner-settings.json`（env 不回显）+ `GET/PATCH /api/runner-settings`；transcript 单独存 `<data>/runs/<runId>.jsonl`，`/transcript?offset=` 增量轮询；权限两档（ask 停 waiting 进「等我处理」/ auto 自动放行记账）+ `/permission` 兑现口；任务台加「Runner 设置」区 + 详情流式 transcript / 权限按钮 / 中止 / 「交给 agent 执行」；mock agent（`scripts/mock-acp-agent.mjs`，auto-finish/need-permission/hang 三模式）撑起 smoke 全链路（含真重启验兜底）；e2e +2（goal-agent 接管态 + local 表单增删）。goal-agent 后端行为零变化（agentId 走 options 通道，远程请求体逐字节不变） | — |
| M5 文档与发布 ✅ | README 重写（定位：agent-native 本地优先画板）+ AGENTS.md + 开源 skill + LICENSE(MIT)/NOTICES + CI | 2 天 |
| ↳ 实际（2026-09-01）| **阶段 E 一次完成**：① MCP server —— package.json 加 `bin`（`npx blotboard mcp`），`bin/blotboard-mcp.mjs` 用官方 `@modelcontextprotocol/sdk`（1.30.0，唯一新增依赖）+ stdio，16 个 board_* 工具（比旧 goal-agent 工具集多出 `board_comments` 评论全链路与 `blotboard_capabilities`；`board_knowledge_search` 属私有服务不带入），token 三级解析（env → 本机 `<data>/token` → 只读模式带指路），smoke 用 SDK client 起子进程全链路验证（含只读形态）；② 「开源 skill」落地成 §6.4 的**按部署拼装**：`cards/<type>/skill.md` × 16 + `lib/skill-core.md` 核心章节 + `lib/skill.ts` 拼装（运行时读文件，与模板/规格同一套「随仓库资产」路数），`GET /api/skill?format=md|json` 免鉴权，只讲启用的包与规格、任务链路按 TASK_BACKEND 三选一、ref/book 在服务未配置时整节略过并在摘要交代，capabilities 加 `skill` 指路；对话 ```card 约定未带入（那是 Goal Agent 聊天宿主的渲染约定，开源画板无此宿主）；③ README 正式版（三条门路 + 全量 env 表）+ AGENTS.md（四层图 / 目录导览 / 数据约定 / 红线 / 加包指南）+ THIRD-PARTY-NOTICES（13 个运行时依赖逐个对 node_modules 核实）+ `.github/workflows/ci.yml`（Node 20 / npm 缓存 / typecheck→build→smoke→e2e，本地仅验 YAML 与语法，未在真 Actions 跑过）。smoke 新增 skill 双形态 + MCP 两个步骤，typecheck / smoke / e2e / build 全绿。待发布事项（npm 占位、GitHub org、域名）仍在 §2 待办 | — |
| M6 发布后 | 规格字段扩 `svg`/`image`；示例插件（RSS 卡 / SQLite 查询卡）；你的私有插件目录（book/aidocs/goal-agent）；ACP remote transport 跟进 | 迭代 |
| ↳ 卡片包第二波（2026-09-02）| **+3 种：`code` / `table` / `chart`（16 → 19）**。三者都判定为 Tier 2（各自要自定义渲染，规格卡的 key-value 表装不下）。① **代码卡** `code.{source,language,filename}`：卡面等宽 + 语法高亮 + 一键复制，阅读模式带行号；高亮用 highlight.js（BSD-3-Clause，唯一新增依赖），**核心与每种语法各自按需 import**（26 种语法一张静态表 → 26 个独立 chunk，一张 python 卡只下核心 76 KB + python 12 KB），token 配色自己写在 globals.css 里不引主题；**服务端导出不引高亮库**（自包含单文件不能带运行时依赖），出 `<pre>` + 转义；语言取值自由、只校验形状（表里没有的照存不高亮）。② **表格卡** `table.{columns,rows,caption}`：**三种输入形态**（结构化 / Markdown 表格 / CSV，解析器手写在 `cards/table/parse.ts`，零依赖），同时给两种形态直接 400；50 列 × 500 行上限超了报实际数字；编辑器就是一段 Markdown（与导出共用 `tableToMarkdown`，看到的即导出的）。③ **数据图卡** `chart.{kind,…}`：bar/line→xychart-beta、pie→pie、quadrant→quadrantChart，字段→源码在 `cards/chart/source.ts`，**渲染复用 mermaid 卡那条路**（`MermaidCard`，不复制一份）；非法值一律 400 不兜底成 0；HTML 排版导出**有意降级成数据表 + 一行说明**（服务端只会渲流程图），markdown 导出给生成好的 mermaid 源码。默认集：code / table 进（→ 9 种），chart 按需开。顺手修两处：`card-pack-store` 里「文件里没记的类型」从「一律当开」改成**按该包 meta.defaultEnabled**（否则声明了默认不启用的包会在老实例上不请自来）；工具条 + 搜索条收进 `.toolbox` 一列（工具条 flex-wrap、宽度封在画布内）——19 个按钮时旧的单行绝对定位会把自己顶到屏幕外，浏览器为了「滚到可见」会把整块画布横向推走。搜索条的类型筛选芯片改成**只列这块板上真有的类型**。smoke +5 组用例（含「老 card-packs.json 缺新包」的升级路径）、e2e 73 → 76 | — |
| ↳ 画板模式第三波（2026-09-02）| **三种整理 + 两个视图 + 连线语义两件套**。① **整理 8 → 11**：`matrix` 四象限（维度**整块板只选一组**：有任务卡 → 重要 × 已开工，否则取张数最多那份规格里前两个 enum/number 字段，都没有 → 有无上游 × 有无下游；归不了类的进右侧「未归类」区，不硬塞进某一格）/ `swimlane` 泳道（行 = 卡片类型、列 = 状态，列口径与看板**同一个函数**——原来看板的分列判定就地抽成 `kanbanColumnOf`，两处不会漂；布局画不出行列标题，边界全靠留白说话，一格默认单列、堆过 4 张才分内列）/ `cluster` 子图分簇（连通分量口径与导出分节 `sectionize` 同源，簇内 dagre 排一次，孤立卡聚成最后一簇）。都经 `LAYOUT_MODES` 注册，顶栏 / `POST /tidy` / MCP / capabilities 自动跟上。② **大纲视图**（`components/OutlineView.tsx` + 纯计算的 `lib/outline.ts`）：不新开路由，**盖在画布上的一层**——画布不卸载，所以点行就能顺手挪视口，Esc 回画布时视野正停在那张卡上；层级只有一条规则「父 = 唯一的上游且它在阅读顺序里更靠前」（多父摊平、子画板卡不认父子，天然无环）；行内编辑复用 `patchCard` 与卡片编辑器的 800ms 节奏；偏好存 `blotboard_view`。③ **对比模式**（`components/panels/CompareModal.tsx`）：2-4 栏并排，**每栏就是一张卡的阅读视图**（直接复用 `ReaderContent`，19 种包自动能看、以后加包不用回来改）；「高亮差异」只在「两张 + 都取得到正文」时出现，算法是自写的行级 LCS（`lib/text-diff.ts`，**不引依赖**，超大文本退回逐行粗比）。④ **连线语义两件套**：`weight` 1-5 关系强弱 + `tags` ≤6 个短标签，**与视觉的 width 刻意分开**（合成一个的话「把线调粗」就等于悄悄改语义）；建卡严点名 400（报错文案点明「画多粗看 width」）、收卡宽照旧兜底；导出 md / HTML（新增「关系一览」节，只在真标注过时出现）/ 信封都带上；分层重排与子图分簇把它喂给 dagre 的 edge weight（**不动 minlen**：调大会把强关系推更远，与语义相反）。顺带核实：第三方审查报告 report-v3 里「MiniMap/Controls/Background/NodeResizer/四向 Handle 未用」与「演示模式缺失」四条**均为失实**，代码里早已在用、阅读模式也早有翻页与目录，本波未重复实现。smoke +2 组用例（三种新整理的坐标关系 / edge weight-tags 正反例含导出三条路）、e2e 76 → 81 | — |

| ↳ 安全网与大板组织第四波（2026-09-02）| **改板安全网 + 分组框 + 悬浮快捷条 + 工作日志**。① **自动快照**（`lib/checkpoints.ts`）：每个批量写入口（whole / ingest / paste / tidy / 批量改删 / 单卡删（级联删连线批注）/ 插入模板）动手**之前**把整块板照一张相存进 `<data>/checkpoints/<boardId>/<时间戳>-<原因>.json`，每块板留最近 `BLOTBOARD_CHECKPOINT_KEEP` 份（默认 10，`0` = 关掉）。三条边界：**绝不阻断主写入**（打点失败只打日志降级——安全网坏了是「这次没有回头路」，不该升级成「这次改不了板」）、**不跟 storage 的 mtime/stale 打架**（快照写在 checkpoints/ 下，目录扫描只认 `boards/b_*.json`，照相不 bump `updatedAt`；回滚反过来是一次正常的写，照常 bump，别的窗口下一跳就看得见）、**单卡编辑与 `PUT /state` 不打点**（那两条路本来就有自动保存与撤销，每改一个字存一份 800 KB 的板会先把磁盘吃光）。清单用一份 `index.json` 缓存（列表要显示卡片数，那只能从文件内容里数；最大的板 866 KB × 10 份 = 每次开抽屉解析 8 MB），索引对不上就按目录现算并补回去。**回滚前会再打一份点**（否则回滚本身成了唯一一次没有回头路的批量写），且只还原内容（卡片 / 连线 / 批注 / 视口 / 设置），`name`/`group`/`parentId` 不动——那几个字段属于「这块板在左栏里是谁」。板被删掉时**故意不清**快照目录：那时候把某份快照拷回 `boards/<id>.json` 就能把整块板捞回来。② **工作日志**（`board.activity`，板文件内、上限 50 条滚动）：actor 从鉴权通道推断（`x-auth-key` = agent / `x-board-web` = 浏览器），每条带着它对应的快照 id。存板文件不单开文件的理由：生命周期与 comments 完全同构（跟着板走、随板删除），一次读板就带回来。**只由服务端写**——请求体里带 `activity` 一律忽略，所以 whole 的整表替换语义天生误伤不到它（比 comments 的「不传就不动」更严一格）。③ **分组框**（第 20 种卡片包 `cards/frame/`）：命名从 `group` 改成 **`frame`** —— 仓库里 `group` 已被布局模式「按类型分区」与 `Board.group`（分组/项目名）各占一次，第三个会让三件事互相打架；归属字段同理叫 `frameId`。真源只有子卡的 `frameId`（框里不存成员名单：存了要跟「卡被删 / 拖出去 / 框被删」三头对齐），代价是服务端两个守卫——写进来时严（指向不存在 404、指向不是框 400、框套框 400 并指路到子画板卡）、批量改完清一遍悬空引用。**删框不删子卡**（框是组织手段不是容器所有权）。画布侧翻译成 React Flow 的 `parentId`（父节点必须排在子节点之前；框 zIndex 垫底；子节点位置相对父框，回写前换算成绝对坐标；拖框时子卡没有自己的位置事件，`withFrameFollowers` 补位移），**刻意不设 `extent:"parent"`**——那会把子卡锁死在框里，而「拖出框 = 解除归属」正是它必须有的退出手势，改成落点判定，进出同一个动作。**整理一律跳过框与框里的卡**：让十一种模式理解父子关系要每种重写一遍，而 timeline/kanban/matrix 这些按字段分列的模式根本答不出「一个框归哪一列」；打散重排又等于每次整理都把用户圈的分区拆掉。信封不收（`frameId` 是本板内主键），默认不启用。④ **悬浮快捷条**：React Flow 官方 `NodeToolbar`（前三波复核确认真没用过），单选一整排色点 + 阅读/评论/复制/删除，多选换批量条（`nodeId` 收数组）。定位是**快捷层不是第二份右键菜单**——卡头 ⋯ 与右键菜单原样保留；`offset=16`（四边都有锚点，条子得离得够远才不截胡拖锚点的手势，且 offset 是屏幕像素、缩放时距离恒定）、整条 `nodrag nopan`；工具箱里可一键关。smoke +3 组用例（checkpoint 全链路含 keep=0 形态与 MCP 两台实例 / frames 全链路 / whole 伪造 activity 被忽略）、e2e 81 → 84、MCP 工具 16 → 17（`board_checkpoints`）、卡片类型 19 → 20 |  |

---

## 9. 风险与决策点

1. **两写冲突**：旧版画板 与 8567 不要同时写同一数据目录；开发用副本，切换日一次性交接
2. **协议已定**：MIT 全仓统一（2026-09-01 拍板），无需 CLA，DCO 可选
3. **范围失控**：M3 是最大块，逐卡片包验收（每包移完跑对应 e2e），别整体大爆炸
4. **信封兼容窗口**：`goal-board.cards` 双接受至少保留一个大版本
5. **差异化叙事**：对外定位不是「又一个看板派单工具」（vibe-kanban 已占），而是**思考画布 + 规格化信息 + agent 协作**的组合

## 参考

- ACP：zed.dev/acp · agentclientprotocol.com（2026-01 上线 Registry）
- vibe-kanban：github.com/BloopAI/vibe-kanban（已转社区维护开源）
- agentapi：github.com/coder/agentapi（HTTP 统一控制 10+ coding agent）

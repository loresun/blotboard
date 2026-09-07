# AGENTS.md —— 给打开这个仓库改代码的任何 agent

> 这份讲「怎么改 Blotboard 的代码」。如果你要的是「怎么操作一台跑着的画板」，
> 打 `GET /api/skill?format=md`（按那台部署实际启用的能力现场拼装的指南），别读这份。

## 架构：四层

```
① 内核（headless，不认识任何卡片类型）
   存储 lib/storage.ts · 公共 schema lib/board-schema.ts · 业务 lib/board-service.ts
   信封 lib/card-ingest.ts · 规格 lib/card-spec-*.ts · 鉴权 lib/auth.ts · 上传 lib/uploads.ts
② 画布壳（渲染宿主）
   React Flow 单壳节点 + 工具条 + 侧栏 + /nav 导航页 + /tasks 任务台（components/ · app/）
   同一块板还有两种「换个方式看」：大纲（components/OutlineView.tsx，盖在画布上的一层）
   与对比（components/panels/CompareModal.tsx，2-4 栏并排）——都不新开路由、不另建保存通道
③ 卡片包 × 21（cards/<type>/，本仓库的「插件」形态）
   同一接口（lib/card-pack-types.ts），槽位全部可缺省
   改板安全网 lib/checkpoints.ts（批量写前自动快照）+ lib/board-activity.ts（工作日志）
④ 横切服务（内核的「遍历器」）
   阅读模式 · 大纲 lib/outline.ts · 对比 lib/text-diff.ts · 导出 lib/export-html.ts ·
   搜索 lib/search-text.ts · 整理 lib/layout.ts —— 对每张卡问
   「有自定义渲染吗？没有走通用降级」，不是每种卡自己的功能。
   **加卡片包不必回来动这一层的渲染 / 导出 / 搜索**（对比模式复用 ReaderContent 就是这条的例子）
```

**这条承诺的已知例外**（照实说，别按「一处都不用改」去理解）：
「按字段语义分组」的东西答不出「这张卡归哪一列」，除非它认识那个字段，所以它们里面**有**按 `card.type`
分支的领域知识——`lib/layout.ts`（timeline 按 task 的日期分列、kanban 按 task/todo 的状态分列、
matrix 取维度）、`lib/outline.ts`（board 卡不认父子）、`lib/board-service.ts`（任务索引只看 task 卡）。
加一种**普通**卡片包不用碰它们（走通用降级）；只有当新卡片也想被时间线 / 看板排进去时，
才需要在对应函数里补一支。把这几支抽成注册表钩子是一次大重构，收益不抵风险，暂时不做。

设计文档：`docs/OPEN-SOURCE-PLAN.md`（分层与决策记录）· `docs/CARD-SPEC.md`（规格与信封）·
`docs/RUNNER.md`（任务后端协议 + ACP）。

## 目录导览

| 位置 | 是什么 |
| --- | --- |
| `cards/<type>/` | 一种卡片 = 一个目录，四件套：`meta.ts`（展示元信息 + 检索贡献，零依赖，前后端共用）· `schema.ts`（服务端归一化 / Markdown 导出行）· `export.ts`（服务端 HTML 导出贡献，可缺省）· `ui.tsx`（客户端卡面 / 编辑器）。另有 `skill.md`（该类型的 agent 使用说明，`/api/skill` 运行时读取拼装） |
| `lib/card-metas.ts` | meta 注册表（前后端共用）；`lib/card-registry.ts` 服务端注册表（meta+schema+export，**不得 import React**）；`lib/card-registry-client.ts` 客户端注册表（meta+ui） |
| `lib/integrations/` | 任务后端 Provider：`task-backend.ts`（4 动作接口 + 远程实现）· `task-backend-local.ts`（local 后端）；知识库 / 书库 provider |
| `lib/acp/` | ACP 派单：`jsonrpc.ts`（手写 JSON-RPC 客户端）· `manager.ts`（会话生命周期 / 权限 / 重启兜底）· `transcript.ts`（run 流水 jsonl） |
| `lib/issue-store.ts` / `issue-service.ts` / `issue-sync.ts` | local Issue 存储 / 任务台装饰 / 画板→Issue 正文单向同步 |
| `lib/skill.ts` + `lib/skill-core.md` | `/api/skill` 的拼装逻辑与核心章节 |
| `lib/resources.ts` | 引用资源库：把散在各板上的 `agent-skill` 规格卡摊平成一份清单的跨板聚合（`/resources` 页与 `GET /api/resources` 同一份数据）。**没有独立的存储**——资源就是画板上的规格卡，登记 / 修订全走普通建卡改卡 |
| `lib/layout.ts` + `lib/layout-dagre.ts` | 十一种整理模式（纯计算，前后端同构）。真源是 `LAYOUT_MODES` 一张表——加一种模式只改它，顶栏菜单 / `POST /tidy` / MCP / `/api/capabilities` 自动跟上；要 dagre 的两种（LR/TB 分层、cluster 分簇）单独放 layout-dagre 以便按需加载 |
| 分组框（frame） | `cards/frame/` + `BoardCard.frameId`（**公共字段**，任何类型都能被圈进框）。真源只有子卡的 frameId，框里不存成员名单；画布侧翻译成 React Flow 的 `parentId`（**不设 `extent: "parent"`**——那会把子卡锁死在框里，拖出去解除归属就没路了），子节点位置是相对父框的，回写前换算成绝对坐标（`components/BoardCanvas.tsx` 的 `absoluteOf` / `withFrameFollowers`）。整理（`runLayout`）一律跳过框与框里的卡 |
| `lib/outline.ts` / `lib/text-diff.ts` | 大纲的层级推导（父 = 唯一且更靠前的上游）/ 对比模式的行级 LCS（自写，不引依赖） |
| `app/api/` | 全部 REST 路由（handler 只做「鉴权 + 取参 + 调 lib/」）；`app/tasks/` 任务台页；`app/nav/` 导航页；`app/docs/` 帮助页 |
| 搬家两件套 | `lib/board-bundle.ts` **画板包格式**（纯计算、前后端同构：解析宽进、id 重映射、HTML 载荷的读写）+ `lib/board-transfer.ts` 服务端两头（挑板 / 分卷 / 读写附件字节 / 落库）。口径：导出 `GET /api/boards/export?ids=\|group=\|all=1`（`format=json\|html\|md`）与 `…/{id}/export?format=bundle`；导入 `POST /api/boards/import`（认画板包 / 单块板 JSON / **排版导出的 HTML**——产物末尾带同一份载荷，图片按 `<img data-asset>` 还原，不存第二份字节 / **整个 HTTP 响应 `{ok,bundle}`**——共享解析入口自己剥一层，浏览器库与服务端同一条口径）。导入只新建（`mode=copy`）或按原 id 恢复（`mode=restore`，撞 id 默认跳过，`onConflict=replace` 才覆盖且先打快照）；**这两个参数显式给了就必须认识，拼错当场 400 且零写入**；副本一律断开任务卡的 Issue / 任务 id。**挑板永不截断**：`selectBoards` 给出完整的那一批，装不下由 `planBoardVolumes` 分卷（`plan=1` 看计划 / `volume=N` 取第 N 卷 / 不给 volume 又超限就 413 附计划），每卷都是完整可导入的包 |
| 导出四件套 | `lib/export-html.ts` 单文件 HTML（服务端排版）· `lib/export-print.ts` **PDF 用的分块产物**（`format=print`，只切块不排版）· `lib/export-pdf.ts` **浏览器侧的分页与打印**（量高度装页、页码、目录页码，再交系统打印）· `lib/export.ts` 前端的 JSON / MD / PNG / 画板包下载。内容口径三者共用 `prepareExport` + `cards/<type>/export.ts`，**只有一份真源**；分页必须在浏览器算——高度只有真排过版才知道，服务端估错就是把卡片劈成两半 |
| `docs/guide/` + `lib/docs.ts` | **用户帮助**（`/docs` 页与 `GET /api/docs` 同一份数据）：一份 md 一页，标题 / 摘要 / 分组 / 序号写在 frontmatter 里，运行时读目录。**加一页帮助 = 放一个 .md，代码一行不用改**。与 `cards/<type>/skill.md`（写给 agent 的操作说明）分工：那份讲「怎么调接口」，这份讲「人怎么用」 |
| `lib/i18n/` | **界面语言**（中 / 英）：`index.ts` 的 `t()` 与合并后的字典 · `client.tsx` 的 `useT()` / `tr()` / `useCardLabel()` · `dicts/<区域>.zh.ts` 是**键的唯一来源**，同名 `.en.ts` 用 `Record<keyof typeof xxxZh, string>` 钉死（漏译 typecheck 当场红）。语言存在 `blotboard.locale` cookie，**根布局在服务端读它**，一次写进 `<html lang>` / `<body data-locale>` / LocaleProvider 三处——服务端那一遍就是对的语言，不闪。中文那份的值同时被 e2e 按可见文字取元素，**改字要连着改用例**。帮助文档的译文在 `docs/guide/<locale>/`，某页没译按页退回中文 |
| `components/SiteNav.tsx` | 六个页面（画板 / 导航 / 资源 / 任务台 / Agent / 帮助）的站点导航，页面共用。顶栏左上角固定回答「去哪儿」，右侧只留「对当前这块板动手」的按钮 |
| `bin/` | `blotboard.mjs` CLI（本地安装后的 `blotboard mcp`）+ `blotboard-mcp.mjs` MCP server（纯 .mjs，不进 Next 构建） |
| `lib/checkpoints.ts` | 批量写入前的自动快照与回滚：打点 / 清单（带索引缓存）/ 读 / 删 / 保留上限。**绝不抛异常**（安全网坏了不阻断主写入），也**不碰 storage 的 mtime/stale**（快照写在 `<data>/checkpoints/`，板文件一个字节没动） |
| `lib/board-activity.ts` | 工作日志：`board.activity`（板文件内，上限 50 条滚动）。**只由服务端写**，请求体里的 `activity` 一律忽略 |
| `data/templates/` `data/card-specs/` | **随仓库发布的资产**（git 跟踪）；`data/` 其余是用户数据（gitignore） |
| `scripts/` | 冒烟 `smoke-api.mjs` · mock ACP agent · Excalidraw 资产同步 · PNG 批量导出 |
| `e2e/` + `playwright.config.ts` | Playwright 端到端（自起两个实例：goal-agent 形态 + local 形态） |
| `server.mjs` | 自定义 server：Next 之前做「本机 / 私网 / Tailscale 直连」的 TCP 地址闸门与 CSP |

## 开发命令

```bash
npm install          # 会触发 postinstall 同步 Excalidraw 字体资产
npm run dev          # 开发（HMR），http://127.0.0.1:8567（默认口；被占自动顺延，实际端口见 `<data>/port` 或 `/api/health`）
npm run check        # ★ 提交前跑这一条：lint:repo → test:unit → typecheck → build → smoke → e2e
npm run doctor       # 用着出问题时：打活服务出一份可贴进 issue 的诊断报告（只读）
npm start            # 生产起服务（先 build）
```

`check` 的每一步也能单独跑（`lint:repo` / `typecheck` / `build` / `smoke` / `e2e`），
修完某一步想接着往下：`npm run check -- --from smoke`。

**改完代码的验收只有一条：`npm run check` 全绿**，且**测试数量只增不减**。
（以前写的是四条命令并列，漏跑一条是常态；收成一条就没有漏的余地。）

`npm run lint:repo` 是新加的静态体检（`scripts/lint-repo.mjs`，纯 Node 零依赖、秒级），
守的是**编译得过但会静默出错**的那一类：源码里的裸 NUL（会让 `grep -r` 悄悄跳过整个文件）、
私有痕迹、文档死链、卡片包缺件（**声明了 `meta.fieldKey` 就必须有 `ui.FullView`**，
否则阅读模式一片空白）、env 与 README 漂移、CSS 用了不存在的变量、
读运行时 env 的页面没写 `force-dynamic`（env 会被烤进构建产物）。
**它红了要修问题，不要放宽检查**；确需豁免就加进脚本里的白名单并写清理由。

## 数据约定（`data/` 下谁管哪个文件）

| 文件 | 谁写 | 说明 |
| --- | --- | --- |
| `boards/<id>.json` + `boards/_index.json` | lib/storage.ts | 一板一文件，原子写 + mtime 感知外部改动。**别绕过 API 直接改**（能被感知，但绕过了校验） |
| `uploads/` | lib/uploads.ts | 图片 / PDF 附件 |
| `token` | lib/config.ts | 内部 token（0600，首启自动生成）；agent 写操作的 `x-auth-key` |
| `card-packs.json` | lib/card-pack-store.ts | 卡片包开关；首次生成 = 方案默认 9 种 ∪ 存量数据里出现过的类型。**文件里没记的类型（升级后新加的包）按该包 meta.defaultEnabled 算**，不是一律当开 |
| `card-spec-state.json` / `my-card-specs/` | lib/card-spec-store.ts | 规格开关（只记被改过的）/ 用户自定义规格 |
| `issues.json` | lib/issue-store.ts | local 任务后端的 Issue + runs（配了外部 Runner 时不用） |
| `runner-settings.json` | lib/runner-settings.ts | ACP agent 注册表 + 权限档位（可能含 env 秘密，绝不回显值） |
| `runs/<runId>.jsonl` | lib/acp/transcript.ts | ACP run 的流式 transcript（只增 append，不进 issues.json） |
| `acp-workspace/` | lib/acp/manager.ts | 未配 cwd 的 agent 默认工作目录 |
| `agent-commands.json` | lib/agent-command-store.ts | 用户自定义的画板 agent 指令 |
| `checkpoints/<boardId>/` | lib/checkpoints.ts | 批量写入前的自动快照（`<时间戳>-<原因>.json` + `index.json` 清单缓存），每块板留最近 `BLOTBOARD_CHECKPOINT_KEEP` 份。**板被删掉时故意不清**——那时候把某份快照拷回 `boards/<id>.json` 就能把整块板捞回来 |

`data/templates/`（13 个模板）与 `data/card-specs/`（17 份内置规格）是随仓库走的资产，跟着项目根而不是 DATA_DIR。

## 改代码的红线

1. **服务端不 import React**：`lib/card-registry.ts` 与一切 `lib/`、`app/api/` 代码不得引 `ui.tsx` / React 组件；客户端组件只进 `lib/card-registry-client.ts`。
2. **透传铁律（兼容第一铁律）**：未知 / 停用类型的专属字段**只存不洗**——「开板 → 保存」不能毁掉任何字段；whole 单卡归一化失败只降级该卡（passthroughCard），不打回整板。冒烟里有逐字节往返用例守着。
3. **建卡严、收卡宽**：新建未知 / 停用类型 → 结构化 400；信封收到本机没有的类型 → 收下并降级。
4. **Issue / 任务真源**：配了外部 Runner 时画板只存引用 id，不复制业务状态；远程 Runner 的请求体形状不许变（goal-agent 链路零变化是硬性验收项）。
5. **评论表三态**：whole / 整板改写里的 `comments` —— **不传**（或不是数组）= 一个字不动、
   **传数组** = 整表替换（落脚点已经没了的评论顺带剪掉）、**传 `[]`** = 显式清空。
   默认必须是「不动」：agent 重写卡片不等于清掉用户批注。**工作日志更严一格**——
   `board.activity` 只由服务端追加，请求体里带它一律忽略（所以整表替换语义天生误伤不到它）。
   配套的一条：**连线 id 按端点保号**——`replaceWhole` 里同一对 `from`/`to` 就是同一条线，
   端点没变就沿用原 id 与 `createdAt`。这不是优化是前提：评论按存活 edge id 过滤，
   重发 id 等于让「原样回写」把连线批注全剪掉（真出过这个 bug），
   「不传 comments = 不动」这条承诺也就成了空话。
6. **安全网不上主路径**：新加批量写入口时在动手**之前**调 `captureCheckpoint(board, reason)`
   并在同一次 `mutateBoard` 里 `pushActivity`；打点失败只打日志降级，**不许**让主写入失败。
   单卡编辑与 `PUT /state`（纯几何）不打点——那两条路本来就有自动保存与撤销，
   每改一个字存一份整板会先把磁盘吃光。
7. **测试常绿**：typecheck / smoke / e2e / build 全过再提交；测试永远用隔离数据目录，**不指真实 `data/`**。
8. **不做运行时装插件**：注册表是构建期静态 import；「装插件」= 放目录 + 补注册 + rebuild（浏览器热装第三方代码是安全窟窿）。
9. **秘密不回显**：token / agent env 值不下发浏览器、不进日志、不进错误文案；
   本机绝对路径同理（`describeAuth` 与 local 后端的 launch prompt 都只给 `<数据目录>/token`
   这种相对表述——`/api/issues/:id` 是免鉴权读口，写进去就等于公开这台机器的目录结构）。
10. **上传件没有应用层鉴权**：`/api/uploads/{id}` 的下载 / 预览是**有意**免鉴权的
   （卡面 `<img src>` 与导出的 HTML 都要能直接取，加了 token 图就裂了）。
   拦住它的只有两样：不可枚举的 upload id，和 server.mjs 那道网络层闸门。
   **加功能时别把这条当默认安全**——真要放到不可信网络上，得自己在前面加一层。
11. **ACP 注册表是高信任输入**：注册的 agent 由画板 `spawn`，且**继承画板进程的全部环境变量**
   （`{ ...process.env, ...agent.env }`，见 lib/acp/manager.ts）。这是有意的——
   agent 常常真需要 PATH / 代理 / 自己那份 key。代价是「能改 `runner-settings.json`
   或调 `PATCH /api/runner-settings` 的人 = 能在这台机器上以你的身份执行任意命令」，
   所以别注册来路不明的命令，也别把写接口暴露到不可信网络（详见 docs/RUNNER.md §4.1）。
12. **`x-forwarded-*` 默认不信**：产物 / 指南里回指画板的 base 只在
   `BLOTBOARD_TRUST_PROXY=1` 时才认这两个头（`requestOrigin`，lib/http.ts）；
   否则用请求自己的 Host——那两个头谁都能伪造，信了就是把导出文件里的链接整批送人。

## 加一种卡片包（step by step）

1. `lib/types.ts`：把新 type 加进 `BOARD_CARD_TYPES` 元组；需要专属字段就定义 `XxxField` 接口并挂到 `BoardCard`。
2. 建 `cards/<type>/` 目录：
   - `meta.ts`（必须）：`label / fallbackTitle / icon / 默认尺寸颜色 / fieldKey / groupOrder / searchParts`；要进信封白名单加 `envelope: true`（口径是**自包含**——换台机器凭这封信就能完整重建；字段是本机主键的不给，如 image/pdf 的 `file.uploadId`、board 的 `boardRef.boardId`），要进新装机默认集加 `defaultEnabled: true`；icon 名先在 `lib/icons.tsx` 的 `PACK_ICONS` 里补上组件。
   - `schema.ts`：`onCreate / onConvert / onPatch / markdownLines`（全部可缺省；text 卡就什么都没有）。
   - `ui.tsx`：`CardFace`（卡面）等槽位；缺省走通用渲染。
   - `export.ts`（可选）：单文件 HTML 导出的正文贡献。
   - `skill.md`：这类卡怎么建、专属字段、坑（`/api/skill` 会把它拼进部署指南）。
3. 注册三处（少一处 typecheck 会红）：`lib/card-metas.ts`、`lib/card-registry.ts`、`lib/card-registry-client.ts`。
4. `npm run typecheck && npm run build && npm run smoke && npm run e2e`；给 smoke 补该类型的建卡 / 导出用例。
5. 先自问：**这个需求能不能下沉成 Tier 1 的规格 JSON**（`data/card-specs/`，热插拔零代码）？能就别写包——代码包留给「要自定义渲染 / 数据源 / 服务端代理」的场景。

## 发布与 Agent 入口

- 左上角 `/agent` 是用户接入入口；`lib/agent-onboarding.ts` 生成复制画板提示词与部署专属 Skill，`/api/skill?format=install` 返回轻量 SKILL.md，每次使用再取动态能力。不要在提示词中写 token、私人路径或假定已发布的 npm 安装入口。
- 生产构建与同工作区生产服务互斥（`scripts/build-guard.mjs`）；开发和测试请用隔离工作区，禁止绕过锁覆盖在线 `.next`。
- `npm run release:source` 只从干净提交生成无 Git 历史源码包；私人配置、用户数据与备份不得进入发布物。部署步骤见 `docs/DEPLOYMENT.md`。

## 整理与持续撤销的合同

- `runLayout` 是全部 11 种整理模式的唯一入口：自由卡输出完备、有限，固定框及成员不动；整理结果避开固定区域，超出持久化坐标范围时原子拒绝，不截断坐标。
- `POST /tidy` 未传 mode 使用 tidy；显式未知 mode 返回 400。异步计算后与最新完整快照对比，存在并行修改返回 409。`moved` 保留历史处理数量语义，`changed` 是实际变更数量；无变化不追加历史。
- 连续编辑历史使用有界差量日志；它与批量改动前的整板 checkpoint 分工不同。几何拖动/整理要先等待防抖保存完成，再撤销或切板，不能让延迟写回覆盖刚撤销的内容。
- 快捷键遵循焦点归属：输入框、contenteditable、IME、弹窗和 iframe 不接受画布全局撤销/粘贴。维护键盘逻辑时优先用共享门禁，不在各个组件另造规则。

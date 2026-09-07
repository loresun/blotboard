# Blotboard · 泼墨画板

[English](README.en.md) | 中文

**Blotboard — a local-first whiteboard that humans and any agent share.**

> ℹ️ **v1.0.1**：自私有项目重构而来（1.0.0 是首个公开版本），代码与验收（239 条 e2e）都已成型，
> 但公开使用者还少。按[语义化版本](https://semver.org/lang/zh-CN/)承诺：破坏性改动进大版本。
> 上生产前请自己先跑一遍 `npm run check`，并按 [SECURITY.md](SECURITY.md) 确认网络边界。

把想法摊开成卡片、拖拽连线、右键批注——这是给人的那半边。另半边给 agent：
每一件界面上能做的事都有对应 API，卡片能整批收发、评论就是交活通道、任务卡能一键派给
coding agent 执行。**你们看到的是同一块板**：人负责思考与批注，agent 建卡、改卡、
按批注改、把任务领走再把产出送回来。

- **本地优先**：可选服务端 JSON 文件（一板一文件、原子写）或浏览器 IndexedDB（按 origin + workspace 隔离），不依赖托管云、没有内置账号；外部链接和可选集成按用户配置访问
- **agent 原生**：接口自描述（`/api/capabilities`）+ 按部署现场拼装的指南（`/api/skill`），三条接入门路见下
- 技术栈：Next.js 16（App Router）+ React 19 + TypeScript + [React Flow](https://reactflow.dev) + zustand

## 特性

| | |
| --- | --- |
| **21 种卡片包** | 文本 / 任务 / 链接 / 引用 / 图片 / **音视频**（本地 mp4 / mov / mp3 / m4a… 拖进来就地播，进度条可拖）/ PDF / 待办 / 思维导图 / Mermaid / SVG / Excalidraw 自由画 / 网页嵌入 / 子画板 / 规格卡 / 资料组 / 图书 / **代码**（语法高亮 + 一键复制）/ **表格**（Markdown / CSV 直接塞）/ **数据图**（填数据不写语法）/ **分组框**（圈住几张卡整体拖动、可折叠）——每种都是 `cards/<type>/` 下的一个插件目录，卡片中心按需开关；停用只挡新建，已有卡片与数据一字不丢 |
| **规格卡与信封** | 一份 JSON 规格 = 一类结构化卡片（会议纪要 / 决策记录 / 指标快照 / 提示词…17 份内置），装上就能收、不用改代码；批量收发走统一信封格式（`blotboard.cards`），带干跑校验与 externalId 判重 |
| **引用资源库** | 登记能被 agent 直接装上用的 skill / MCP / CLI / 库——就是「引用资源」规格卡，散在各块板上；`/resources` 页把全部署的摊成一页（类型 / 状态筛选、安装方式一键复制），agent 走 `GET /api/resources` 拿同一份清单，`/api/skill` 的指南自带这一节 |
| **改板安全网** | 每个「一次改很多」的入口（整板改写 / 信封落板 / 粘贴 / 服务端整理 / 批量改删 / 插入模板）动手**之前**自动存一份整板快照，每块板留最近 10 份；顶栏「历史」里看改动记录、一键整块回滚（回滚前再自动存一份，所以回滚也有回头路）。同一处还记着 agent 改板的工作日志：谁、什么时候、用哪个口、改了多少 |
| **评论批注** | 卡片 / 连线 / 画布任意处钉评论；agent 读未解决评论、动手、回复、标解决——需求钉在卡片上，闭环留在板上 |
| **任务台 + 三种 runner** | 任务卡转 Issue、发起执行；内置 local 后端开箱即用（Issue 落本地 + 生成完整 prompt），或接任意 [RUNNER.md](docs/RUNNER.md) 协议的 http 后端；`/tasks` 任务台管镜头 / 权限请求 / 孤儿 Issue |
| **ACP 派单** | local 后端还能真拉起本机 coding agent（[Agent Client Protocol](https://agentclientprotocol.com)）：流式 transcript、权限确认、中止，都回到任务台 |
| **MCP server** | `npx blotboard mcp` 接入任意 MCP 客户端（或在源码目录 `npm link` 用本地版本），17 个 board_* 工具覆盖日常改板全部动作 |
| **分组框 vs 子画板** | 两种「收拾大板」的手段，别混着用：**分组框（frame）**是就地圈一块地——卡还在本板上，只多一个 `frameId`，框一拖整摊跟着走，折叠起来只剩个框；**子画板卡（board）**是把一摊东西挪进**另一块板**，双击下钻进去看。要「一起搬」用框，要「挪出视线」用子画板。框里的卡整理时会被跳过（那是你手工圈的分区，重排会拆散它） |
| **十一种整理** | 整齐化（保结构）/ 流程串开 / 横纵分层 / 类型分区 / 网格 / 时间线（一天一列）/ 看板（按状态分列）/ **四象限**（两个维度切成田字）/ **泳道**（类型 × 状态的二维分格）/ **子图分簇**（按连通分量摊开「这块板其实是几张图」）——服务端纯函数，`POST /tidy` 与顶栏「整理」同一套算法，都能撤销 |
| **悬浮快捷条** | 选中卡片时，卡片上方浮一条跟着走的工具条（改色 / 阅读 / 评论 / 复制 / 删除；多选时换成批量条）。它是**快捷层不是新入口**——卡头的 ⋯ 与右键菜单仍是完整功能，嫌它挡眼睛在工具箱里一键关掉 |
| **三种看法** | 画布（本体）/ **大纲**（整块板摊成一列，按连线上下游缩进，可过滤、可行内改标题正文）/ **对比**（2-4 张卡并排，各栏独立滚动，两张文本卡还能高亮行级差异）；阅读模式另外把整板压成一条序列，←/→ 一张张读下去 |
| **阅读模式与全屏** | 一张卡摊到整屏读：左侧目录、←/→ 翻卡、图可缩放拖动。**F 进全屏**（原生全屏；浏览器不给就退回铺满窗口）——图 / PPT / 表格的舞台直接长一大截，正文换更大的字。嵌了别人页面（网页卡 / PDF）时头上多一个**键盘归属**开关：默认 ←/→ 还是翻卡，按一下才把键盘交给那张 PPT |
| **连线有语义** | 五种关系（关联 / 阻塞 / 前置 / 引用 / 产出）+ 外观三件套（颜色 / 线型 / 粗细）+ **关系强弱 1-5** 与 **关系标签**；强弱是语义不是线宽，分层重排与子图分簇会拿它当权重，导出的 md / HTML / 信封都带上 |
| **随服务带的帮助** | `/docs` 一整套用户文档，21 页分六组：开始（介绍 / 五分钟上手 / 界面导览 / 快捷键 / 画布辅助）· 把东西放上去（卡片 / 连线 / 分组框 / 模板）· 换个方式看（整理 / 几种看法）· 和 agent 一起干活（接入 / 评论 / 任务 / 历史 / 浏览器存储）· 带走与扩展（导出 / PDF / 规格信封 / 资源库）· 排障（常见问题）。中英双语，跟界面语言走。正文真源是 `docs/guide/*.md`——**加一页 = 放一个 .md**（标题 / 摘要 / 分组写在 frontmatter 里），agent 走 `GET /api/docs` 拿同一份 |
| **一键 PDF** | 分页、纸张、页边距、页码与**带真实页码的目录**都由画板自己排好，再交系统打印（对话框里选「另存为 PDF」）——产物是矢量文字：**链接可点、文字能选能搜**，图片按原图嵌进去，卡片不跨页。设置面板右边是**真实分页预览**（与打印产物同一份文档、同一次分页），纸张 / 字号 / 分栏改一下页数当场变；范围可选整块板 / 筛选命中 / 画布上选中的那几张 |
| **导出** | 整板导单文件 HTML（零外链、离线可开、打印即 A4 PDF）/ Markdown / JSON / 卡片信封；13 个思维框架模板一键铺开 |
| **导入导出画板** | 一块板、一个分组、整个库都能打成**画板包**（板 + 卡 + 线 + 评论 + 附件字节）搬到另一台画板上；那份单文件 HTML 末尾也带着同一份数据——**发给别人看的文件，对方能直接导进自己的画板**（图片跟着走）。导入默认「一律新建」不动已有的板，恢复自己的备份才按原 id 覆盖（恢复前先给一份影响摘要，取消就是零写入）。超过 200 块板的库自动**分卷**，每卷都是完整可导入的包——不会给你一份看着成功的残缺备份 |
| **浏览器隔离存储** | 顶栏一键切换到 IndexedDB 工作区，画板不经过服务端；不同 workspace 互相隔离，支持全库 bundle 备份/恢复。上传、Runner、快照与服务端排版在该模式明确降级；本地 Agent 通过已授权标签页里的 `window.blotboardBrowser` 控制同一份数据 |

## 快速开始

需要 Node.js ≥ 20.9。

```bash
npm install
npm run build
npm start        # → http://127.0.0.1:8567
```

打开 `/start` 先选择数据归属：进入服务端文件库，或选择/新建一个浏览器 IndexedDB workspace。`/` 仍是稳定的画板直达入口，既有 `?board=&card=` 深链不变。

> **服务地址别写死**：默认 `http://127.0.0.1:8567`，端口被占会自动顺延（8568、8569…）。
> 实际端口有三个准确来源：数据目录下的 `port` 文件、`GET /api/health` 的 `port` 字段、启动日志。
> `BLOTBOARD_PORT` 指定想要的端口，`BLOTBOARD_PORT_TRIES` 改顺延次数（默认 10），
> `BLOTBOARD_PORT_STRICT=1` 关掉顺延（占用即报错退出，测试用）。


开发模式：`npm run dev`（带 HMR）。pm2 常驻：`cp ecosystem.config.example.cjs ecosystem.config.cjs`，改完 `pm2 start ecosystem.config.cjs`。

首次启动会在 `data/token` 生成一个随机 token 并在日志里提示——这是 agent 调写操作 API 的钥匙
（也可用 `BLOTBOARD_INTERNAL_TOKEN` 显式指定）。浏览器侧不用管 token：同源页面自带写权限；
服务默认只接受本机 / 私网 / Tailscale 直连。

生产更新先停止同一工作区的旧进程，再构建并启动。运行中的 `.next` 不能被覆盖；`npm run build` 会检查这一点。完整操作、备份、回滚及无历史源码包见 [部署与发布](docs/DEPLOYMENT.md)。

## agent 接入：三条门路

左上角 **Agent** 入口会按当前存储切换内容。服务端模式提供 Skill/HTTP/MCP 提示词；浏览器模式提供完全独立的 CDP/Playwright 提示词。画布空白处或画板列表右键也会自动复制对应版本。

> 浏览器隔离存储是另一条边界：HTTP/MCP 只操作服务端文件库。要操作 IndexedDB，让本地 Agent 通过 Playwright/CDP 控制对应标签页并调用 `window.blotboardBrowser`；详见 [浏览器隔离存储](docs/guide/browser-storage.md)。

**① HTTP API + `/api/skill`** —— 任何能发请求的东西。读操作免鉴权，写操作带 `x-auth-key`：

```bash
TOKEN=$(cat data/token)
curl -s -X POST http://127.0.0.1:8567/api/boards \
  -H "x-auth-key: $TOKEN" -H "content-type: application/json" -d '{"name":"第一块板"}'

# 这台部署的完整 agent 指南（按实际启用的卡片包 / 规格 / 任务后端现场拼装，永不过期）
curl -s http://127.0.0.1:8567/api/skill?format=md
# 只要其中一类活（省上下文）：cards / specs / envelope / tasks / comments / api / links / pitfalls
curl -s "http://127.0.0.1:8567/api/skill?format=md&focus=cards,tasks"
# 机器可读的能力清单（含整理模式 layouts、mermaid 渲染边界、skillFocus 合法值）
curl -s http://127.0.0.1:8567/api/capabilities
```

**② MCP（agent → 画板）** —— `npx blotboard mcp` 开箱即用（npm 上的 `blotboard` 就是这个 MCP 入口；也可以在可信源码目录 `npm link` 用本地版本）（在仓库目录跑会自动读 `data/token`；
连远程或非默认端口时用 env 指明）：

```json
{
  "mcpServers": {
    "blotboard": {
      "command": "blotboard",
      "args": ["mcp"],
      "env": { "BLOTBOARD_URL": "http://127.0.0.1:8567", "BLOTBOARD_TOKEN": "<data/token 的内容>" }
    }
  }
}
```

18 个工具：`board_list / board_create / board_add_card / board_update_card / board_delete_card /
board_link / board_edge / board_layout / board_comments / board_card_specs / board_ingest_cards /
board_checkpoints / board_export / board_import / board_to_issue / board_launch / board_tasks /
blotboard_capabilities`。

**③ ACP（画板 → agent）** —— 反方向的派单：任务台「Runner 设置」里注册本机 agent
（如 `npx -y @zed-industries/claude-code-acp`、`gemini --acp`），任务卡带 `agentId` 发起执行，
画板 spawn 它的子进程，流式进展与权限确认回到 `/tasks`。协议细节见 [docs/RUNNER.md](docs/RUNNER.md) §4。

## 可选集成：显式配置才启用

画板不调任何 LLM，本体零外部依赖。可选集成**不配 = 对应入口整个隐藏**（API 回 503），配了才出现：

| 环境变量 | 启用什么 |
| --- | --- |
| `BLOTBOARD_RUNNER_URL` | 通用 http 任务后端（任何按 [RUNNER.md](docs/RUNNER.md) 实现的服务；优先级最高） |
| `GOAL_AGENT_RUNNER_URL` | Goal Agent 任务后端（http 的特例，token 同源）；都不配 = 内置 local 后端（任务功能恒可用） |
| `AIDOCS_URL` | 资料卡：从知识库检索、攒成卡片（协议见 [INTEGRATIONS.md](docs/INTEGRATIONS.md)） |
| `BOOK_LIBRARY_URL` | 图书卡：从书库挑书，封面 / 在线读 / PDF（协议见 [INTEGRATIONS.md](docs/INTEGRATIONS.md)） |
| `GOAL_AGENT_WEB_URL` | 任务详情「在主界面查看」的跳转地址 |

这三条**都不绑定某个特定的服务**：任务后端照 [RUNNER.md](docs/RUNNER.md) 实现，
知识库与书库照 [INTEGRATIONS.md](docs/INTEGRATIONS.md) 实现，画板只认协议不认实现。
仓库里带了一份两条协议都实现了的**参考实现**，想先看看长什么样：

```bash
npm run mock:integrations                # 起在 127.0.0.1:8899
AIDOCS_URL=http://127.0.0.1:8899 BOOK_LIBRARY_URL=http://127.0.0.1:8899 npm run dev
```

## 环境变量（全部可选）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `BLOTBOARD_PORT` / `BLOTBOARD_HOST` | `8567` / `127.0.0.1` | 监听地址 |
| `BLOTBOARD_PUBLIC_URL` | `http://127.0.0.1:<port>` | 对外地址（prompt / 深链里写给 agent 的 base）。跨机访问 / 要让浏览器深链可用时必须配，否则写进 prompt 的回写地址与深链都是 `127.0.0.1` |
| `BLOTBOARD_ROOT` | `process.cwd()` | 项目根（模板与内置规格随它走） |
| `BLOTBOARD_DATA_DIR` | `<root>/data` | 用户数据目录 |
| `BLOTBOARD_INTERNAL_TOKEN` | 自管 `<data>/token` | 写操作 token（三级来源之首） |
| `BLOTBOARD_GOAL_AGENT_SETTINGS` | — | 与 Goal Agent 共用 token 时指向它的 settings.json |
| `BLOTBOARD_RUNNER_TOKEN` | 画板内部 token | http 任务后端的 token |
| `BLOTBOARD_ACP_STDERR` | 只落脱敏摘要 | ACP agent 的 stderr 存法：设 `full` = 另把原文全量写到 `<data>/runs/<runId>.stderr.log`（0600），原文不进 transcript |
| `BLOTBOARD_HTML_ALLOW` | `@private` | 网页嵌入卡的域白名单（逗号分隔；`@private` = 本机/私网/Tailscale，`@none` = 关闭） |
| `BLOTBOARD_PORT_TRIES` | `10` | 想要的端口被占时最多往后顺延几个（8567 → 8568 → …） |
| `BLOTBOARD_PORT_STRICT` | — | 设 `1` 关掉顺延：端口被占就报错退出（测试用，免得断言打在空处） |
| `BLOTBOARD_ALLOW_PUBLIC_DIRECT` | — | 设 `1` 关掉「只接受可信网段直连」的地址闸门（**先读[放到公网前](#放到公网前想清楚)**） |
| `BLOTBOARD_TRUST_PROXY` | — | 设 `1` 才信 `x-forwarded-host` / `x-forwarded-proto`（导出与 `/api/skill` 里回指画板的 base 用它）。**只在真的站在反向代理后面时才开** |
| `BLOTBOARD_ISSUE_SYNC_DEBOUNCE_MS` | `1200` | 卡片编辑 → Issue 回推的防抖窗口 |
| `BLOTBOARD_CHECKPOINT_KEEP` | `10` | 每块板留几份自动快照（`0` = 关掉整个安全网） |
| `BLOTBOARD_CHECKPOINT_ORPHAN_TTL_DAYS` | `30` | 画板被删之后，它的快照目录再留几天才清（`0` = 永不清）。留着是为了「删错了还能整块捞回来」 |
| `BLOTBOARD_CHECKPOINTS_DIR` | `<data>/checkpoints` | 快照落在哪 |
| `BLOTBOARD_DATA_FILE` | `<data>/boards.json` | 旧单文件存储位置（首启迁移用；画板目录由它派生为 `<同名去 .json>/`） |
| `BLOTBOARD_UPLOADS_DIR` | `<data>/uploads` | 附件目录 |
| `BLOTBOARD_MEDIA_MAX_MB` | `200` | 音视频上传的单文件上限（MB）。图片 10 MB / PDF 20 MB 是写死的，音视频按这个值 |
| `BLOTBOARD_ISSUES_FILE` | `<data>/issues.json` | local 后端的 Issue 存储 |
| `BLOTBOARD_RUNNER_SETTINGS_FILE` | `<data>/runner-settings.json` | ACP agent 注册表 |
| `BLOTBOARD_RUNS_DIR` | `<data>/runs` | ACP run 的 transcript |
| `BLOTBOARD_AGENT_COMMANDS_FILE` | `<data>/agent-commands.json` | 自定义 agent 指令 |
| `BLOTBOARD_TEMPLATES_DIR` / `BLOTBOARD_CARD_SPECS_DIR` | `<root>/data/templates` / `<root>/data/card-specs` | 随仓库发布的资产目录 |
| `BLOTBOARD_USER_CARD_SPECS_DIR` / `BLOTBOARD_CARD_SPEC_STATE_FILE` / `BLOTBOARD_CARD_PACKS_FILE` | `<data>/my-card-specs` 等 | 自定义规格 / 规格开关 / 卡片包开关 |

MCP server 侧另有两个（给客户端配置用）：`BLOTBOARD_URL`（连哪台画板）与 `BLOTBOARD_TOKEN`（写操作）。

## 放到公网前想清楚

画板**没有账号体系**——它假设「能连到这个端口的人 = 你自己」。守住这条假设的是两道闸门：

| 闸门 | 在哪 | 管什么 |
| --- | --- | --- |
| **网络层**：只接受可信网段直连 | `server.mjs`（TCP `remoteAddress`，不是可伪造的 `x-forwarded-for`） | 本机 / 私网 / Tailscale(100.64/10) / 链路本地放行，其余一律 403 |
| **应用层**：写操作要凭证 | `lib/auth.ts` | 浏览器靠同源 + `x-board-web`，agent 靠 `x-auth-key`；**读操作免鉴权** |

`BLOTBOARD_ALLOW_PUBLIC_DIRECT=1` 关掉的是**第一道**。默认只绑定 `127.0.0.1`；
如果显式改为 `BLOTBOARD_HOST=0.0.0.0`（所有网络接口）且关掉闸门，任何能连到这个端口的人都能读写全部画板。
所以启动时会在日志里大声警告一次；不做启动即退出，是因为「放在带鉴权的反代后面」本身是正当用法。

真要对外提供访问，选一条：

- **反向代理 + 你自己的鉴权**（推荐）：代理做 SSO / Basic Auth，回源到 `127.0.0.1:<port>`，
  画板侧保持 `BLOTBOARD_HOST=127.0.0.1`（这样连第一道闸门都不用关）。
  代理会重写 `x-forwarded-*`，这时才该开 `BLOTBOARD_TRUST_PROXY=1`。
- **Tailscale / WireGuard**：显式绑定相应虚拟网卡地址或 `0.0.0.0`，限制哪些设备能访问；默认 loopback 不接受远程连接。

### 已知边界（不是 bug，是设计，但你得知道）

- **上传件的下载 / 预览没有应用层鉴权**：`/api/uploads/{id}` 是有意免鉴权的——卡面的
  `<img src>` 与导出的单文件 HTML 都要能直接取到它，加了 token 图就裂了。
  拦住它的只有**不可枚举的 upload id** 加上面那道网络层闸门。放到不可信网络前，
  这一层得你自己补（反代上按路径加鉴权，或干脆别开放 `/api/uploads/`）。
- **ACP agent 继承画板进程的全部环境变量**：注册在 `<data>/runner-settings.json` 里的命令
  由画板 `spawn`，能看见画板的内部 token 和你 shell 里导出的一切。**别注册来路不明的命令**
  ——能改那个文件或调 `PATCH /api/runner-settings` 的人，等于能在这台机器上以你的身份执行任意命令。
  细节见 [docs/RUNNER.md](docs/RUNNER.md) §4.1。
- **读操作免鉴权**：`GET /api/boards/...`、`/api/skill`、`/api/capabilities` 都不要 token。
  这是给 agent 与浏览器省事的有意取舍，边界同样落在上面两道闸门上。

发现安全问题请看 [SECURITY.md](SECURITY.md)。

## 测试与诊断

```bash
npm run check       # ★ 提交前只跑这一条：lint:repo → test:unit → typecheck → build → smoke → e2e
npm run doctor      # 用着出问题时：打活服务，出一份可以直接贴进 issue 的诊断报告（只读）
```

`check` 里的每一步也能单独跑：

| 命令 | 是什么 |
| --- | --- |
| `npm run lint:repo` | 仓库静态体检（秒级、零依赖）：私有痕迹 / grep 不可见的源文件 / 文档死链 / 卡片包完整性 / env 与本表对账 / CSS 变量 / 构建期 env 陷阱 / 工作区外来物 |
| `npm run test:unit` | 构建互斥、源码发布边界、JS/CSS 诊断回归 |
| `npm run release:source` | 从干净提交生成不含 Git 历史及私人数据的源码包 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | 生产构建（smoke / e2e 都要吃它的产物） |
| `npm run smoke` | API 冒烟：自起隔离实例 + mock Runner + mock ACP agent + MCP 子进程，不碰 `data/` |
| `npm run e2e` | Playwright 端到端（需先 `npx playwright install chromium`）：goal-agent 与 local 双形态 |
| `npm run mock:integrations` | 知识库 / 书库两条可选集成的参考实现（零依赖单文件，见 [INTEGRATIONS.md](docs/INTEGRATIONS.md)） |

报 bug 时贴上 `npm run doctor` 的输出：版本 / 端口实际落位 / 数据目录 / token 生效**来源类型**
（不打印值）/ 三个可选集成的可达性 / 板数与坏板文件 / 快照占用 / 磁盘余量，一次给全。

## 深入读

- [AGENTS.md](AGENTS.md) —— 给「打开仓库改代码」的 agent：架构四层、目录导览、数据约定、红线、加卡片包指南
- [CONTRIBUTING.md](CONTRIBUTING.md) —— 怎么跑起来、完整验收命令、提交前的要求
- [SECURITY.md](SECURITY.md) —— 威胁模型、两道闸门、已知边界、怎么报告安全问题
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) —— 行为准则（Contributor Covenant 2.1）
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) —— 知识库 / 书库两条可选集成的协议 + 参考实现
- [CHANGELOG.md](CHANGELOG.md) —— 变更记录与已知技术债
- [docs/CARD-SPEC.md](docs/CARD-SPEC.md) —— 卡片规格与信封格式：外部系统怎么往画板送结构化卡片
- [docs/RUNNER.md](docs/RUNNER.md) —— 任务后端协议（4 动作 + 回写契约 + ACP 派单），想接自己的 agent 后端看它
- [docs/OPEN-SOURCE-PLAN.md](docs/OPEN-SOURCE-PLAN.md) —— 开源路线与决策记录
- [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) —— 运行时依赖与协议清单

## License

[MIT](LICENSE)

## 整理与连续撤销

完全散乱的卡片可先网格铺开（按卡数与尺寸选择均衡行列），再按类型或流程整理；已形成结构的板优先整齐化。固定分组框保留原位，自由卡会避开固定区域。

Ctrl/Cmd+Z 连续撤销，Ctrl/Cmd+Shift+Z 重做（Windows/Linux 也支持 Ctrl+Y）。历史面板显示持续编辑记录，刷新后仍可用；文字编辑时保留编辑器自己的撤销。左下角 `?` 按钮提供完整快捷键说明。

需要复现实验时，运行 `node scripts/audit-layouts.mjs` 查看帮助。该脚本只有显式 `--write` 才创建专用测试画板，不会拿已有业务板做整理实验。

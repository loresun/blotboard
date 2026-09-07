# Issue：ACP 派单易用性修复（Phase 1 三项 P1 · Phase 1.5 预设与检测 · Phase 2 任意后端可派本地 agent）—— 全部已实现

> 依据：2026-09-07 ACP 派单能力审查（隔离实例 8 轮实测 + v1 协议对照，报告见
> `~/codebase/study/blotboard-acp-audit-20260907/REPORT.md`）。
> 本文件按「可直接执行的修复规格」写，建议拆成两条 GitHub issue（Phase 1 / Phase 2）。

## 背景（实测复现，非推测）

ACP 派单的「prompt → agent」链路里，**地址能送到 agent（写在 prompt 文本里，默认
`http://127.0.0.1:<port>`，对同机 spawn 恰好正确），但凭证送不到**：

- prompt 指引写「token 取环境变量 `BLOTBOARD_INTERNAL_TOKEN`，或读数据目录下的 token 文件」，
  但 `startAcpRun` spawn 的 env 是 `{ ...process.env, ...agent.env }`——开源默认走自管
  `<data>/token`（第 3 级来源），画板进程 env 里**没有**这个变量，agent 自然继承不到；
- 「数据目录下的 token 文件」刻意只给相对表述（prompt 会经免鉴权 `GET /api/issues/:id`
  吐出去，不能泄露绝对路径），agent 的 cwd 又在 `acp-workspace/`——三头堵死；
- **实测**（真 Claude Code ACP，analyze 任务）：agent 拿到 prompt 后在文件系统里乱翻找
  token（"Search /tmp for blotboard data dirs"），连环产生 2 次权限请求，150s 还没开始干活。

同轮实测还踩中两个排障盲区：

- mock agent 忘配 cwd → run `failed`，transcript 只有一句「agent 进程意外退出（code 1）」，
  真实原因（node 找不到脚本）用户永远看不到；
- agent 缺 API key 时返回 `-32000`（auth_required），用户看到的是
  「agent 会话失败（协议错误码 -32000）」，没人知道该去 Runner 设置配 env。

## Phase 1：三项 P1（本轮修复）

### Fix 1：ACP spawn 注入回写凭证（核心，约 3-5 行）

`lib/acp/manager.ts` `startAcpRun` 的 spawn env 追加：

- `BLOTBOARD_INTERNAL_TOKEN`：复用 `lib/config.ts` 的 internal token 解析（三级来源，
  与 `describeAuth` 同一真源），解析不到不注入（不臆造）；
- `BLOTBOARD_API_BASE`：`PUBLIC_URL`（`lib/config.ts`）。

约束：

- 只在 ACP spawn 通道注入（人点按钮 / 带鉴权 API），copy-prompt 通道与 API 响应不变；
- token 值**不进 prompt、不进 issues.json、不进任何 API 响应**（prompt 措辞不用改，
  它已经写了「取环境变量 BLOTBOARD_INTERNAL_TOKEN」）；
- `agent.env` 里同名变量仍以注册表为准（agent 配置显式覆盖注入值）。

### Fix 2：stderr 摘要落 transcript（消掉排障盲区）

现状 `child.stderr?.resume()` 直接丢流；`lib/acp/transcript.ts` 已预留 `"stderr"` 类型、
前端 `transcriptBlocks` 已会渲染（`entry.type === "stderr"`）——后端补上即可：

- 进程内环形缓冲收 stderr（上限如 200 行，防跑飞 agent 撑内存）；
- run 到**终态**时（failed / completed / aborted 任一，failed 必须有）：脱敏后取最后
  ≤10 行 append **一条** transcript entry（`{ type: "stderr", text }`）；
- 脱敏规则：把绝对路径中的数据目录与工作目录片段替换为占位、按 env 值长度过滤疑似
  密钥串（与现有「不发布原始诊断」的注释口径一致）；
- env 开关 `BLOTBOARD_ACP_STDERR=full`：全量原文写 `<data>/runs/<runId>.stderr.log`，
  权限 0600（与 token 文件同待遇），不进 transcript；
- failed 时 run note 末尾附 stderr 最后一行人话（如「agent 进程意外退出（code 1）：Cannot
  find module …」）。

### Fix 3：`-32000` auth_required 人话引导

`driveSession` catch 里特判 `RpcRemoteError.code === -32000`：

- note 改为「该 agent 需要认证：请在任务台 → Runner 设置为它配置 API key（env），
  或先在本机完成该 agent 的登录后重试」；
- 其余错误码维持现状。

### 回归与验收（Phase 1 全部满足才算完成）

- [ ] `scripts/mock-acp-agent.mjs` 新增 `--mode echo-env`：读 env 里的
      `BLOTBOARD_INTERNAL_TOKEN` 与 `BLOTBOARD_API_BASE`，用它们真实 PATCH 回写
      run 状态为 completed——smoke 用它验证 Fix 1 闭环；
- [ ] 新增 `--mode crash`：打印一行带路径的错误到 stderr 后 exit 1——smoke 用它验证
      Fix 2（transcript 出现 stderr 条目、note 含原因）；
- [ ] **默认自管 token 部署**（不设 `BLOTBOARD_INTERNAL_TOKEN` env）下上述两条通过；
- [ ] smoke 增加安全断言：`GET /api/issues/:id` 响应全文不含 token 值与绝对路径；
- [ ] `npm run check` 全绿（lint / typecheck / build / smoke / e2e）；
- [ ] 文档：`docs/RUNNER.md` §4 补两句「ACP 派单会注入哪些 env」；README 环境变量表
      `BLOTBOARD_PUBLIC_URL` 行补一句「跨机访问 / 浏览器深链可用时必须配，否则写进
      prompt 的回写地址与深链都是 127.0.0.1」。

## Phase 1.5：内置预设 + 连通性检测（已实现）

### 起因

Phase 1 之后，「ACP 能跑」这件事仍然要靠手抄命令行赌一把。实测发现两个断层：

- **装了 CLI ≠ 它说 ACP**：五个目标 agent 里只有 kimi / opencode 自带 `acp` 子命令，
  Claude Code / Codex / pi 都要跑一个独立的适配器进程；
- **说了 ACP ≠ 能开会话**：没登录会在握手里回 `-32000`。

还踩到一个具体的坑：`acpx` 里钉的 `@agentclientprotocol/claude-agent-acp@^0.31.0` 已过期
（最新 0.75.x），钉旧版的表现是**握手不返回、超时**——最难查的那种失败形态。

### 已实现

- `lib/acp/presets.ts`：五个内置预设（Claude Code / Codex / Kimi / opencode / pi），
  每条带首选命令 + npx 兜底 + 认证说明 + 实测备注；适配器一律 `@latest` 不钉版本；
- `lib/acp/probe.ts` + `POST /api/runner-settings/probe`：用**派单时的同一套握手**真跑一次
  （spawn → initialize → session/new → 立刻杀），**不发 prompt**，不花 token、不动文件。
  三种问法：`presetKey`（含兜底重试）/ `agentId`（已注册的）/ `command+args`（草稿）；
- 任务台「Runner 设置」：预设卡片 +「检测并添加」（探通了才落盘，落的是探通的那条命令）、
  每条已注册 agent 与编辑中的草稿都能单独「检测」，结果分「已连通 / 只差登录 / 没通（卡在哪一步）」
  三档呈现，带可展开的 stderr 尾巴；
- 面板在**任何后端下都渲染**（原来非 local 直接不给编辑入口）——先把本机 agent 配好验通，
  Phase 2 接通后即可直接派；文案如实说明「派单还走不到它们」。

### 顺带修掉的两处

- `lib/acp/redact.ts`：脱敏规则从 manager.ts 抽出来共用，并修掉 **macOS realpath 漏网**——
  `/var` 是 `/private/var` 的软链，子进程报的是 realpath，只按原样路径替换会留下 `/private<工作目录>`
  这样的残片。现在两种写法一起换；
- `INIT_TIMEOUT_MS` 30s → 60s：实测 codex-acp 冷启动到 session/new 要 22.2s，只剩 8s 余量，
  机器一忙就会以「握手超时」假失败（npx 首次下载适配器还要再叠十几秒）；
- `scripts/mock-acp-agent.mjs` 的 echo-env 模式有竞态：它先 PATCH 成 completed 再发对话块，
  而回写终态会让画板当场杀掉子进程——对话块是否来得及入 transcript 纯看调度。改成先说话再回写。

### 实测（2026-09-07，本机，经 `POST /api/runner-settings/probe` 真握手）

| agent | 探通的命令 | 耗时 | authMethods |
| --- | --- | --- | --- |
| Kimi CLI | `kimi acp` | 0.7s | `login` |
| Claude Code | `npx -y @agentclientprotocol/claude-agent-acp@latest` | 3.7s | （已登录，空） |
| pi | `npx -y pi-acp@latest` | 3.4s | `pi_terminal_login` |
| opencode | `opencode acp` | 6.6s | `opencode-login` |
| Codex | `codex-acp` | 20.2s | `chatgpt` / `codex-api-key` / `openai-api-key` |

## Phase 2（已实现）：任意任务后端下都能派给本地 ACP agent

### 问题

`tasks.backend` 三选一（http / goal-agent / local）：ACP 派单只在 **local** 下存在；
goal-agent / http 后端下 `agentId` 被丢弃（卡片 launch route 注释明确「远程后端下被丢弃」）。
结果是：已经接了外部 Runner 的部署（含作者本机 8567，backend=goal-agent）**反而用不上
「一键派给本机 Claude Code / Gemini」**——最需要这个能力的人用不了。

### 目标

本地 ACP agent 注册表（runner-settings.json）与派单能力**与 tasks.backend 解耦**：
任何后端下，任务台 / 卡片 launch 都可以选「交给本机注册的 agent」真跑 ACP。

### 建议方案（实现前先出设计确认）

把「本地 ACP 执行」当作独立执行通道，而不是第三种 backend：

- Issue 真源仍归 tasks.backend（不造第二本账）；
- `launch(issueId, { agentId })` 时若命中本地注册表 → 走 `acp/manager` spawn，
  run 记录落在本地（issue-store 或独立 runs 存储），任务卡轮询 `getTask` 按前缀路由；
- 外部 Runner 的 launch 与本地 ACP launch 在 UI 上并列两个入口（不互相抢默认值）；
- 权限确认 / transcript / 中止链路全部复用 Phase 1 之后的现有实现。

具体落点（2026-09-07 读代码确认，四处）：

1. `lib/integrations/task-backend.ts` 的 `makeRemoteBackend.launch` 现在**签名收了
   `options` 却不接**（`launch: (issueId, payload) => callRunner(...)`）——agentId 就丢在这；
2. `lib/issue-service.ts` 的 `assertLocalIssues()` 是一道**整体闸**：非 local 后端下
   `/api/issues/*` 全部 501，连 ACP 的回写口 `PATCH /api/issues/:id/runs/:runId` 与
   transcript 读口一起挡死。需要拆成两道——「Issue 真源类操作」仍 501，
   「run 级操作」只要本地查得到这个 run 就放行；
3. 本地执行台账：远程后端下派 ACP 时，把远程 Issue 的正文取回来（`proxy GET /api/issues/:id`）
   建一条带 `external: { backend, issueId, number }` 标记的本地执行记录，
   复用 issue-store 承载 run + transcript + 权限请求（**不是第二本 Issue 账**，
   任务台在远程后端下应把它显示成「本机执行记录」而非 Issue 列表）；
4. `getTask` 前缀路由：`r_` 开头且本地查得到 → 本地服务，否则打远程；
   `components/TasksApp.tsx` 里 `const local = backend === "local"` 这道闸决定了
   agent 下拉的可见性，是 UI 侧要动的主要位置。

### 验收标准（全部达成）

- [x] goal-agent 后端的任务台详情出现 agent 下拉，选中后真拉起本机 agent 跑完一轮，
      来源卡状态联动（issued → running → done）；
- [x] 同一 Issue 的外部 Runner 执行与本地 ACP 执行各自记账、互不干扰
      （run id 前缀路由；不带 agentId 的 launch 请求体逐字节照旧发对端，smoke 有断言）；
- [x] `tasks.backend=local` 行为完全不变（原有 e2e / smoke 全绿）；
- [x] `npm run check` 六步全绿。

### 实现落点（与上面的四处一一对应）

| 文件 | 做了什么 |
| --- | --- |
| `lib/integrations/acp-lane.ts`（新） | 本机 ACP 执行通道：取对端 Issue 现状 → 开/复用执行台账 → `startAcpRun`；`localRunTask` 供前缀路由 |
| `lib/issue-store.ts` | `ExternalIssueRef` 标记 + `ensureExternalIssue` / `findExternalIssue` / `listOwnIssues`（台账不进 Issue 列表） |
| `lib/issue-service.ts` | 整体闸拆成三道：`assertLocalIssues` / `assertLocalIssue` / `assertLocalRun` |
| `lib/integrations/task-backend.ts` | 远程后端 `launch` 认 `agentId`（走 lane）、`getTask` 与 `proxy` 前缀路由 |
| `lib/acp/manager.ts` | `syncSourceCard`：本机 run 的终态推着来源卡状态走 |
| `components/TasksApp.tsx` | 「本机执行」镜头 + 列表行标记 + 详情区块（下拉 / 派单 / 流式 transcript / 权限 / 中止） |

### 呈现上的取舍（2026-09-07 与用户确认）

本机 run **不另开列表、不另开标签页**——它不是「另一类任务」，而是同一条任务的另一个执行者。
所以是「同一行打标记 + 详情里多一块」：那一块（流式 transcript / 权限确认 / 中止）恰好是
外部 Runner 那条路给不了的，也正是两条路值得分开呈现的全部理由。

### 已知边界

- 外部 Runner 那条路的卡片状态仍停在「执行中」不自动回落：那条 run 的生命周期不归画板所有，
  画板只在详情 / 任务抽屉里实时显示对端状态。要改得先定义「谁来推动镜像状态」，是另一件事。

## 优先级与建议顺序

三个阶段均已实现，`npm run check` 六步全绿。回归覆盖：smoke 新增 `acp-probe`
（五条预设下发 / 鉴权 / 三种失败形态 / 脱敏）与 `acp-remote-lane`
（goal-agent 后端下本机派单闭环 + 闸门边界 + 远程链路零变化），e2e 第十二轮改成
「两种后端下注册表与预设检测都可用」。

# Blotboard Runner 协议

> 本文档以 MIT 协议发布（与仓库一致），可自由复制、改编到你自己的 agent 系统里。

Blotboard（泼墨画板）把「任务卡 → agent 执行」抽象成一个只有 **4 个动作**的任务后端接口
（`lib/integrations/task-backend.ts`）：

| 动作 | 语义 |
| --- | --- |
| `createIssue` | 任务卡「转 Issue」：把画板拼好的需求（正文 + 画板上下文 + 未解决评论 + 卡片 agent 指令）登记成一条工作项 |
| `patchIssue` | 画板 → 后端的单向正文同步：卡片改了，把最新 title/description/priority 推过去 |
| `launch` | 对已有 Issue 发起一次执行 |
| `getTask` | 查询一次执行的最新状态（画板不落库，轮询现查） |

后端三选一，由环境变量决定（`lib/features.ts`，次序从上到下）：

1. **`http`** —— `BLOTBOARD_RUNNER_URL`：任何按本文档实现 REST 形状的服务；
2. **`goal-agent`** —— `GOAL_AGENT_RUNNER_URL`：http 的特例，实现完全共用，只是 token 来源不同；
3. **`local`** —— 都没配（开源默认）：Issue 落本地 `<data>/issues.json`，「发起任务」生成完整
   prompt 供复制，agent 通过本文档 §3 的回写契约汇报进度。

当前后端种类可从 `GET /api/capabilities` 的 `tasks.backend` 字段探到。

---

## 1. 远程后端的 REST 形状（http / goal-agent）

画板作为客户端，按下面 4 条端点调用你的服务。响应统一为 JSON；出错时给
`{ "error": "人话原因" }` 与合适的状态码（4xx 会原样透传给用户，5xx 画板包装成 502）。

### 1.1 建 Issue

```
POST {RUNNER_URL}/api/issues
{ "title": "…", "description": "…", "priority": "urgent|high|medium|low|none", "labels": ["board"] }

→ 201 { "issue": { "id": "任意字符串 id", "number": "可读编号（可选，identifier 也认）" } }
```

画板只保存 `issue.id`（引用），真源永远在你这边。`description` 是画板拼装好的完整需求，
含画板上下文、未解决评论、卡片自带的 agent 指令——直接可以当 prompt 用。

### 1.2 同步正文

```
PATCH {RUNNER_URL}/api/issues/{issueId}
{ "title": "…", "description": "…", "priority": "…" }

→ 200 { "issue": { "id": "…", … } }
→ 200 { "issue": null }        // Issue 已被删（画板据此在卡片上标「同步失败」）
```

只会推画板自己写的三个字段；你侧生成的 analysis / acceptanceCriteria / status 等字段
画板一律不碰。内容没变时画板靠指纹去重，不会重复请求。

### 1.3 发起执行

```
POST {RUNNER_URL}/api/issues/{issueId}/launch
{ "mode": "implement|analyze", "extraInstructions": "卡片自带指令（可选，不认可忽略）" }

→ 201 { "sessionId": "执行任务 id" }
```

`sessionId` 会被画板存到卡片上（`task.taskId`），之后用它轮询状态。

### 1.4 查询执行状态

```
GET {RUNNER_URL}/api/tasks/{taskId}

→ 200 { "task": { "id": "…", "status": "running|waiting|completed|failed|aborted",
                   "summary": "一句话进展（可选）", "updatedAt": 1690000000000 } }
```

`status` 之外的值也能显示（原样透传），但上面五个是画板认识、有专门文案的。

### 1.5 鉴权与探活

- 每个请求带头 `x-auth-key: <token>`。
  - `http` 后端：token 取 `BLOTBOARD_RUNNER_TOKEN`（不配则退回画板内部 token，见下）；
  - `goal-agent` 后端：token 与画板内部 token 同源（三级来源：`BLOTBOARD_INTERNAL_TOKEN` →
    `BLOTBOARD_GOAL_AGENT_SETTINGS` 指向的 settings.json → 画板自管的 `<data>/token`）。
- 画板的健康检查会探 `GET {RUNNER_URL}/api/capabilities`（响应 2xx 即视为在线）；建议实现，
  不实现只影响 `/api/health` 里的 `runner` 字段。
- 画板前端另有一条**直通代理** `/api/runner/*`（白名单见 `lib/goal-agent.ts` `runnerProxyPath`）：
  会额外用到 `GET /api/issues/{id}`、`PATCH /api/issues/{id}`（改标签 / 状态）、
  `GET /api/tasks/{id}/(events|transcript)`、`GET /api/artifacts?taskId=`、`POST /api/tasks`
  （自由派单）。不实现这些只是对应面板功能缺位，4 动作主链路不受影响。

现成后端示范：[coder/agentapi](https://github.com/coder/agentapi)（在它前面包一层这 4 条端点，
即可把 10+ 种 coding agent 接进画板）；goal-agent 是作者的私有适配器，形状与本节一致。

---

## 2. local 后端（开源默认，零依赖闭环）

不配任何 Runner 时，4 个动作全部落在画板本地：

- Issue 存 `<data>/issues.json`（`lib/issue-store.ts`，原子写）；
- `launch` 不拉起任何进程，而是生成一份**完整 prompt**（Issue 正文 + 画板深链 + §3 的回写
  指引），挂成 Issue 下的一个 **run**（`r_xxx`，初始状态 `pending` 待派）。你把 prompt 复制给
  任何 agent（Claude Code / Codex / Gemini CLI / 网页对话…都行），它干完活按 §3 回写；
- `getTask(runId)` 读取 run 状态，映射成 §1.4 的形状——任务卡页脚的轮询两种后端通吃。

管理界面是任务台子页 `/tasks`（镜头：待派 / 进行中 / 等我处理 / 已完成 / 已中止；
支持 `?issue=i_xxx` 与 `?board=b_xxx` 深链；来源画板 / 卡片被删的孤儿 Issue 也只有这里能看到）。

## 3. local 模式的 agent 回写契约

agent（或任何脚本）通过画板自己的 API 回报进度。**写操作需要请求头
`x-auth-key: <token>`**，token 就是画板内部 token（`BLOTBOARD_INTERNAL_TOKEN` 环境变量，
或画板数据目录下的 `token` 文件——首次启动自动生成并打印路径）。

```
GET   /api/issues?board=&status=&q=        列表（免鉴权只读；status 收镜头名：
                                           pending|in_progress|attention|done|aborted|all）
GET   /api/issues/{issueId}                详情：全字段 + runs（含各自 prompt）+ 日志 + 顶层 prompt
PATCH /api/issues/{issueId}                改 Issue：{ "status": "...", "labels": [...], "note": "追加一条日志" }
                                           status ∈ pending|in_progress|blocked|review|done|aborted|parked
PATCH /api/issues/{issueId}/runs/{runId}   回报执行：{ "status": "...", "note": "..." }
                                           status ∈ pending|running|waiting|completed|failed|aborted
```

run 状态会顺带推动 Issue 状态（`lib/issue-store.ts`）：`running → in_progress`、
`waiting / failed → blocked`（进「等我处理」镜头）、`completed → done`、`aborted → pending`。

典型一轮（launch 生成的 prompt 里已带好这几条命令与具体 id）：

```bash
TOKEN=$(cat <data>/token)
# 开工
curl -X PATCH http://127.0.0.1:8567/api/issues/i_xxx/runs/r_yyy \
  -H "x-auth-key: $TOKEN" -H "content-type: application/json" \
  -d '{"status":"running"}'
# 干完
curl -X PATCH http://127.0.0.1:8567/api/issues/i_xxx/runs/r_yyy \
  -H "x-auth-key: $TOKEN" -H "content-type: application/json" \
  -d '{"status":"completed","note":"已完成：改了 3 个文件，测试全绿"}'
```

配了外部 Runner 时，这组 `/api/issues` 端点返回 `501` 并指路（真源在 Runner，别造出第二份账本）。

---

## 4. ACP 派单（任何后端下都成立的第二种 launch 方式）

除了「生成 prompt 供复制」，画板还能**真拉起本机的 coding agent**：
launch 时带 `agentId`，画板就 spawn 注册表里那个 agent 的子进程，走
[ACP（Agent Client Protocol）](https://agentclientprotocol.com)（JSON-RPC 2.0 over stdio）
跑这一个 run——流式进展与权限确认都回到任务台。不带 `agentId` 时行为与 §2 完全一致。

### 4.1 Agent 注册表

`<data>/runner-settings.json`，任务台「Runner 设置」区可视化管理，API：

```
GET   /api/runner-settings          当前设置（鉴权同写口；env 只回 key 名，值绝不回显）
PATCH /api/runner-settings          { agents?, defaultAgentId?, permissionMode? }（写口鉴权同 §3）
```

注册表读写都要求 §3 的同源浏览器头或 `x-auth-key`：命令、参数与工作目录属于运维配置，不能通过无鉴权读口公开。API 返回仍只含 env 的键名；凭据应放在 env 中。服务生成的 run 错误与启动记录不包含原始 stderr、启动参数或工作目录，排障请在本机核查 agent 配置。

`agents` 是完整替换列表，每条 `{ id?, name?, command, args?, cwd?, env? }`；
带已有 id 且**不带 env 字段** = 保留存盘的 env（浏览器拿不回值，只能这么表达「别动」）。
`permissionMode`：`ask`（默认）= agent 的权限请求挂起等人批，run 停在 waiting、
Issue 进「等我处理」镜头；`auto` = 自动选 allow 类选项并在 transcript 里记账。

**cwd 很重要**：留空时 agent spawn 在 `<data>/acp-workspace/`（自动建目录）——
想让 agent 改你的某个仓库，就把该 agent 的 `cwd` 配到那个仓库。

**画板会往子进程注入两个环境变量**：`BLOTBOARD_API_BASE`（= `BLOTBOARD_PUBLIC_URL`，
与 prompt 里的回写地址同一个 base）和 `BLOTBOARD_INTERNAL_TOKEN`（画板当前生效的内部
token，三级来源见 README 环境变量表；解析不到就不注入）。agent 不用翻文件系统找凭证，
拿这两个值按 §3 的回写契约直接回报状态即可。token 只走 env 这条通道——
prompt、API 响应、`issues.json` 里都不会出现它的值。`agents` 里配了同名键时以注册表为准。

> ⚠️ **注册表是高信任输入**。这里登记的命令由画板 `spawn` 起来，且
> **子进程继承画板进程的全部环境变量**（`{ ...process.env, ...agent.env }`）——
> 画板的内部 token、你 shell 里导出的任何 API key，agent 全看得见。
> 这是有意的（agent 常常真的需要 `PATH`、代理设置、自己那份 key 才跑得起来），
> 但代价是：**别注册来路不明的命令**。谁能改 `<data>/runner-settings.json`
> 或调 `PATCH /api/runner-settings`，谁就能在你的机器上以你的身份执行任意命令。
> 反过来说，把画板的写接口暴露到不可信网络之前，先想清楚这一条。

示例配置（mock 条目的相对路径要求 cwd 配成画板仓库根）：

```jsonc
{ "agents": [
  { "id": "claude-code", "name": "Claude Code", "command": "npx",
    "args": ["-y", "@agentclientprotocol/claude-agent-acp@latest"], "cwd": "/path/to/your/repo" },
  { "id": "kimi",   "name": "Kimi CLI", "command": "kimi", "args": ["acp"] },
  { "id": "mock",   "name": "Mock（测试）", "command": "node",
    "args": ["scripts/mock-acp-agent.mjs", "--mode", "auto-finish"] }
] }
```

### 4.1.1 内置预设与连通性检测

手抄命令行容易错在两处：**装了 CLI 不等于它说 ACP**（Claude Code / Codex / pi 都要跑一个
适配器进程），**说了 ACP 不等于能开会话**（没登录会在握手里回 `-32000`）。所以任务台
「Runner 设置」里带了一份预设清单和一个检测口：

```
POST /api/runner-settings/probe     { presetKey } | { agentId } | { command, args?, cwd? }
GET  /api/runner-settings           响应里的 presets 字段就是这份清单
```

检测做的事是**用派单时的同一套握手真跑一次**：spawn → `initialize`（protocolVersion 1，
clientCapabilities 与真派单逐字一致）→ `session/new` → 立刻杀进程。**不发 `session/prompt`**，
所以不花 token、不动任何文件。返回 `{ ok, stage, command, args, ms, protocolVersion,
authMethods, needsAuth, error, stderrTail }`——`stage` 说明卡在哪一步（`spawn` =
命令不在 PATH 里、`initialize` = 起来了但不说 ACP、`session` = 说 ACP 但开不了会话）。
`error` 与 `stderrTail` 与终态 stderr 摘要走同一套脱敏（路径换占位、够长的 env 值当密钥抹掉），
且**检测通道不注入 `BLOTBOARD_INTERNAL_TOKEN`**——握手用不上它，最小权限。

内置预设（`lib/acp/presets.ts`，命令均按上述握手实测过）：

| 预设 | 首选命令 | npx 兜底 |
| --- | --- | --- |
| Claude Code | `claude-agent-acp` | `npx -y @agentclientprotocol/claude-agent-acp@latest` |
| Codex | `codex-acp` | `npx -y @zed-industries/codex-acp@latest` |
| Kimi CLI | `kimi acp` | —（自带 acp 子命令） |
| opencode | `opencode acp` | `npx -y opencode-ai@latest acp` |
| pi | `pi-acp` | `npx -y pi-acp@latest` |

面板上的「检测并添加」会先探首选命令、不通再探兜底，**探通了才落盘，落的是探通的那条**——
所以注册表里存的一定是这台机器上真能跑的形态，而不是文档里的理想形态。
适配器版本一律用 `@latest` 而不钉死：钉旧版会以「握手超时」这种最难查的形态失败。

> 注册表与检测在**任何**任务后端下都可用；带 `agentId` 的派单也是（见 §4.3）。

### 4.2 发起、进展、权限、中止

```
POST /api/issues/{issueId}/launch                       { "mode": "implement|analyze", "agentId": "claude" }
POST /api/boards/{bid}/cards/{cid}/launch               同上（卡片入口；远程后端下也认 agentId，见 §4.3）
GET  /api/issues/{id}/runs/{runId}/transcript?offset=N  流式 transcript 增量读（免鉴权只读）
POST /api/issues/{id}/runs/{runId}/permission           { "optionId": "..." }（ask 档兑现权限请求，写口鉴权）
PATCH /api/issues/{id}/runs/{runId}                     { "status": "aborted" } 触发中止链路
```

- **同一 Issue 同时只允许一个在跑的 run**：并发 launch 回 409；
- transcript 单独存 `<data>/runs/<runId>.jsonl`（`session/update` 逐条 append，含时间戳），
  `offset` 用上一次响应里的值即可增量拉取，响应顺带带回 run 状态与挂起的权限请求；
- 中止 = 先发 `session/cancel` 给 agent 体面退出的机会，5 秒不走 SIGTERM、再不走 SIGKILL；
- prompt 内容就是 §2 生成的那份完整 prompt（含深链与 §3 回写指引）——ACP 流式通道
  与 HTTP 回写通道**双轨并存**，agent 仍可回写补充结构化状态；
- 画板作为 ACP 客户端**能力最小化**：不提供 fs / terminal（initialize 里声明，硬发回 -32601）；
- **服务重启兜底**：重启后内存里的会话都没了，启动扫描把「状态还在跑但会话丢失」的 run
  一律标 `aborted` 并在日志与 transcript 里注明「服务重启，会话丢失」；
- **stderr 摘要**：agent 的 stderr 只在内存里留一个环形缓冲（200 行），run 到终态时取最后
  ≤10 行**脱敏后**（本机路径换占位、疑似密钥整段抹掉）落一条 `type: "stderr"` 的 transcript，
  failed 的 run 备注末尾也带上最后一行；`BLOTBOARD_ACP_STDERR=full` 时另把原文全量写到
  `<data>/runs/<runId>.stderr.log`（0600），原文不进 transcript。

### 4.3 远程后端下的本机 ACP（执行通道与任务后端解耦）

`agentId` 不再是 local 后端的专利：**goal-agent / http 后端下带 `agentId` 的 launch 一样跑在本机**
（实现见 `lib/integrations/acp-lane.ts`）。这条路解决的是「已经接了外部 Runner 的部署反而用不上
一键派给本机 Claude Code」——最需要这个能力的人原来用不了。

它怎么与远程真源共处：

- **Issue 真源不动**。派单前先 `GET /api/issues/:id` 从对端把**此刻**的标题正文取回来
  （不是转 Issue 时那份旧快照），画板本地只开一条带 `external: { backend, issueId, number }`
  标记的**执行台账**来挂 run / transcript / 权限请求。台账不进任务台的 Issue 列表，
  也不参与 Issue 同步——不造第二本账；
- **同一条远程 Issue 的多次本机执行记在同一条台账上**，历史连得起来；
- **run id 前缀即路由**：本机 run 一律 `r_` 开头，`GET /api/tasks/:taskId`（及
  `/api/runner/tasks/:taskId` 代理）命中就地服务，否则打对端。外部 Runner 的执行与本机执行
  各自记账、互不干扰；
- **不带 `agentId` 时远程链路零变化**：请求体逐字节照旧发给对端（这是硬性验收项，smoke 有断言）。

端点闸门也跟着拆成三道（`lib/issue-service.ts`）——原来是「非 local 后端下 `/api/issues/*` 整体 501」，
那会把本机 run 的回写口一起挡死，agent 一开工就 501：

| 闸 | 覆盖 | 非 local 后端下 |
| --- | --- | --- |
| `assertLocalIssues` | Issue 列表 / 建 Issue | 501 指路（真源在对端） |
| `assertLocalIssue` | 单条 Issue 读写 | 只放行本机执行台账（external 标记的） |
| `assertLocalRun` | run 回写 / transcript / 权限确认 | 本机查得到这个 run 就放行 |

任务台（聚合镜像形态）的呈现：本机 run **不另开列表**，而是同一行打标记 + 详情里多一块——

- 列表行行尾一枚「本机 ACP」标记；
- 左栏多一个横切镜头「本机执行」（按执行者筛，不是任务状态的第五档），带计数；
- 详情页「本机执行」区块：agent 下拉 +「派给本机 agent」，已有本机 run 时直接嵌流式 transcript、
  权限确认与「中止」。**这块是外部 Runner 那条路给不了的**，也正是两条路值得分开呈现的原因；
- **来源卡的状态跟着本机 run 走**（completed → `done`，failed / aborted → `issued`）：
  这条 run 的生命周期归画板所有，就有义务让卡片别一直停在「执行中」。外部 Runner 那条路
  画板只是镜像，卡片上存的状态不归它推动，也就不去动。

---

## 5. 版本与兼容

- 接口刻意保持极小（4 动作 + 回写 2 条 + ACP 一组 4 条），只做加法演进；
- ACP 侧只依赖协议的稳定子集（initialize / session.new / session.prompt / session.cancel /
  session.update / session.request_permission），remote transport 落地后跨机派单再跟进。

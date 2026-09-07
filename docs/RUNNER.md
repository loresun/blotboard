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

## 4. ACP 派单（local 后端的第二种 launch 方式）

除了「生成 prompt 供复制」，local 后端还能**真拉起本机的 coding agent**：
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

> ⚠️ **注册表是高信任输入**。这里登记的命令由画板 `spawn` 起来，且
> **子进程继承画板进程的全部环境变量**（`{ ...process.env, ...agent.env }`）——
> 画板的内部 token、你 shell 里导出的任何 API key，agent 全看得见。
> 这是有意的（agent 常常真的需要 `PATH`、代理设置、自己那份 key 才跑得起来），
> 但代价是：**别注册来路不明的命令**。谁能改 `<data>/runner-settings.json`
> 或调 `PATCH /api/runner-settings`，谁就能在你的机器上以你的身份执行任意命令。
> 反过来说，把画板的写接口暴露到不可信网络之前，先想清楚这一条。

示例配置（`gemini --acp` 与 npm 包 `@zed-industries/claude-code-acp` 均已核实存在，
参数细节以各 agent 自己的文档为准；mock 条目的相对路径要求 cwd 配成画板仓库根）：

```jsonc
{ "agents": [
  { "id": "claude",  "name": "Claude Code", "command": "npx",
    "args": ["-y", "@zed-industries/claude-code-acp"], "cwd": "/path/to/your/repo" },
  { "id": "gemini",  "name": "Gemini CLI",  "command": "gemini", "args": ["--acp"] },
  { "id": "mock",    "name": "Mock（测试）", "command": "node",
    "args": ["scripts/mock-acp-agent.mjs", "--mode", "auto-finish"] }
] }
```

### 4.2 发起、进展、权限、中止

```
POST /api/issues/{issueId}/launch                       { "mode": "implement|analyze", "agentId": "claude" }
POST /api/boards/{bid}/cards/{cid}/launch               同上（卡片入口；远程后端下 agentId 被丢弃）
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
  一律标 `aborted` 并在日志与 transcript 里注明「服务重启，会话丢失」。

---

## 5. 版本与兼容

- 接口刻意保持极小（4 动作 + 回写 2 条 + ACP 一组 4 条），只做加法演进；
- ACP 侧只依赖协议的稳定子集（initialize / session.new / session.prompt / session.cancel /
  session.update / session.request_permission），remote transport 落地后跨机派单再跟进。

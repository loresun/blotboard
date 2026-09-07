---
title: 让 agent 接进来
summary: 三条门路：HTTP API、MCP、反过来派单
group: 和 agent 一起干活
order: 40
---

画板本体**不调任何大模型**。AI 能力全在你接进来的那个 agent 那边——画板只负责提供一块两边都能读能写的板。

## 从左上角 Agent 开始

[开始页](/start) 会按数据归属给出两种**完全不同**的提示词；[Agent 接入页](/agent) 则展开当前模式的完整操作：

1. 在画布空白处或左侧画板列表右键「复制给 Agent 的提示词」，带上当前画板 ID、深链、单板 API 和快速指南。粘贴后补充你的具体任务即可。
2. 在 Agent 页复制 Skill 安装提示词，交给 Codex、Claude Code 或支持 Skill 的客户端。也可以下载 `GET /api/skill?format=install` 返回的 `SKILL.md`，或展开手动安装命令。已有文件不会被命令覆盖。

安装文件带标准 `name` / `description` frontmatter，只保存本部署入口；每次任务重新读取 `/api/skill` 和 `/api/capabilities`，避免能力清单过期。安装和只读不需要凭据，改板仍需授权。

复制地址取自当前浏览器的部署地址。远程 Agent 访问 `127.0.0.1` 会连到它自己；请先用双方可达且受保护的部署地址打开接入页。剪贴板被浏览器禁用时，页面提示失败，可选中文本手动复制。

## 浏览器存储：只走 CDP 提示词

浏览器 workspace 不在 `/api/boards`，也不使用服务端 token 或 MCP。画布和左栏右键会显示「复制 CDP Agent 提示词」：Agent 必须通过 Playwright/CDP 接管目标标签页，调用 `window.blotboardBrowser`。

提示词包含精确的 origin、workspace 和可选画板 ID。它会要求 Agent 先核对 capabilities 和 workspace，再读板、`putBoard`、回读并检查画布。没有浏览器控制能力就应停下说明，不能直接改浏览器 profile 文件。

以下 HTTP、MCP、Skill 与 Runner 章节只适用于**服务端文件库**。

## 先拿到钥匙

读接口免鉴权，**写接口要 token**。首次启动会在数据目录下生成一个随机 `token` 文件，启动日志里也会提示。浏览器侧不用管：同源页面自带写权限。

服务默认只接受本机 / 私网 / Tailscale 直连，其余一律拒掉。

## 门路一：HTTP API + 自描述指南

任何能发请求的东西都能接。关键是这两个口：

- `GET /api/skill?format=md` —— **这台部署的完整 agent 指南**，按实际启用的卡片包、规格、任务后端现场拼装。装了什么就讲什么，说明书永远不会跟部署漂移
- `GET /api/capabilities` —— 机器可读的能力清单（整理模式、渲染边界、可用的分类值……）

指南很长，可以只要其中一类活：`?focus=cards,tasks`，合法值有 auth / api / cards / comments / specs / envelope / tasks / links / resources / pitfalls。
这十个值是**按活分**的，不是按功能分的：想「只改布局」没有同名的一类——整理口归在 `api` 那节，十一种模式的清单在 `/api/capabilities` 的 `layouts` 里。写了不认识的值会返回 400 并告诉你该去哪节。

日常改板的口子长这样：

```
GET    /api/boards                     板子清单
GET    /api/boards/{id}                整块板（卡片 + 连线 + 评论）
POST   /api/boards/{id}/cards          建卡
PATCH  /api/boards/{id}/cards/{cardId} 改卡
POST   /api/boards/{id}/edges          连线
POST   /api/boards/{id}/ingest         批量收卡片（信封）
POST   /api/boards/{id}/tidy           整理
GET    /api/boards/{id}/export         导出
```

写请求带上 `x-auth-key: <token>`。

## 门路二：MCP（agent 主动来改板）

自带一个 MCP server，在已检出的仓库运行 `npm link` 后，MCP 客户端使用 `blotboard mcp`。这些 `board_*` 工具覆盖日常改板的全部动作：列板 / 建板 / 加卡 / 改卡 / 删卡 / 连线 / 整理 / 评论 / 规格 / 收信封 / 快照 / 导出 / 转 Issue / 发起执行 / 看任务。

在仓库目录里跑会自动读本地 token；连远程或非默认端口时用环境变量指明。具体配置片段见项目根目录的 `README.md`。

## 门路三：反过来派单（画板 → agent）

任务台的「Runner 设置」里注册本机的 coding agent（按 Agent Client Protocol 说话的那些），任务卡带上 agent 发起执行，画板会拉起它的子进程，流式进展和权限确认回到任务台。协议细节见 `docs/RUNNER.md`。

## 顶栏那颗「Agent」

配了真的执行方时，顶栏右侧第三组会出现一颗紫色的「Agent」。它是**在当前这块板上**跟 agent 打交道的入口：把整块板或选中的卡交给 agent 去改 / 去补，也能直接编辑整块板的配置 JSON。没有执行方时（内置的 local 后端）这颗按钮不渲染——给不了的能力不该摆在那儿。

## 给 agent 交活的三种方式，按顺手程度排

1. **评论** —— 在卡片上钉一句「这里改成……」，agent 读未解决的评论、动手、回复、标解决。见 [评论即交活](/docs?doc=comments)
2. **任务卡** —— 要执行的事写成任务卡，转 Issue、发起。见 [任务与 Issue](/docs?doc=tasks)
3. **直接说** —— 在你的 agent 那边说「把 b_xxx 这块板整理一下」，它走 API 干活

板 ID 和卡片 ID 在左栏右键就能复制；地址栏里的 `?board=&card=` 也是可以直接发给 agent 的深链。

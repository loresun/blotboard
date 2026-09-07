# 存储入口与 Agent 交接设计

## 目标

给 Blotboard 增加一个独立的 `/start` 落地页。用户先理解并选择“服务端文件库”或“浏览器隔离 workspace”，再进入画板；同时把两种存储的 Agent 交接彻底分开，避免浏览器数据被错误地写进服务端 API。

## 信息架构

保留 `/` 为画板和全部既有深链入口，避免迁移存量链接、任务回传地址与自动化。`/start` 是可分享的产品入口，采用“两份数据世界”的双栏结构：服务端侧强调完整能力、数据目录和 HTTP/MCP；浏览器侧强调 origin + workspace 隔离、多个命名 workspace、导出与 CDP。两栏各自有一个主操作“进入画板”和一个次操作“复制给 Agent”，不让用户先进入画布再猜自己处于哪种存储。

服务端数据目录不以绝对路径下发。配置面板与落地页提供“在文件管理器中打开数据目录”链接，点击后调用同源写鉴权保护的本机 API，由服务端使用系统文件管理器打开 `DATA_DIR`；响应只说是否成功，不返回目录路径。这同时满足“可找到”与“绝对路径不进公共响应”的安全合同。

## 浏览器 workspace

IndexedDB 的 `workspaces` 元数据表成为 workspace 发现真源。页面可列出已有 workspace 的名字、板数和最近更新时间；输入一个新名字即可登记并进入。进入空 workspace 后由现有 BoardApp 创建第一块板。浏览器模式继续支持单板 JSON/PNG，以及全 workspace bundle 的备份和合并/替换恢复。

## 两套 Agent 提示词

服务端提示词保持 HTTP API、动态 Skill、token 和回读 API 的工作流。浏览器提示词不出现 Skill 安装、token 或 `/api/boards` 写入，明确要求 Agent 使用用户已授权的 Playwright/CDP 控制目标标签页，等待 `window.blotboardBrowser`，读取 capabilities/workspaces/boards，局部修改后 `putBoard`，再从 API 与可见 UI 双重回读。

没有浏览器控制能力的 Agent 必须说明做不到并请求用户换到支持 CDP 的会话，不能退回 shell 直接编辑浏览器 profile。提示词带精确 origin、workspace 和可选 board id，从源头避免改错库。


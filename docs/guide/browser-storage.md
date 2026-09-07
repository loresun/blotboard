---
title: 浏览器隔离存储
summary: 不建账号，画板只存在当前浏览器；备份、迁移与 Agent 控制怎么做
group: 带走与扩展
order: 45
---

从 [开始页](/start) 先选数据归属，或点顶栏画板名旁边的「**服务端 / 浏览器**」胶囊切换。

## 两个库互不串数据

- **服务端文件**：现有方式，一板一个 JSON 文件落在部署的数据目录。上传、任务台、Runner、自动快照、HTML/PDF 排版都可用。配置面板里的「在文件管理器中打开数据目录」能直接定位；网页不会显示绝对路径。
- **浏览器隔离**：画板进入当前站点 origin 下的 IndexedDB，不会发给 `/api/boards`。同一浏览器还可以用不同 workspace 再隔一层。

切换只改变“正在看的库”，不会迁移或删除另一边的数据。比如 `https://board.example.com` 与 `http://127.0.0.1:8567` 是两个 origin，即使 workspace 同名，也看不到彼此的数据。

## 多个命名 workspace

开始页和存储配置都会列出当前 origin 下已有的 workspace、板数与名字。输入新名字即可创建；workspace 名会写进地址栏，所以 Agent 提示词、刷新和新标签页都能落回同一份库。

页面 Agent API 对应提供 `listWorkspaces()` 与 `createWorkspace(name)`。创建 workspace 不复制旧数据；进入空 workspace 时会自动建立第一块画板。

## 先知道会失去什么

浏览器模式没有服务器文件目录，所以**不能在这里新上传文件**，也没有服务端连续历史/快照、任务 Issue/Runner、知识库/书库代理，以及服务端 HTML/PDF/Markdown 排版。普通卡片、连线、评论、整理、搜索、导航、JSON/PNG 导出都能用。

**导入进来的附件字节是留得住的**：从服务端库（或别人）那儿导一份带图的画板包 / 排版导出的 HTML 进来，图片、PDF、音视频的字节会跟着存进这个浏览器库——卡面照常显示图，刷新还在，再「备份整个浏览器库」时字节也原样带出去。这条路只解决「把已有的东西搬进来、再搬出去」；在这个模式里**新**上传一个文件仍然做不到（那需要服务端的上传目录）。字节确实没跟过来的时候（比如包里超了 24 MB 上限只留了引用），导入结果会明说缺了几个，不会假报完整成功。

清除站点数据、重置浏览器 profile 或某些隐私工具自动清理 IndexedDB，会把这些画板一起删掉。存储面板里的「**备份整个浏览器库**」会下载一份**画板包**（`.blotboard.json`，与服务端库同一种格式，两边可以互相导；超过 200 块板会自动分卷，几卷就下几个文件，**要全留着**）；「导入画板…」一律当新板收下，不动已有的板。旧版的浏览器备份文件照样能恢复。

「**从备份恢复…**」选好文件之后先给一份**影响摘要**（备份里有几块板、几块会覆盖同 id 的、几块是新增、本机有几块不在备份里），再由你三选一：**取消**（什么都不做，零写入）/ **合并恢复**（同 id 由备份覆盖，其余留着）/ **整库恢复**（回到备份那一刻，备份里没有的板一并删掉）。

## 本地 Agent 如何直接控制

普通 shell 进程不能安全地直接编辑 Chrome/Edge 的 IndexedDB 文件。正确入口是：让 Agent 通过你已经授权的 Playwright、CDP 或浏览器控制工具进入这个标签页，在页面上下文调用：

```js
const api = window.blotboardBrowser;
await api.capabilities();
const boards = await api.listBoards();
const board = await api.getBoard(boards[0].id);
board.cards.push({ /* 一张完整卡片 */ });
await api.putBoard(board);
```

还提供 `listWorkspaces`、`createWorkspace`、`deleteBoard`、`exportBundle(selection?)`、`importBundle(bundle, "merge" | "replace" | "copy")` 与 `subscribe(listener)`。`exportBundle` 出的是画板包（附件字节一并带上），`importBundle` 也认单块板 JSON、「排版导出」的 HTML 文本，以及直接存下来的 API 响应 `{"ok":true,"bundle":{…}}`（`copy` = 一律当新板收下）。`importBundle` 的返回值里带 `assets`（这次落库 / 复用 / 缺件各几个）与 `notes`——**缺件要如实转告用户**，别拿「已导入 N 块」盖过去。这个对象只在浏览器存储模式存在；写入仍走 IndexedDB 事务，并通知当前页面和同 workspace 的其他标签页刷新。

画布和左栏里的「复制给 Agent」在浏览器模式会自动变成「**复制 CDP Agent 提示词**」。这份提示词与服务端提示词完全不同：它带 workspace，要求核对 `storage=indexeddb`，并明确禁止调用 `/api/boards`。

这意味着 Agent 必须先获得**这个标签页**的控制权。项目不会额外开放 localhost HTTP 端口，也不会给所有本机进程一把绕过浏览器边界的钥匙。

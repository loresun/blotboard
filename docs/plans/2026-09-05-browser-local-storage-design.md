# 浏览器隔离存储设计

## 目标

在保留现有服务端文件存储的同时，增加一套用户可显式选择的浏览器本地工作区。浏览器模式的数据只进入当前站点 origin 下的 IndexedDB，不发送到 `/api/boards`；不同 workspace 彼此隔离。用户可以导出/恢复整个浏览器工作区，也可以让已经取得当前标签页控制权的本地 Agent 通过页面 API 操作同一份数据。

## 方案选择

采用“客户端画板数据源 + IndexedDB 仓库 + 页面 Agent API”。不让 Agent 直接读取 Chrome/Edge profile 文件：浏览器的 IndexedDB 文件格式、锁和加密均不是稳定接口，直接修改可能损坏 profile，也绕过了用户正在看的页面。也不新增公网中转或 localhost 常驻 WebSocket 服务：那会引入配对、端口、证书、CORS/PNA 和生命周期等额外攻击面。

浏览器模式通过 URL 中的 `storage=browser&workspace=<name>` 和本地偏好显式开启。核心前端 store 通过统一数据源访问服务器 API 或浏览器仓库。浏览器仓库按 `[workspace, boardId]` 存一板一记录，另存 workspace 元数据和顺序；事务只改当前板，避免每次写入重写整个库。服务端模式保持原路径和协议不变。

## 功能边界

浏览器模式支持板的增删改查、卡片/连线/评论、几何与视口保存、整理、搜索、导航、单板 JSON 和全库 bundle 备份恢复。IndexedDB 不适合承接当前上传目录、服务端快照、Issue/Runner、知识库/书库代理和服务端 HTML/PDF 排版，因此这些入口在浏览器模式隐藏或给出明确说明，而不是把请求错误地发往服务端文件库。

bundle 带格式版本、导出时间、workspace 与完整 boards；恢复默认合并，同 id 覆盖并保留未出现在 bundle 的本地板，另提供显式替换语义。导入先完整校验再开写事务，避免半套恢复。

## Agent 控制

页面在浏览器模式挂载 `window.blotboardBrowser`。它只存在于当前页面的 JavaScript 上下文，提供 `capabilities/listBoards/getBoard/putBoard/deleteBoard/exportBundle/importBundle/subscribe`。本地 Agent 必须通过用户已授权的浏览器控制通道（Playwright、CDP 或 Codex 浏览器工具）进入该标签页并执行页面 API；没有标签页控制权的普通 shell 进程不能读取浏览器数据。

写操作复用浏览器仓库校验与事务，并广播 `blotboard:browser-storage-changed` 事件，页面收到后刷新。这个边界既让 Agent 能直接工作，又不增加一个所有本机进程都可访问的 HTTP 数据口。

## 失败与恢复

IndexedDB 不可用、配额耗尽、私密窗口策略拒绝时，页面保留在当前模式并显示可操作错误，不静默切回服务端，避免数据写错库。切换存储前等待当前防抖写入完成并整页重载。浏览器模式持续显示“数据仅在此浏览器”的状态和备份入口；清站点数据会删除它，文档必须明确提示。

## 验收

纯逻辑单测覆盖 workspace 归一化、bundle 校验/合并、核心 mutation 和事件版本；Playwright 覆盖两个 workspace 隔离、刷新持久化、全库导出恢复、页面 Agent API 写入后 UI 可见，以及切回服务端不串库。最后运行仓库唯一提交门禁 `npm run check`，测试数量不得减少。

# Third-Party Notices

Blotboard 本体以 [MIT](LICENSE) 协议发布。运行时直接依赖如下（协议信息逐个取自
`node_modules/<pkg>/package.json`，版本为 lock 到的实际版本；各包的传递依赖见其各自的声明）：

| 依赖 | 版本 | 协议 | 用途 |
| --- | --- | --- | --- |
| [next](https://github.com/vercel/next.js) | 16.3.2 | MIT | 应用框架（App Router + 自定义 server） |
| [react](https://github.com/facebook/react) | 19.2.8 | MIT | UI 运行时 |
| [react-dom](https://github.com/facebook/react) | 19.2.8 | MIT | UI 渲染 |
| [@xyflow/react](https://github.com/xyflow/xyflow)（React Flow） | 12.11.3 | MIT | 画布：节点 / 连线 / 视口 |
| [@excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) | 0.18.1 | MIT | 自由画卡的编辑器（npm 依赖，非 fork；字体资产 postinstall 从包内同步，不进 git） |
| [mermaid](https://github.com/mermaid-js/mermaid) | 11.17.0 | MIT | 图表卡 / 数据图卡渲染 |
| [highlight.js](https://github.com/highlightjs/highlight.js) | 11.12.0 | BSD-3-Clause | 代码卡的语法高亮（浏览器侧按需 import：核心 + 用到的那一种语法，服务端导出不引） |
| [roughjs](https://github.com/rough-stuff/rough) | 4.6.6 | MIT | 手绘风格图形 |
| [@dagrejs/dagre](https://github.com/dagrejs/dagre) | 3.1.1 | MIT | 分层布局算法（整理 LR/TB） |
| [zustand](https://github.com/pmndrs/zustand) | 5.0.15 | MIT | 前端状态 |
| [marked](https://github.com/markedjs/marked) | 16.4.2 | MIT | 卡片正文 Markdown 渲染 |
| [lucide-react](https://github.com/lucide-icons/lucide) | 1.33.0 | ISC | 图标 |
| [html-to-image](https://github.com/bubkoo/html-to-image) | 1.11.13 | MIT | 画布导出 PNG |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | 1.30.0 | MIT | MCP server（本地安装后的 `blotboard mcp`） |

全部为 MIT / ISC / BSD-3-Clause，无传染性条款（BSD-3-Clause 要求保留版权声明与免责声明，highlight.js 的许可证文本随 npm 包分发，未作修改）。开发期依赖（TypeScript、Playwright、类型包）不随运行时分发，
清单见 `package.json` 的 `devDependencies`。

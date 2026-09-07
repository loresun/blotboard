### 自由画（excalidraw）

官方 Excalidraw 编辑器的手绘卡。`excalidraw.{source,thumbnail,updatedAt}`；`source` 是完整
.excalidraw JSON（可能几百 KB，写它走 4MB 的画布请求上限）。
主要由人双击全屏编辑；agent 要改就整份替换 source，`thumbnail` 可不给（卡面会现场渲）。

- `source` **字符串和对象都收**：`.excalidraw` 文件 JSON.parse 之后直接塞进来也行，
  服务端会自己序列化（老版本会存成 `"[object Object]"`，现在不会了）
- 落库前按白名单重拼一份：只留 `elements` / `appState` 的外观字段 / 图片 `files`，
  元素上的 `javascript:` 之类链接会被剥掉；超上限**报错不截断**（截一半的 JSON 就是一张打不开的画）
- **可以走信封导入**（`type: "excalidraw"` + `excalidraw: {source}`）：这份 JSON 自带全部内容，
  换台机器照样能完整重建

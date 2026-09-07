### 思维导图（mindmap）

最简导图。`mindmap.{root,layout,theme}`；节点是 `{id,text,children[],collapsed?}`（深度 ≤10、节点 ≤400）；
`layout` ∈ right（向右展开）/ both（左右分叉）；`theme` ∈ classic/pill/plain/card。

- **`root` 是整棵替换**：改树先读出现状再提交完整的树；PATCH 只传 `{mindmap:{layout:…}}` 不会动树
- MCP 工具侧有 `outline` 糖（缩进大纲转树），打 HTTP 就老实拼 root 节点树

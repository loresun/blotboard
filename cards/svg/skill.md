### SVG 图形（svg）

手绘 / 生成的 SVG。`svg.source` 存源码，卡面按 data URI 当图片渲染（脚本不执行）；
入库时 `script` 标签、`on*` 属性、`foreignObject` 会被剥掉——别依赖任何交互能力。
`source` 是整体替换，改图先读再写；只收**字符串**（一段 SVG 源码），传对象直接 400。

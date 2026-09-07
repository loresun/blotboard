### 数据图表（chart）

**要图但不想写语法就用它**——只给「什么图 + 什么数据」，卡片自己拼 mermaid 再渲染
（要亲手写 mermaid 语法请用 mermaid 卡）。`chart.{kind,title,…}`，四种 `kind`：

```jsonc
{"type":"chart","chart":{"kind":"bar","title":"季度收入","xLabel":"季度","yLabel":"万元",
  "labels":["Q1","Q2","Q3"],"series":[{"name":"收入","values":[120,138,155]}]}}
{"type":"chart","chart":{"kind":"line","labels":["1月","2月"],"series":[{"name":"访问","values":[320,410]}]}}
{"type":"chart","chart":{"kind":"pie","title":"来源","slices":[{"label":"搜索","value":33}]}}
{"type":"chart","chart":{"kind":"quadrant","axes":{"x":["影响小","影响大"],"y":["easy","hard"]},
  "quadrants":["马上做","排期","再说","顺手"],"points":[{"label":"方案A","x":0.7,"y":0.3}]}}
```

- **每种图只认自己那份数据键**：bar/line 用 `labels + series`，pie 用 `slices`，
  quadrant 用 `points/axes/quadrants`。给错键会 400 点名（不会静默画出一张空图）
- `series[].values` 的个数必须与 `labels` 一样多；数值必须是有限数字——
  **非法值一律 400，绝不兜底成 0**（一张悄悄画错的图比画不出来更糟）
- quadrant 的 `x/y` 是相对位置，取值 0~1；`quadrants` 四个名字按 mermaid 顺序：右上 / 左上 / 左下 / 右下
- 上限：一张图 ≤60 个数据点、≤6 条 series
- 不给数据也能建（空图表卡，之后再填）；`PATCH` 只传 `title` 不会动数据，
  但**换了 `kind` 就要重新给数据**（柱状图的 series 喂给饼图没有意义）
- ⚠️ mermaid 的 xychart 没有图例，多条 series 在图上分不出谁是谁——
  `series[].name` 只进导出与检索。要区分就一张卡一条线
- 导出：Markdown 给**生成好的 mermaid 代码块**（贴哪儿都能渲）；
  HTML 排版导出**有意降级成数据表** + 一行「图表在画板里查看」——服务端只会渲流程图，
  与其画错不如把数据一个不少地摆出来
- 可以走信封导入（自包含）；这个包**默认不启用**，先在卡片中心打开（或 `PATCH /api/card-packs`）

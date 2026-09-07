import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** 图表卡：填数据不写语法，前端自动翻成 mermaid 再渲染。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "chart",
  label: "数据图",
  fallbackTitle: "数据图表",
  icon: "chart",
  size: [420, 320],
  defaultW: 420,
  defaultH: 320,
  color: "blue",
  fieldKey: "chart",
  groupOrder: 17,
  // 自包含：一组数 + 图种，换台机器照样画得出来
  envelope: true,
  /**
   * 不进新装机默认集：相对小众（多数人贴表格 / 写 mermaid 就够了），
   * 而且服务端排版导出只能降级成数据表——先让用户在卡片中心按需打开，别默认摆上工具条。
   */
  defaultEnabled: false,
  searchParts: (card) => {
    const chart = card.chart;
    if (!chart) return [];
    return [
      chart.title,
      chart.xLabel,
      chart.yLabel,
      ...(chart.labels || []),
      ...(chart.series || []).map((series) => series.name),
      ...(chart.slices || []).map((slice) => slice.label),
      ...(chart.points || []).map((point) => point.label),
      ...(chart.quadrants || []),
    ];
  },
};

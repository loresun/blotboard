/** 图表卡的服务端归一化：数据校验从严，非法数据点名 400。 */
import { CHART_KINDS, type ChartField, type ChartKind, type ChartPoint, type ChartSeries, type ChartSlice } from "@/lib/types";
import { cleanText } from "@/lib/normalize-base";
import { badRequest } from "@/lib/http";
import type { CardPackSchema } from "@/lib/card-pack-types";
import { chartToMermaid } from "./source";

/** 一张图能装的数据量：再多就该是表格卡或一份报表，图上根本看不清 */
export const MAX_CHART_POINTS = 60;
export const MAX_CHART_SERIES = 6;
export const MAX_CHART_LABEL = 60;

/**
 * 数值闸门：**非法数字当场 400，不静默变成 0**。
 * 图表最怕的就是「悄悄画错」——一个 null 被兜底成 0，柱子矮了一截，
 * 看图的人完全没有办法察觉，比整张图渲不出来危险得多。
 */
function assertNumber(value: unknown, where: string): number {
  // 不能只靠 Number()：`Number(null)`、`Number("")`、`Number(false)` 都是 0，
  // 缺数据会被悄悄画成一根贴地的柱子——正是这里最要防的事
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  if (!Number.isFinite(numeric)) {
    throw badRequest(`${where} 必须是有限数字，收到 ${JSON.stringify(value)?.slice(0, 40)}（图表不给非法值兜底成 0，那会画出一张骗人的图）`);
  }
  return numeric;
}

function normalizeLabels(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw badRequest("chart.labels 必须是字符串数组（x 轴刻度）");
  if (input.length > MAX_CHART_POINTS) {
    throw badRequest(`chart.labels 最多 ${MAX_CHART_POINTS} 个刻度，收到 ${input.length} 个：再多图上就挤成一团了`);
  }
  return input.map((label) => cleanText(label, MAX_CHART_LABEL));
}

function normalizeSeries(input: unknown, labelCount: number): ChartSeries[] {
  if (!Array.isArray(input) || !input.length) {
    throw badRequest('chart.series 必须是非空数组：`[{"name":"收入","values":[120,138]}]`（完全不给 = 建一张空图表卡，之后再填）');
  }
  if (input.length > MAX_CHART_SERIES) {
    throw badRequest(`chart.series 最多 ${MAX_CHART_SERIES} 条，收到 ${input.length} 条`);
  }
  return input.map((raw, index) => {
    const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const values = source.values;
    if (!Array.isArray(values) || !values.length) {
      throw badRequest(`chart.series[${index}].values 必须是非空数字数组`);
    }
    if (values.length > MAX_CHART_POINTS) {
      throw badRequest(`chart.series[${index}].values 最多 ${MAX_CHART_POINTS} 个值，收到 ${values.length} 个`);
    }
    if (labelCount && values.length !== labelCount) {
      throw badRequest(
        `chart.series[${index}].values 有 ${values.length} 个值，chart.labels 有 ${labelCount} 个刻度：` +
          "一一对应才画得出来（数据缺就把对应的 label 一起去掉）",
      );
    }
    const series: ChartSeries = { values: values.map((value, at) => assertNumber(value, `chart.series[${index}].values[${at}]`)) };
    const name = cleanText(source.name, MAX_CHART_LABEL);
    if (name) series.name = name;
    return series;
  });
}

function normalizeSlices(input: unknown): ChartSlice[] {
  if (!Array.isArray(input) || !input.length) {
    throw badRequest('kind=pie 需要 chart.slices：`[{"label":"直接访问","value":42}]`');
  }
  if (input.length > MAX_CHART_POINTS) {
    throw badRequest(`chart.slices 最多 ${MAX_CHART_POINTS} 瓣，收到 ${input.length} 瓣`);
  }
  return input.map((raw, index) => {
    const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const label = cleanText(source.label, MAX_CHART_LABEL);
    if (!label) throw badRequest(`chart.slices[${index}].label 不能为空`);
    return { label, value: assertNumber(source.value, `chart.slices[${index}].value`) };
  });
}

function normalizePoints(input: unknown): ChartPoint[] {
  if (!Array.isArray(input) || !input.length) {
    throw badRequest('kind=quadrant 需要 chart.points：`[{"label":"方案A","x":0.7,"y":0.3}]`（x/y ∈ [0,1]）');
  }
  if (input.length > MAX_CHART_POINTS) {
    throw badRequest(`chart.points 最多 ${MAX_CHART_POINTS} 个点，收到 ${input.length} 个`);
  }
  return input.map((raw, index) => {
    const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const label = cleanText(source.label, MAX_CHART_LABEL);
    if (!label) throw badRequest(`chart.points[${index}].label 不能为空`);
    const x = assertNumber(source.x, `chart.points[${index}].x`);
    const y = assertNumber(source.y, `chart.points[${index}].y`);
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      throw badRequest(`chart.points[${index}] 的 x/y 要在 0~1 之间（四象限图是相对位置，不是绝对值），收到 (${x}, ${y})`);
    }
    return { label, x, y };
  });
}

function normalizeAxisPair(input: unknown, axis: "x" | "y"): [string, string] | undefined {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input) || input.length !== 2) {
    throw badRequest(`chart.axes.${axis} 要的是两端的文字：\`["低","高"]\``);
  }
  const pair: [string, string] = [cleanText(input[0], MAX_CHART_LABEL), cleanText(input[1], MAX_CHART_LABEL)];
  if (!pair[0] || !pair[1]) throw badRequest(`chart.axes.${axis} 两端的文字都不能为空`);
  return pair;
}

/**
 * 每种图只认自己那份数据键。
 *
 * 把 pie 的数据写进 `series` 是最容易犯的错（agent 见过的图表 API 大多只有 series），
 * 而静默忽略它的结果是一张空图 —— 调用方以为存进去了，打开画板才发现什么都没有。
 * 所以给错键当场点名，并说清楚这种图该用哪个键。
 */
const DATA_KEYS: Record<ChartKind, string[]> = {
  bar: ["labels", "series"],
  line: ["labels", "series"],
  pie: ["slices"],
  quadrant: ["points", "axes", "quadrants"],
};

function assertNoForeignData(input: Record<string, any>, kind: ChartKind): void {
  const mine = new Set(DATA_KEYS[kind]);
  for (const key of ["labels", "series", "slices", "points", "axes", "quadrants"]) {
    if (input[key] === undefined || input[key] === null || mine.has(key)) continue;
    throw badRequest(`kind=${kind} 用不到 chart.${key}：这种图要的是 ${DATA_KEYS[kind].map((one) => `chart.${one}`).join(" + ")}`);
  }
}

/**
 * 图表卡的归一化。
 *
 * **空图表是允许的**（工具条建的新卡就是空的，先落地再填，与 svg / mermaid / html 同一节奏）；
 * 但只要给了数据，就按最严的标准校验——非法值宁可 400，也不能画出一张骗人的图。
 */
export function normalizeChartField(input: Partial<ChartField> & Record<string, any> = {}, prev?: ChartField): ChartField {
  const rawKind = input.kind ?? prev?.kind ?? "bar";
  if (!(CHART_KINDS as readonly string[]).includes(String(rawKind))) {
    throw badRequest(`chart.kind「${String(rawKind).slice(0, 30)}」不支持——可选：${CHART_KINDS.join(" / ")}（bar/line 折柱图 · pie 饼图 · quadrant 四象限）`);
  }
  const kind = rawKind as ChartKind;
  assertNoForeignData(input, kind);
  const chart: ChartField = { kind };
  const title = cleanText(input.title !== undefined ? input.title : prev?.title, MAX_CHART_LABEL * 2);
  if (title) chart.title = title;
  /** 换了图种就不能再拿旧数据顶上：柱状图的 series 喂给饼图没有意义 */
  const sameKind = prev?.kind === kind;

  if (kind === "bar" || kind === "line") {
    const labels = input.labels !== undefined || !sameKind ? normalizeLabels(input.labels) : prev?.labels || [];
    const seriesInput = input.series !== undefined || !sameKind ? input.series : prev?.series;
    chart.labels = labels;
    if (seriesInput === undefined || seriesInput === null) {
      // 空图表：一个数都没给。给了 labels 却没给 series 是明显的半截数据，点名
      if (labels.length) throw badRequest("chart.labels 给了刻度却没有 chart.series：数据缺一半画不出来");
      chart.series = [];
    } else {
      chart.series = normalizeSeries(seriesInput, labels.length);
    }
    const xLabel = cleanText(input.xLabel !== undefined ? input.xLabel : prev?.xLabel, MAX_CHART_LABEL);
    const yLabel = cleanText(input.yLabel !== undefined ? input.yLabel : prev?.yLabel, MAX_CHART_LABEL);
    if (xLabel) chart.xLabel = xLabel;
    if (yLabel) chart.yLabel = yLabel;
    return chart;
  }

  if (kind === "pie") {
    const slices = input.slices !== undefined || !sameKind ? input.slices : prev?.slices;
    chart.slices = slices === undefined || slices === null ? [] : normalizeSlices(slices);
    return chart;
  }

  // quadrant
  const points = input.points !== undefined || !sameKind ? input.points : prev?.points;
  chart.points = points === undefined || points === null ? [] : normalizePoints(points);
  const axesInput = (input.axes !== undefined || !sameKind ? input.axes : prev?.axes) || {};
  const x = normalizeAxisPair(axesInput.x, "x");
  const y = normalizeAxisPair(axesInput.y, "y");
  if (x || y) chart.axes = { ...(x ? { x } : {}), ...(y ? { y } : {}) };
  const quadrantsInput = input.quadrants !== undefined || !sameKind ? input.quadrants : prev?.quadrants;
  if (quadrantsInput !== undefined && quadrantsInput !== null) {
    if (!Array.isArray(quadrantsInput) || quadrantsInput.length !== 4) {
      throw badRequest('chart.quadrants 要的是四个象限的名字，顺序按 mermaid：右上 / 左上 / 左下 / 右下，如 `["马上做","排期","再说","顺手"]`');
    }
    chart.quadrants = quadrantsInput.map((name) => cleanText(name, MAX_CHART_LABEL));
  }
  return chart;
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.chart = normalizeChartField(input.chart);
  },
  onConvert(card, patch) {
    // 互转不强制带数据（空图表合法，之后再填）；带了就按同一套严校验走
    card.chart = normalizeChartField(patch.chart || {}, card.chart);
  },
  onPatch(card, patch) {
    if (patch.chart !== undefined) card.chart = normalizeChartField(patch.chart, card.chart);
  },
  markdownLines(card) {
    const source = chartToMermaid(card.chart);
    if (!source) return [];
    // Markdown 导出给**生成好的 mermaid 源码**：贴进任何支持 mermaid 的地方都能直接渲染出来，
    // 比一张只有数字的表更接近「这张卡在画板上的样子」。
    // （HTML 排版导出走的是另一条路——数据表，理由见 cards/chart/export.ts）
    return ["", "```mermaid", source, "```"];
  },
};

/**
 * 图表字段 → mermaid 源码（零依赖，服务端 schema 与前端卡面共用同一份）。
 *
 * 这张卡的全部主张就在这个文件里：**agent 只给数据，语法我们来拼**。
 * mermaid 的 xychart-beta / quadrantChart 语法对空格、方括号、引号都很敏感，
 * 让模型现写十次错三次；而它手上本来就是一组数——那就只收数。
 *
 * 映射表（kind → mermaid 图种）：
 *  · bar      → xychart-beta 的 `bar [...]`
 *  · line     → xychart-beta 的 `line [...]`
 *  · pie      → pie
 *  · quadrant → quadrantChart
 */
import type { ChartField } from "@/lib/types";

/** mermaid 的字符串字面量用双引号包，里面的双引号只能去掉（它没有转义写法） */
function quote(text: string): string {
  return `"${String(text ?? "").replace(/"/g, "'").replace(/\n/g, " ")}"`;
}

function num(value: number): string {
  // 整数不带小数点，小数最多留 4 位：轴刻度上一串浮点尾巴既难看也没有信息量
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10000) / 10000);
}

function xyChart(chart: ChartField): string {
  const lines = ["xychart-beta"];
  if (chart.title) lines.push(`  title ${quote(chart.title)}`);
  const labels = chart.labels || [];
  if (labels.length) {
    lines.push(`  x-axis ${chart.xLabel ? `${quote(chart.xLabel)} ` : ""}[${labels.map(quote).join(", ")}]`);
  } else if (chart.xLabel) {
    lines.push(`  x-axis ${quote(chart.xLabel)}`);
  }
  if (chart.yLabel) lines.push(`  y-axis ${quote(chart.yLabel)}`);
  const keyword = chart.kind === "line" ? "line" : "bar";
  for (const series of chart.series || []) {
    lines.push(`  ${keyword} [${(series.values || []).map(num).join(", ")}]`);
  }
  return lines.join("\n");
}

function pieChart(chart: ChartField): string {
  const lines = [`pie${chart.title ? ` title ${chart.title.replace(/\n/g, " ")}` : ""}`];
  for (const slice of chart.slices || []) {
    lines.push(`  ${quote(slice.label)} : ${num(slice.value)}`);
  }
  return lines.join("\n");
}

function quadrantChart(chart: ChartField): string {
  const lines = ["quadrantChart"];
  if (chart.title) lines.push(`  title ${chart.title.replace(/\n/g, " ")}`);
  const x = chart.axes?.x;
  const y = chart.axes?.y;
  // 轴文字是 `低 --> 高` 这种「从…到…」，mermaid 这里不接受引号，只能写裸文本
  if (x) lines.push(`  x-axis ${x[0]} --> ${x[1]}`);
  if (y) lines.push(`  y-axis ${y[0]} --> ${y[1]}`);
  (chart.quadrants || []).forEach((name, index) => {
    if (name) lines.push(`  quadrant-${index + 1} ${name}`);
  });
  for (const point of chart.points || []) {
    lines.push(`  ${point.label}: [${num(point.x)}, ${num(point.y)}]`);
  }
  return lines.join("\n");
}

/** 字段 → 一段能直接交给 mermaid 的源码；数据不全时返回空串（调用方显示占位） */
export function chartToMermaid(chart?: ChartField | null): string {
  if (!chart) return "";
  switch (chart.kind) {
    case "bar":
    case "line":
      return (chart.series || []).some((series) => (series.values || []).length) ? xyChart(chart) : "";
    case "pie":
      return (chart.slices || []).length ? pieChart(chart) : "";
    case "quadrant":
      return (chart.points || []).length ? quadrantChart(chart) : "";
    default:
      return "";
  }
}

/**
 * 图表数据 → 表格（列 + 行），给「服务端导出画不出图」那条降级路用。
 * 放这里而不是 export.ts：前端「看数据」的入口以后也要用同一份口径。
 */
export function chartToGrid(chart?: ChartField | null): { columns: string[]; rows: string[][] } | null {
  if (!chart) return null;
  if (chart.kind === "pie") {
    const slices = chart.slices || [];
    if (!slices.length) return null;
    return { columns: ["名称", "数值"], rows: slices.map((slice) => [slice.label, num(slice.value)]) };
  }
  if (chart.kind === "quadrant") {
    const points = chart.points || [];
    if (!points.length) return null;
    return {
      columns: ["名称", chart.axes?.x ? `x（${chart.axes.x[0]}→${chart.axes.x[1]}）` : "x", chart.axes?.y ? `y（${chart.axes.y[0]}→${chart.axes.y[1]}）` : "y"],
      rows: points.map((point) => [point.label, num(point.x), num(point.y)]),
    };
  }
  const labels = chart.labels || [];
  const series = chart.series || [];
  if (!series.length) return null;
  const columns = [chart.xLabel || "", ...series.map((one, index) => one.name || `系列${index + 1}`)];
  const rows = labels.map((label, index) => [label, ...series.map((one) => (one.values?.[index] === undefined ? "" : num(one.values[index])))]);
  return { columns, rows };
}

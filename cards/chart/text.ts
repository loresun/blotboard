/**
 * 编辑抽屉里那个文本框的迷你写法（零依赖，只给前端用）。
 *
 * 为什么不在抽屉里放一个 JSON 框：图表卡整个的主张就是「不写语法」，
 * 结果编辑器却要人手打 JSON，那等于把赶走的复杂度从后门放回来。
 * 这套写法一眼能看懂、能整段粘、也能从现有数据反向生成（chartToText），
 * 于是「看到的」和「存下来的」永远对得上。
 *
 *   bar / line   第一行是 x 轴刻度（逗号分隔），之后每行一条系列 `名称: 1, 2, 3`
 *   pie          每行一瓣            `直接访问: 42`
 *   quadrant     每行一个点          `方案A: 0.7, 0.3`
 */
import { tr } from "@/lib/i18n/client";
import type { ChartField, ChartKind } from "@/lib/types";

export type ChartDraftData = Pick<ChartField, "labels" | "series" | "slices" | "points">;

export type ChartTextResult = { ok: true; data: ChartDraftData } | { ok: false; error: string };

const splitLines = (text: string) =>
  String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** `名称: 值` / `名称，值` 都收（中文逗号也认——中文输入法下最容易打出来的就是它） */
function splitHead(line: string): { head: string; tail: string } {
  const at = line.search(/[:：]/);
  if (at < 0) return { head: "", tail: line };
  return { head: line.slice(0, at).trim(), tail: line.slice(at + 1).trim() };
}

function splitValues(text: string): string[] {
  return text
    .split(/[,，]/)
    .map((one) => one.trim())
    .filter((one) => one !== "");
}

function toNumbers(parts: string[], where: string): number[] {
  return parts.map((part) => {
    const value = Number(part);
    if (!Number.isFinite(value)) throw new Error(tr("cards.chart.err.notNumber", { where, part }));
    return value;
  });
}

export function textToChartData(kind: ChartKind, text: string): ChartTextResult {
  const lines = splitLines(text);
  try {
    if (!lines.length) return { ok: true, data: {} };
    if (kind === "pie") {
      const slices = lines.map((line) => {
        const { head, tail } = splitHead(line);
        const parts = head ? [tail] : splitValues(line);
        const label = head || parts.slice(0, -1).join(",");
        const raw = head ? tail : parts[parts.length - 1];
        if (!label) throw new Error(tr("cards.chart.err.pieNoLabel", { line }));
        return { label, value: toNumbers([raw], tr("cards.chart.err.whereValues", { line }))[0] };
      });
      return { ok: true, data: { slices } };
    }
    if (kind === "quadrant") {
      const points = lines.map((line) => {
        const { head, tail } = splitHead(line);
        if (!head) throw new Error(tr("cards.chart.err.quadrantNoLabel", { line }));
        const values = toNumbers(splitValues(tail), tr("cards.chart.err.whereCoords", { line }));
        if (values.length !== 2) throw new Error(tr("cards.chart.err.quadrantCoordCount", { line, count: values.length }));
        return { label: head, x: values[0], y: values[1] };
      });
      return { ok: true, data: { points } };
    }
    // bar / line
    const labels = splitValues(lines[0]);
    const series = lines.slice(1).map((line) => {
      const { head, tail } = splitHead(line);
      const values = toNumbers(splitValues(head ? tail : line), tr("cards.chart.err.whereValues", { line }));
      return head ? { name: head, values } : { values };
    });
    if (!series.length) throw new Error(tr("cards.chart.err.noSeries"));
    for (const one of series) {
      if (one.values.length !== labels.length) {
        throw new Error(
          tr("cards.chart.err.seriesLength", {
            name: one.name || tr("cards.chart.err.unnamedSeries"),
            values: one.values.length,
            labels: labels.length,
          }),
        );
      }
    }
    return { ok: true, data: { labels, series } };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** 反向：现有数据 → 文本框里的样子（挂载初值、换卡重置都靠它） */
export function chartToText(chart?: ChartField | null): string {
  if (!chart) return "";
  if (chart.kind === "pie") return (chart.slices || []).map((slice) => `${slice.label}: ${slice.value}`).join("\n");
  if (chart.kind === "quadrant") return (chart.points || []).map((point) => `${point.label}: ${point.x}, ${point.y}`).join("\n");
  const series = chart.series || [];
  if (!series.length) return "";
  return [
    (chart.labels || []).join(", "),
    ...series.map((one, index) => `${one.name || `系列${index + 1}`}: ${(one.values || []).join(", ")}`),
  ].join("\n");
}

/* 种类名与示例数据搬进了 lib/i18n/dicts/cards.*（键 `cards.chart.kind.*` / `cards.chart.placeholder.*`）：
   两者都只在编辑抽屉里显示，是文案不是数据，跟着界面语言走。 */

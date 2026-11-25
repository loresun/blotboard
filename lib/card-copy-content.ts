/**
 * 提取卡片的可复制纯文本内容（面向用户粘贴到编辑器 / 聊天框 / 文档，而非 Blotboard 卡片 JSON）。
 *
 * 设计口径：
 *  - 代码卡只取源码 `code.source`，不包 Markdown 围栏，拿到就能直接粘进 IDE；
 *  - 文本 / 引用 / 链接 / 待办 / 表格 / 思维导图 / 图表 / SVG / Mermaid / HTML 各取最常用的纯文本表示；
 *  - 没有任何可提取正文时回退到标题；仍为空则返回空串，界面据此隐藏或禁用「复制内容」按钮。
 */
import type { BoardCard, MindNode } from "./types";

/**
 * 将思维导图节点树递归展开为缩进无序列表文本。
 *
 * @param node 当前节点
 * @param depth 当前缩进层级
 * @returns 行数组
 */
function flattenMindmap(node: MindNode | undefined, depth = 0): string[] {
  if (!node) return [];
  const label = (node.text || "").trim();
  const lines: string[] = [];
  if (label) {
    lines.push(`${"  ".repeat(depth)}- ${label}`);
  }
  for (const child of node.children || []) {
    lines.push(...flattenMindmap(child, label ? depth + 1 : depth));
  }
  return lines;
}

/**
 * 将表格卡的列定义和行数据序列化为干净的 Markdown 表格文本。
 *
 * @param card 表格卡片
 * @returns Markdown 表格字符串
 */
function formatTableText(card: BoardCard): string {
  const table = card.table;
  if (!table || !table.columns.length) return "";
  const escapeCell = (value: unknown) => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const header = `| ${table.columns.map((col) => escapeCell(col.label || col.key)).join(" | ")} |`;
  const divider = `| ${table.columns
    .map((col) => (col.align === "right" ? "---:" : col.align === "center" ? ":---:" : "---"))
    .join(" | ")} |`;
  const body = table.rows.map(
    (row) => `| ${table.columns.map((col) => escapeCell(row[col.key])).join(" | ")} |`,
  );
  const parts = [header, divider, ...body];
  if (table.caption?.trim()) parts.push("", table.caption.trim());
  return parts.join("\n");
}

/**
 * 将数据图表卡转成可读的键值摘要文本。
 *
 * @param card 图表卡片
 * @returns 文本摘要
 */
function formatChartText(card: BoardCard): string {
  const chart = card.chart;
  if (!chart) return "";
  const lines: string[] = [];
  if (chart.title?.trim()) lines.push(chart.title.trim());
  if (chart.kind === "pie" && chart.slices?.length) {
    for (const slice of chart.slices) lines.push(`${slice.label}: ${slice.value}`);
  } else if (chart.kind === "quadrant" && chart.points?.length) {
    for (const pt of chart.points) lines.push(`${pt.label}: (${pt.x}, ${pt.y})`);
  } else if (chart.labels?.length && chart.series?.length) {
    for (const series of chart.series) {
      const pairs = chart.labels.map((label, idx) => `${label}=${series.values[idx] ?? ""}`).join(", ");
      lines.push(series.name ? `${series.name}: ${pairs}` : pairs);
    }
  }
  return lines.join("\n");
}

/**
 * 提取任意卡片的纯文本内容用于一键复制。
 *
 * @param card 目标画板卡片
 * @returns 纯文本内容；若无可复制文本则返回空字符串
 */
export function extractCardCopyText(card: BoardCard): string {
  const content = (card.content || "").trim();
  const title = (card.title || "").trim();

  switch (card.type) {
    case "code":
      return card.code?.source || content || title;
    case "svg":
      return card.svg?.source || content || title;
    case "mermaid":
      return card.mermaid?.source || content || title;
    case "html":
      return [content, (card.html?.url || "").trim()].filter(Boolean).join("\n") || title;
    case "quote": {
      const parts = [content, card.quote?.source ? `— ${card.quote.source.trim()}` : ""].filter(Boolean);
      return parts.join("\n") || title;
    }
    case "link": {
      const url = (card.link?.url || "").trim();
      const parts = [content, url].filter(Boolean);
      return parts.join("\n") || title;
    }
    case "todo": {
      const items = (card.todo?.items || [])
        .map((item) => `- [${item.done ? "x" : " "}] ${item.text}`)
        .filter((line) => line.length > 6);
      const parts = [content, items.join("\n")].filter(Boolean);
      return parts.join("\n\n") || title;
    }
    case "table": {
      const md = formatTableText(card);
      return [md, content].filter(Boolean).join("\n\n") || title;
    }
    case "mindmap": {
      const lines = flattenMindmap(card.mindmap?.root);
      return lines.join("\n") || content || title;
    }
    case "chart": {
      const text = formatChartText(card);
      return [text, content].filter(Boolean).join("\n\n") || title;
    }
    case "data": {
      if (content) return content;
      const fields = card.data?.fields;
      if (fields && Object.keys(fields).length) {
        const lines = Object.entries(fields)
          .filter(([, value]) => value !== undefined && value !== null && value !== "")
          .map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
        if (lines.length) return lines.join("\n");
      }
      return title;
    }
    default:
      return content || title;
  }
}

/**
 * 判断卡片是否包含可一键复制的纯文本内容。
 *
 * @param card 目标画板卡片
 * @returns 是否存在非空可复制文本
 */
export function canCopyCardContent(card: BoardCard): boolean {
  return extractCardCopyText(card).trim().length > 0;
}

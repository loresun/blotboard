/** 导图卡的排版导出（自 lib/export-html.ts 机械拆入）：嵌套列表，不是画布。
    纸上不需要（也做不到）复刻画布上那棵横向树：它靠 DOM 量宽高再算缩放。
    缩进大纲反而更好读、能选能搜、还不会被分页切坏。 */
import { escapeHtml } from "@/lib/export-helpers";
import type { CardPackExport } from "@/lib/card-pack-types";
import type { MindNode } from "@/lib/types";

function renderMindNode(node: MindNode, depth: number): string {
  const children = node.children || [];
  return (
    `<li class="mm-node d${Math.min(depth, 4)}"><span>${escapeHtml(node.text || "")}</span>` +
    (children.length ? `<ul>${children.map((child) => renderMindNode(child, depth + 1)).join("")}</ul>` : "") +
    `</li>`
  );
}

export const exporter: CardPackExport = {
  html(card) {
    const root = card.mindmap?.root;
    if (!root) return `<p class="empty">这张导图还是空的</p>`;
    return `<ul class="mm">${renderMindNode(root, 0)}</ul>`;
  },
};

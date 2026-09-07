/** 分组框的 HTML 导出贡献：框本身没有正文，导出里给一行「这个框圈了几张卡」。 */
import type { CardPackExport } from "@/lib/card-pack-types";
import { escapeHtml } from "@/lib/export-helpers";

export const exporter: CardPackExport = {
  html(card, ctx) {
    // 成员从这次导出的卡片里现算：框里不存成员名单，真源是子卡的 frameId
    const members = ctx.cards.filter((item) => item.frameId === card.id);
    const names = members
      .slice(0, 12)
      .map((item) => `<li>${escapeHtml(item.title || item.type)}</li>`)
      .join("");
    return (
      `<p class="note">分组框${card.frame?.collapsed ? "（画布上已折叠）" : ""}：` +
      `圈了 ${members.length} 张卡片，各自的正文在下面它们所属的小节里。</p>` +
      (names ? `<ul class="frame-members">${names}${members.length > 12 ? "<li>…</li>" : ""}</ul>` : "")
    );
  },
};

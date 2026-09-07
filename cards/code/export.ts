/**
 * 代码卡的排版导出。
 *
 * **服务端不引高亮库**，这里只出 `<pre><code>` + 转义，理由有两条：
 *  ① 排版导出的产物是一个**自包含单文件 HTML**——用户会把它发出去、离线打开，
 *     里面不能有任何运行时依赖，而高亮要么带 JS 要么带一整套 CSS 主题；
 *  ② 高亮是「读起来舒服」，不是「内容本身」。为了它把导出体积翻一倍、
 *     还得在服务端维护第二套语言表，不划算。等宽 + 保留缩进已经能读。
 * 卡面与阅读模式的高亮在浏览器里做（cards/code/ui.tsx，按需 import）。
 */
import { escapeHtml, type ExportHtmlCtx } from "@/lib/export-helpers";
import type { CardPackExport } from "@/lib/card-pack-types";

export const exporter: CardPackExport = {
  html(card, _ctx: ExportHtmlCtx) {
    const code = card.code;
    if (!code?.source) return `<p class="empty">这张代码卡还没有内容</p>`;
    const kicker = [code.filename, code.language].filter(Boolean).join(" · ");
    return (
      (kicker ? `<p class="note">${escapeHtml(kicker)}</p>` : "") +
      `<pre class="code">${escapeHtml(code.source)}</pre>`
    );
  },
};

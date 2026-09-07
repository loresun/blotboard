
/**
 * 卡片正文的 Markdown 渲染。
 *
 * 画板上的长正文基本都是 Markdown 写的（人手打的交付清单、agent 回填的结构化笔记），
 * 以前卡面和阅读模式都按纯文本摊开，`#` `**` `1.` 全裸露在外面，读起来比不排版还差。
 *
 * **安全**：正文可能来自 agent / 外部导入的信封，所以原始 HTML 一律丢掉
 * （`renderer.html` 返回空串，块级和行内都拦），链接 / 图片地址过一遍协议白名单。
 * 这样输出里的标签全部是我们自己拼的，不需要再挂一层 DOMPurify。
 */
import { Marked } from "marked";

/** 允许出现在 href / src 上的协议：其余（javascript: / vbscript: …）一律降级成纯文本 */
const SAFE_URL = /^(?:https?:\/\/|mailto:|tel:|\/|#|\.{1,2}\/)/i;
const SAFE_IMG = /^(?:https?:\/\/|\/|\.{1,2}\/|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,)/i;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const marked = new Marked({ gfm: true, breaks: true });

marked.use({
  renderer: {
    html() {
      return "";
    },
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      if (!SAFE_URL.test(token.href || "")) return text;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
      return `<a href="${escapeHtml(token.href)}"${title} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
    image(token) {
      const alt = escapeHtml(token.text || "");
      if (!SAFE_IMG.test(token.href || "")) return alt;
      return `<img src="${escapeHtml(token.href)}" alt="${alt}" loading="lazy" />`;
    },
  },
});

/**
 * 渲染结果缓存。
 * 卡面每次拖动 / 选中都会重渲染，一屏几十张卡各解析一遍正文是纯浪费；
 * 正文本身就是 key，改一个字自然换一条缓存。上限只是防止长时间不刷新页面时无限涨。
 */
const CACHE_MAX = 300;
const cache = new Map<string, string>();

export function renderMarkdown(text: string): string {
  const source = text || "";
  const hit = cache.get(source);
  if (hit !== undefined) {
    // LRU：命中的挪到队尾，先被淘汰的永远是最久没用的
    cache.delete(source);
    cache.set(source, hit);
    return hit;
  }
  let html: string;
  try {
    html = marked.parse(source, { async: false });
  } catch {
    // 语法再离谱也不能把卡片渲染崩掉：退回纯文本
    html = `<p>${escapeHtml(source)}</p>`;
  }
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(source, html);
  return html;
}

/**
 * 这段文字值不值得当 Markdown 排版。
 *
 * 卡面上不能一律按 Markdown 渲染：随手记的一段大白话套上 `<p>` 之后，
 * 就用不了 -webkit-line-clamp 那套「按卡片高度算行数 + 末尾省略号」的截断，
 * 观感反而变差。所以只有真的写了标记的正文才切到 Markdown 那条路。
 */
export function looksLikeMarkdown(text: string): boolean {
  const source = (text || "").trim();
  if (!source) return false;
  return (
    /^#{1,6}\s+\S/m.test(source) || // 标题
    /^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/m.test(source) || // 列表 / 待办
    /^\s*>\s+\S/m.test(source) || // 引用
    /^\s*(?:```|~~~)/m.test(source) || // 代码块
    /^\s*(?:---|\*\*\*|___)\s*$/m.test(source) || // 分隔线
    /^\s*\|.+\|\s*$/m.test(source) || // 表格
    /\*\*[^*\n]+\*\*/.test(source) || // 加粗
    /`[^`\n]+`/.test(source) || // 行内代码
    /!?\[[^\]\n]*\]\([^)\s]+\)/.test(source) // 链接 / 图片
  );
}

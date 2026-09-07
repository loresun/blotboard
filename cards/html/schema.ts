/** 网页嵌入卡的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import { HTML_EMBED_MODES, type HtmlEmbedMode, type HtmlField } from "@/lib/types";
import { URL_RE, clampNumber, cleanText } from "@/lib/normalize-base";
import { badRequest } from "@/lib/http";
import { HTML_EMBED_RULES } from "@/lib/config";
import { describeAllowRules, hostAllowed } from "@/lib/embed-allow";
import type { CardPackSchema } from "@/lib/card-pack-types";

/** 被嵌页面的逻辑视口上限：再大就不是「一页」而是一整个网站了，卡面缩到看不清 */
export const MAX_EMBED_FRAME = 4000;

/**
 * HTML 嵌入卡：**只收 URL，不收 HTML 正文**。
 *
 * 这里是 iframe 那条路唯一的写入闸门，三件事按顺序做：
 * ① 只认 http(s)（`javascript:` / `data:text/html` 这类「点开就执行」的协议在 URL_RE 就被挡掉）；
 * ② host 过白名单（默认只放行本机 / 私网 / Tailscale，见 lib/embed-allow.ts），
 *    不过就 400 并把「现在允许哪些」写进报错——用户得知道该改配置还是改地址；
 * ③ host 冗余存一份，卡面页脚不用再解析一次 URL。
 *
 * 空 url 是允许的（required=false）：工具条建的新卡就是空的，先落地再填地址，
 * 跟 svg / mermaid 卡一个节奏。
 */
export function normalizeHtmlField(input: Partial<HtmlField> = {}, { required = false } = {}): HtmlField {
  const url = cleanText(input.url, 2048);
  const mode: HtmlEmbedMode = (HTML_EMBED_MODES as readonly string[]).includes(String(input.mode))
    ? (input.mode as HtmlEmbedMode)
    : "auto";
  // 0 = 铺满卡片（页面自己响应式）；给了尺寸就按它等比缩放，下限 100 免得除出个荒唐的比例。
  // 显式的 0（含字符串 "0"）要留住，缺省 / null 才走默认值——`Number(null)` 是 0，不能只看数值
  const frame = (value: unknown, fallback: number) =>
    value !== undefined && value !== null && Number(value) === 0 ? 0 : clampNumber(value, 100, MAX_EMBED_FRAME, fallback);
  const frameW = frame(input.frameW, 1280);
  const frameH = frame(input.frameH, 720);
  if (!url) {
    if (required) throw badRequest("网页嵌入卡需要一个 html.url（http(s) 地址）");
    return { url: "", host: "", mode, frameW, frameH };
  }
  if (!URL_RE.test(url)) throw badRequest("html.url 必须是合法 http(s) 链接");
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    throw badRequest("html.url 解析不出主机名");
  }
  if (!hostAllowed(host, HTML_EMBED_RULES)) {
    throw badRequest(
      `${host} 不在嵌入白名单里，这张卡会把它的脚本跑在你的浏览器里，所以只允许：${describeAllowRules(HTML_EMBED_RULES)}` +
        "（改 BLOTBOARD_HTML_ALLOW 可以加）",
    );
  }
  return { url, host, mode, frameW, frameH };
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.html = normalizeHtmlField(input.html);
  },
  onConvert(card, patch) {
    card.html = normalizeHtmlField(patch.html || card.html || {});
  },
  onPatch(card, patch) {
    // 合并而不是整体替换：抽屉里只改了 mode / 视口时，url 不该被清空
    if (patch.html !== undefined) card.html = normalizeHtmlField({ ...(card.html || {}), ...patch.html });
  },
  markdownLines(card) {
    if (!card.html?.url) return [];
    return [`- 嵌入网页：${card.html.url}`];
  },
};

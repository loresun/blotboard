/** SVG 卡的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import type { SvgField } from "@/lib/types";
import { MAX_DIAGRAM_SOURCE, codeSourceText } from "@/lib/normalize-base";
import type { CardPackSchema } from "@/lib/card-pack-types";

/**
 * SVG 源码。卡面是拿 data URI 当 <img> 渲染的——那个环境本来就不执行脚本，
 * 这里再剥一层（script / on* / javascript: / foreignObject）纯粹是纵深防御：
 * 画板里的 SVG 可能是 agent 生成的，也可能被用户从别处粘进来。
 *
 * source 给对象一律 400（codeSourceText）：`String(对象)` 会落 `"[object Object]"`，
 * 卡面变一块空白，调用方还以为存进去了。
 */
export function normalizeSvgField(svg: Partial<SvgField> = {}): SvgField {
  let source = codeSourceText(svg.source, "svg.source").slice(0, MAX_DIAGRAM_SOURCE);
  source = source
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, "");
  return { source: source.trim() };
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.svg = normalizeSvgField(input.svg);
  },
  onConvert(card, patch) {
    card.svg = normalizeSvgField(patch.svg || card.svg || {});
  },
  onPatch(card, patch) {
    if (patch.svg !== undefined) card.svg = normalizeSvgField(patch.svg);
  },
  markdownLines(card) {
    if (!card.svg?.source) return [];
    return ["", "```svg", card.svg.source, "```"];
  },
};

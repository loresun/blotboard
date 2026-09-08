/** SVG 卡的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import type { SvgField } from "@/lib/types";
import {
  MAX_DIAGRAM_SOURCE,
  assertSourceNotTopLevel,
  codeSourceText,
} from "@/lib/normalize-base";
import { badRequest } from "@/lib/http";
import type { CardPackSchema } from "@/lib/card-pack-types";

/**
 * SVG 源码。卡面是拿 data URI 当 <img> 渲染的——那个环境本来就不执行脚本，
 * 这里再剥一层（script / on* / javascript: / foreignObject）纯粹是纵深防御：
 * 画板里的 SVG 可能是 agent 生成的，也可能被用户从别处粘进来。
 *
 * source 给对象一律 400（codeSourceText）：`String(对象)` 会落 `"[object Object]"`，
 * 卡面变一块空白，调用方还以为存进去了。
 *
 * 超上限不截断而是 400（与 code / excalidraw 卡同一条口径）：截一半的 SVG 不是良构 XML，
 * 卡面直接裂图，服务端却什么也不说——与其静默存坏数据，不如让调用方当场知道。
 */
export function normalizeSvgField(svg: Partial<SvgField> = {}): SvgField {
  const raw = codeSourceText(svg.source, "svg.source");
  if (raw.length > MAX_DIAGRAM_SOURCE) {
    throw badRequest(
      `svg.source 太长了（${raw.length} 字符，上限 ${MAX_DIAGRAM_SOURCE}）：` +
        "一张卡装的是一张能一眼看完的图，整份大图请拆成几张卡，或者当附件传图片 / PDF",
    );
  }
  let source = raw;
  source = source
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, "");
  return { source: source.trim() };
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    assertSourceNotTopLevel(input, "svg", "svg");
    card.svg = normalizeSvgField(input.svg);
  },
  onConvert(card, patch) {
    assertSourceNotTopLevel(patch, "svg", "svg");
    card.svg = normalizeSvgField(patch.svg || card.svg || {});
  },
  onPatch(card, patch) {
    assertSourceNotTopLevel(patch, "svg", "svg");
    if (patch.svg !== undefined) card.svg = normalizeSvgField(patch.svg);
  },
  markdownLines(card) {
    if (!card.svg?.source) return [];
    return ["", "```svg", card.svg.source, "```"];
  },
};

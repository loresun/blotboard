import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/**
 * 源码进检索 haystack 的长度上限。
 * 写死在这里而不是引 normalize-base：meta.ts 是**前后端共用且零依赖**的文件，
 * normalize-base 引了 node:crypto，进不了浏览器 bundle。
 */
const MAX_SEARCH_SOURCE = 4000;

/** 代码卡：一段源码 + 语言标识，卡面等宽高亮，阅读模式带行号。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "code",
  label: "代码",
  fallbackTitle: "代码片段",
  icon: "code",
  size: [400, 300],
  defaultW: 400,
  defaultH: 300,
  color: "slate",
  fieldKey: "code",
  // 「按类型分区」的列序：接在既有 15 种之后（0–14 已占满），不重排老类型的既有版面
  groupOrder: 15,
  // 自包含：源码 + 语言 + 文件名，换台机器凭这封信就能完整重建
  envelope: true,
  // 通用高频类型（贴一段代码是任何画板都会做的事），进新装机默认集
  defaultEnabled: true,
  /**
   * 源码本身要搜得到（找「那段处理 retry 的代码在哪张卡上」是最常见的诉求），
   * 但一张卡最多 40k 源码，整块板拼进 haystack 会把搜索拖慢——截到前 4k，
   * 与「命中摘要只截命中处前后一小段」的口径一致。文件名与语言短，原样进。
   */
  searchParts: (card) => [card.code?.source?.slice(0, MAX_SEARCH_SOURCE), card.code?.filename, card.code?.language],
};

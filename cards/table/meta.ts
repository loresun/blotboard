import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/** 检索 haystack 里最多放多少个单元格：500×50 全塞进去会把整板搜索拖慢 */
const MAX_SEARCH_CELLS = 400;

/** 表格卡：行列数据，Markdown / CSV 都能直接塞。 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "table",
  label: "表格",
  fallbackTitle: "表格",
  icon: "table",
  size: [460, 300],
  defaultW: 460,
  defaultH: 300,
  color: "slate",
  fieldKey: "table",
  groupOrder: 16,
  // 自包含：表头 + 单元格就是全部内容
  envelope: true,
  // 通用高频类型（对比、清单、指标表），进新装机默认集
  defaultEnabled: true,
  /**
   * 表头与单元格都要搜得到（「哪张卡里提到过供应商 A」）。
   * 单元格截到前 400 个：一张 500×50 的表有两万五千格，整块板拼起来能到几百万字。
   */
  searchParts: (card) => {
    const table = card.table;
    if (!table) return [];
    const parts: string[] = [table.caption || "", ...(table.columns || []).map((column) => column.label)];
    let left = MAX_SEARCH_CELLS;
    for (const row of table.rows || []) {
      for (const column of table.columns || []) {
        if (left-- <= 0) return parts;
        const value = row[column.key];
        if (value) parts.push(value);
      }
    }
    return parts;
  },
};

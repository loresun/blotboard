/** 表格卡的服务端归一化：三种输入形态归一到一份 {columns, rows}。 */
import { TABLE_ALIGNS, type TableAlign, type TableColumn, type TableField } from "@/lib/types";
import { cleanText } from "@/lib/normalize-base";
import { badRequest } from "@/lib/http";
import type { CardPackSchema } from "@/lib/card-pack-types";
import { TableParseError, deriveKeys, parseCsvTable, parseMarkdownTable, tableToMarkdown, type ParsedGrid } from "./parse";

/** 编辑器（客户端）也要用它，真源在零依赖的 parse.ts，这里只作转发 */
export { tableToMarkdown };

/**
 * 行列上限。
 *
 * 卡片是「一眼看完」的东西，不是数据库：50 列宽已经超出任何一块屏幕，
 * 500 行滚起来也早就该换个工具了。超限**当场 400 并报实际数字**，
 * 不静默截断——表格被悄悄砍掉后半截，用户往往几天后才发现。
 */
export const MAX_TABLE_COLUMNS = 50;
export const MAX_TABLE_ROWS = 500;
/** 单元格是纯文本，长文本请写成正文或另开一张卡 */
export const MAX_TABLE_CELL = 2000;
export const MAX_TABLE_LABEL = 120;
export const MAX_TABLE_CAPTION = 300;

function assertSize(columns: number, rows: number): void {
  if (columns > MAX_TABLE_COLUMNS) {
    throw badRequest(`表格最多 ${MAX_TABLE_COLUMNS} 列，收到 ${columns} 列：列这么多的东西不适合放进一张卡片`);
  }
  if (rows > MAX_TABLE_ROWS) {
    throw badRequest(`表格最多 ${MAX_TABLE_ROWS} 行，收到 ${rows} 行：这么长的数据请拆成几张卡，或者当附件传`);
  }
}

function normalizeAlign(value: unknown): TableAlign | undefined {
  const align = String(value ?? "");
  return (TABLE_ALIGNS as readonly string[]).includes(align) ? (align as TableAlign) : undefined;
}

/** 解析出来的表格（markdown / csv 两条路共用的落地方式） */
function gridToField(grid: ParsedGrid): { columns: TableColumn[]; rows: Record<string, string>[] } {
  assertSize(grid.headers.length, grid.rows.length);
  const keys = deriveKeys(grid.headers);
  const columns: TableColumn[] = grid.headers.map((header, index) => {
    const column: TableColumn = { key: keys[index], label: cleanText(header, MAX_TABLE_LABEL) || keys[index] };
    const align = normalizeAlign(grid.aligns[index]);
    if (align) column.align = align;
    return column;
  });
  const rows = grid.rows.map((cells) => {
    const row: Record<string, string> = {};
    columns.forEach((column, index) => {
      row[column.key] = cleanText(cells[index] ?? "", MAX_TABLE_CELL);
    });
    return row;
  });
  return { columns, rows };
}

/** 结构化形态：columns + rows（行既可以是对象，也可以是按列顺序给的数组） */
function structuredToField(rawColumns: unknown, rawRows: unknown): { columns: TableColumn[]; rows: Record<string, string>[] } {
  if (!Array.isArray(rawColumns)) throw badRequest("table.columns 必须是数组：`[{key,label,align?}]`");
  const rowsInput = Array.isArray(rawRows) ? rawRows : [];
  assertSize(rawColumns.length, rowsInput.length);

  const used = new Set<string>();
  const columns: TableColumn[] = rawColumns.map((raw, index) => {
    const source = (raw && typeof raw === "object" ? raw : { label: raw }) as Record<string, unknown>;
    const label = cleanText(source.label ?? source.key ?? "", MAX_TABLE_LABEL);
    let key = cleanText(source.key ?? "", 60).replace(/[\s.]+/g, "_") || deriveKeys([label])[0] || `col${index + 1}`;
    // 列 key 是行对象的键，重了后面的会盖掉前面的一整列数据 —— 当场分开
    let seq = 2;
    const base = key;
    while (used.has(key)) key = `${base}_${seq++}`;
    used.add(key);
    const column: TableColumn = { key, label: label || key };
    const align = normalizeAlign(source.align);
    if (align) column.align = align;
    return column;
  });

  const rows = rowsInput.map((raw, rowIndex) => {
    const row: Record<string, string> = {};
    if (Array.isArray(raw)) {
      // 按列顺序给的一行：`["Q1", "120"]`，比逐个写 key 省事得多
      if (raw.length > columns.length) {
        throw badRequest(`table.rows 第 ${rowIndex + 1} 行有 ${raw.length} 个值，只有 ${columns.length} 列`);
      }
      columns.forEach((column, index) => {
        row[column.key] = cleanText(raw[index] ?? "", MAX_TABLE_CELL);
      });
      return row;
    }
    if (!raw || typeof raw !== "object") {
      throw badRequest(`table.rows 第 ${rowIndex + 1} 行要的是对象或数组，收到 ${JSON.stringify(raw)?.slice(0, 40)}`);
    }
    const record = raw as Record<string, unknown>;
    for (const column of columns) {
      const value = record[column.key];
      // 数字 / 布尔照收（agent 很自然会直接给数值），存的时候统一成文本
      row[column.key] = value === undefined || value === null ? "" : cleanText(value, MAX_TABLE_CELL);
    }
    return row;
  });
  return { columns, rows };
}

/**
 * 表格卡的归一化。
 *
 * 输入三选一（**同时给两种文本形态直接 400**：那必然是拼错了，
 * 而静默挑一个用会让另一份数据凭空消失）：
 *  ① `{columns, rows}` 结构化；② `{markdown: "…"}`；③ `{csv: "…"}`。
 * 三者都没给时保留 `prev` 的表格——这样 `PATCH {table:{caption:"x"}}` 只改标题。
 */
export function normalizeTableField(input: Partial<TableField> & Record<string, any> = {}, prev?: TableField): TableField {
  const hasMarkdown = typeof input.markdown === "string" && input.markdown.trim() !== "";
  const hasCsv = typeof input.csv === "string" && input.csv.trim() !== "";
  if (hasMarkdown && hasCsv) {
    throw badRequest("table 同时给了 markdown 和 csv：一次只能给一种输入形态（或者直接给 columns + rows）");
  }
  const hasStructured = input.columns !== undefined || input.rows !== undefined;
  if ((hasMarkdown || hasCsv) && hasStructured) {
    throw badRequest("table 同时给了文本形态（markdown / csv）和 columns/rows：只给一种，免得两份数据对不上");
  }

  let grid: { columns: TableColumn[]; rows: Record<string, string>[] };
  try {
    if (hasMarkdown) grid = gridToField(parseMarkdownTable(String(input.markdown)));
    else if (hasCsv) grid = gridToField(parseCsvTable(String(input.csv), typeof input.delimiter === "string" ? input.delimiter : undefined));
    else if (hasStructured) grid = structuredToField(input.columns ?? [], input.rows ?? []);
    else grid = { columns: prev?.columns || [], rows: prev?.rows || [] };
  } catch (err) {
    // 解析器抛的是纯错误对象（它零依赖，不认识 ApiError），在这里翻译成 400
    if (err instanceof TableParseError) throw badRequest(err.message);
    throw err;
  }

  const field: TableField = { columns: grid.columns, rows: grid.rows };
  const caption = cleanText(input.caption !== undefined ? input.caption : prev?.caption, MAX_TABLE_CAPTION);
  if (caption) field.caption = caption;
  return field;
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.table = normalizeTableField(input.table);
  },
  onConvert(card, patch) {
    card.table = normalizeTableField(patch.table || {}, card.table);
  },
  onPatch(card, patch) {
    // 合并：只改 caption 时不该把表格清空（与 html / code 同一节奏）
    if (patch.table !== undefined) card.table = normalizeTableField(patch.table, card.table);
  },
  markdownLines(card) {
    const table = card.table;
    if (!table?.columns?.length) return [];
    const lines = ["", tableToMarkdown(table)];
    if (table.caption) lines.push("", `*${table.caption}*`);
    return lines;
  },
};

/**
 * 表格的三种输入形态 → 统一的 {columns, rows}（零依赖，服务端 schema 与前端编辑器共用）。
 *
 * **这是表格卡的价值所在**：agent 手上的表格十有八九已经是一段 Markdown 或一段 CSV
 * （从文档里抄的、从接口导的、自己刚生成的）。如果只收 `{columns, rows}`，
 * 它就得先自己写一遍解析——而那正是最容易出错、最不该让每个调用方各写一遍的活。
 * 所以这里把三种形态都收下，并且**解析失败要点名**（第几行、多了几列），
 * 不许静默丢数据：表格丢一行没人看得出来，等发现时早就晚了。
 */

export interface ParsedGrid {
  headers: string[];
  /** 每行按表头顺序排好，缺的补空串 */
  rows: string[][];
  /** Markdown 表格的对齐（`:---:`）；CSV 没有 */
  aligns: (string | undefined)[];
}

export class TableParseError extends Error {}

function fail(message: string): never {
  throw new TableParseError(message);
}

/* ── Markdown 表格 ───────────────────────────────── */

/**
 * 拆一行 Markdown 表格。
 * 单元格里的 `|` 必须写成 `\|`（GFM 的规矩），所以按「不带反斜杠的竖线」切，
 * 切完再把 `\|` 还原成 `|`。
 */
function splitMarkdownRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (ch === "\\" && line[index + 1] === "|") {
      current += "|";
      index += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  // 首尾竖线是可选的：`| a | b |` 与 `a | b` 都算合法，前者切出来头尾各有一个空串
  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((cell) => cell.trim());
}

const MD_SEPARATOR_CELL = /^:?-{1,}:?$/;

function alignOf(cell: string): string | undefined {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return undefined;
}

export function parseMarkdownTable(text: string): ParsedGrid {
  const lines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length < 2) {
    fail("table.markdown 至少要有表头行和分隔行（`| 列 |` + `| --- |`），现在不足两行");
  }
  const headers = splitMarkdownRow(lines[0]);
  const separator = splitMarkdownRow(lines[1]);
  if (!separator.length || !separator.every((cell) => MD_SEPARATOR_CELL.test(cell))) {
    fail("table.markdown 的第 2 行必须是分隔行（`| --- | ---: |`），实际是：" + lines[1].slice(0, 60));
  }
  if (separator.length !== headers.length) {
    fail(`table.markdown 分隔行有 ${separator.length} 列，表头有 ${headers.length} 列，对不上`);
  }
  const rows: string[][] = [];
  for (let index = 2; index < lines.length; index += 1) {
    const cells = splitMarkdownRow(lines[index]);
    if (cells.length > headers.length) {
      fail(
        `table.markdown 第 ${index + 1} 行有 ${cells.length} 个单元格，表头只有 ${headers.length} 列：` +
          "单元格里的竖线要写成 `\\|`",
      );
    }
    // 少给的列补空串——手写表格漏掉末尾空列很常见，为这个整批打回去不值得
    rows.push(headers.map((_, column) => cells[column] ?? ""));
  }
  return { headers, rows, aligns: separator.map(alignOf) };
}

/* ── CSV / TSV ──────────────────────────────────── */

/** 分隔符自动判断：表头行里逗号和制表符谁多算谁（从表格软件里复制出来的是 TSV）。 */
function sniffDelimiter(text: string): string {
  const firstLine = text.split("\n", 1)[0] || "";
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const semicolons = (firstLine.match(/;/g) || []).length;
  if (tabs > commas && tabs >= semicolons) return "\t";
  if (semicolons > commas && semicolons > tabs) return ";";
  return ",";
}

/**
 * RFC 4180 那套：双引号包裹的字段里可以有分隔符、换行和 `""` 转义的引号。
 * 手写一个而不是拉个 csv 库进来——规则就这几条，而依赖是要长期背着的。
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const source = String(text || "").replace(/\r\n?/g, "\n");
  const sep = delimiter || sniffDelimiter(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let index = 0;

  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    // 整行都是空的（结尾多敲了个回车）不算一行
    if (row.some((value) => value !== "")) rows.push(row);
    row = [];
  };

  while (index < source.length) {
    const ch = source[index];
    if (quoted) {
      if (ch === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      cell += ch;
      index += 1;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      index += 1;
      continue;
    }
    if (ch === sep) {
      endCell();
      index += 1;
      continue;
    }
    if (ch === "\n") {
      endRow();
      index += 1;
      continue;
    }
    cell += ch;
    index += 1;
  }
  if (quoted) fail("table.csv 里有没闭合的双引号：字段里的引号要写成两个（`\"\"`）");
  endRow();
  return rows;
}

export function parseCsvTable(text: string, delimiter?: string): ParsedGrid {
  const rows = parseCsv(text, delimiter);
  if (!rows.length) fail("table.csv 是空的：第一行会被当成表头");
  const [headers, ...body] = rows;
  const width = headers.length;
  const normalized = body.map((cells, index) => {
    if (cells.length > width) {
      fail(
        `table.csv 第 ${index + 2} 行有 ${cells.length} 个字段，表头只有 ${width} 列：` +
          "带分隔符或换行的字段要用双引号包起来",
      );
    }
    return headers.map((_, column) => (cells[column] ?? "").trim());
  });
  return { headers: headers.map((header) => header.trim()), rows: normalized, aligns: headers.map(() => undefined) };
}

/* ── 反向：表格 → Markdown ───────────────────────── */

/** 一行 Markdown 表格：竖线转义、换行压成空格（表格行里放不下真换行） */
function markdownRow(cells: string[]): string {
  return `| ${cells.map((cell) => String(cell ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`;
}

const ALIGN_BAR: Record<string, string> = { left: ":---", center: ":---:", right: "---:" };

/**
 * 表格 → Markdown。导出、前端编辑器的回填都用这一份，
 * 于是「编辑器里看到的 Markdown」与「导出的 Markdown」永远是同一种写法。
 */
export function tableToMarkdown(table?: {
  columns?: { key: string; label: string; align?: string }[];
  rows?: Record<string, string>[];
} | null): string {
  const columns = table?.columns || [];
  if (!columns.length) return "";
  const lines = [
    markdownRow(columns.map((column) => column.label)),
    `| ${columns.map((column) => ALIGN_BAR[column.align || ""] || "---").join(" | ")} |`,
  ];
  for (const row of table?.rows || []) {
    lines.push(markdownRow(columns.map((column) => row[column.key] ?? "")));
  }
  return lines.join("\n");
}

/* ── 列 key ─────────────────────────────────────── */

/**
 * 表头文字 → 行对象的键。
 * 中文表头很常见，所以不做 ASCII slug（那会把「季度」整个抹掉），
 * 只去掉空白与点号（点号会让前端按路径取值的写法犯迷糊），重名加序号。
 */
export function deriveKeys(headers: string[]): string[] {
  const used = new Set<string>();
  return headers.map((header, index) => {
    const base = String(header || "").trim().replace(/[\s.]+/g, "_").slice(0, 60) || `col${index + 1}`;
    let key = base;
    let seq = 2;
    while (used.has(key)) key = `${base}_${seq++}`;
    used.add(key);
    return key;
  });
}

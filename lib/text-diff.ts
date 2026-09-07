/**
 * 行级差异（自写的 LCS，不引依赖）。
 *
 * 为什么是**行**而不是字：对比模式比的是「改稿前后」「方案 A/B」这种整段文字，
 * 一行就是一个自然的最小单位——按字比会把整段染成花的，反而看不出改了什么。
 *
 * 为什么自己写：diff 库都要拉一整个包进来，而这里需要的只有一个经典的 LCS 动态规划
 * （加一个「太长就退回逐行比」的护栏）。三十行的事情不值得多一个依赖。
 *
 * 纯计算、无 DOM。
 */

export type DiffKind = "same" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/**
 * LCS 表的规模上限（行数乘积）。
 *
 * 经典 LCS 是 O(n·m) 的时间与空间：两篇各 2000 行就是 400 万格。
 * 超过这个数就退回「逐行对齐」的粗比法——那种体量的文本本来也不适合并排读，
 * 与其卡住浏览器，不如给一个立刻出得来的近似结果。
 */
const MAX_CELLS = 1_500_000;

function splitLines(text: string): string[] {
  // 末尾换行不该多出一行空的（"a\n" 与 "a" 是同一份内容）
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
}

/** 超限时的粗比：逐行对齐，同则 same、不同则一删一增。 */
function coarseDiff(left: string[], right: string[]): { left: DiffLine[]; right: DiffLine[] } {
  const a: DiffLine[] = [];
  const b: DiffLine[] = [];
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < max; i += 1) {
    const l = left[i];
    const r = right[i];
    if (l !== undefined && r !== undefined && l === r) {
      a.push({ kind: "same", text: l });
      b.push({ kind: "same", text: r });
      continue;
    }
    if (l !== undefined) a.push({ kind: "del", text: l });
    if (r !== undefined) b.push({ kind: "add", text: r });
  }
  return { left: a, right: b };
}

/**
 * 比两段文本，返回**左右各一列**已标好类型的行。
 *
 * 左列只出现 same / del（原文里有的），右列只出现 same / add（新稿里有的）——
 * 并排读的时候，两列各自还是一篇完整的文章，不会被对方的行插得七零八落。
 */
export function diffLines(leftText: string, rightText: string): { left: DiffLine[]; right: DiffLine[]; changed: number } {
  const left = splitLines(leftText);
  const right = splitLines(rightText);

  if (left.length * right.length > MAX_CELLS) {
    const coarse = coarseDiff(left, right);
    return { ...coarse, changed: coarse.left.filter((line) => line.kind !== "same").length + coarse.right.filter((line) => line.kind !== "same").length };
  }

  /* LCS 长度表：table[i][j] = left[i..] 与 right[j..] 的最长公共子序列长度。
     从后往前填，回溯时就能顺着 i/j 递增地吐出结果，不用再反转一次。 */
  const rows = left.length;
  const cols = right.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const outLeft: DiffLine[] = [];
  const outRight: DiffLine[] = [];
  let changed = 0;
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (left[i] === right[j]) {
      outLeft.push({ kind: "same", text: left[i] });
      outRight.push({ kind: "same", text: right[j] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      outLeft.push({ kind: "del", text: left[i] });
      changed += 1;
      i += 1;
    } else {
      outRight.push({ kind: "add", text: right[j] });
      changed += 1;
      j += 1;
    }
  }
  for (; i < rows; i += 1) {
    outLeft.push({ kind: "del", text: left[i] });
    changed += 1;
  }
  for (; j < cols; j += 1) {
    outRight.push({ kind: "add", text: right[j] });
    changed += 1;
  }
  return { left: outLeft, right: outRight, changed };
}

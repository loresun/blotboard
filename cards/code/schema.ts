/** 代码卡的服务端归一化。 */
import type { CodeField } from "@/lib/types";
import { MAX_DIAGRAM_SOURCE, cleanText, codeSourceText } from "@/lib/normalize-base";
import { badRequest } from "@/lib/http";
import { CODE_LANGUAGE_RE } from "./languages";
import type { CardPackSchema } from "@/lib/card-pack-types";

/**
 * 源码上限跟 svg / mermaid 同一档（40k）。
 * 一张卡装的是**一段能一眼看完的代码**，不是一个仓库——真要整个文件，
 * 那是 pdf / 附件的活；而 40k 已经能装下一千行左右，够贴一个模块了。
 */
export const MAX_CODE_SOURCE = MAX_DIAGRAM_SOURCE;
/** 文件名只作展示，给足空间放路径（`packages/web/src/lib/store.ts`） */
export const MAX_CODE_FILENAME = 200;

/**
 * language 的校验刻意只查**形状**不查取值（理由见 languages.ts 的抬头）：
 * 表里没有的语言照存照显示，只是不高亮。这里 400 的是「明显写错」——
 * 传了对象、把整段代码塞进 language、或者写了一句话。
 */
function normalizeLanguage(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "object") {
    throw badRequest("code.language 要的是一个短语言标识（如 ts / python / bash），收到的是对象");
  }
  const language = String(value).trim().toLowerCase();
  if (!language) return "";
  if (!CODE_LANGUAGE_RE.test(language)) {
    throw badRequest(
      `code.language「${language.slice(0, 40)}」不像语言标识：要的是 ts / python / bash 这样的短名` +
        "（小写、≤20 字符、只含字母数字与 + # . _ -）。不填就是纯文本，也是合法的",
    );
  }
  return language;
}

export function normalizeCodeField(code: Partial<CodeField> = {}): CodeField {
  // source 是「给别的语言看的源码」：给对象没有合理解释，当场 400 点名（与 mermaid / svg 同一条路）
  const raw = codeSourceText(code.source, "code.source");
  if (raw.length > MAX_CODE_SOURCE) {
    throw badRequest(
      `code.source 太长了（${raw.length} 字符，上限 ${MAX_CODE_SOURCE}）：` +
        "一张代码卡装的是一段能一眼看完的代码，整份文件请拆成几张卡，或者当附件传 PDF/文件卡",
    );
  }
  const field: CodeField = {
    // **不 trim 行内空白**：缩进是代码的一部分。只去掉首尾的空行（粘贴时常带）
    source: raw.replace(/^\n+/, "").replace(/\s+$/, ""),
    language: normalizeLanguage(code.language),
  };
  const filename = cleanText(code.filename, MAX_CODE_FILENAME);
  if (filename) field.filename = filename;
  return field;
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.code = normalizeCodeField(input.code);
  },
  onConvert(card, patch) {
    card.code = normalizeCodeField(patch.code || card.code || {});
  },
  onPatch(card, patch) {
    // 合并而不是整体替换：抽屉里只改了语言 / 文件名时，源码不该被清空（与 html 卡同一节奏）
    if (patch.code !== undefined) card.code = normalizeCodeField({ ...(card.code || {}), ...patch.code });
  },
  markdownLines(card) {
    const code = card.code;
    if (!code?.source) return [];
    const lines: string[] = [];
    if (code.filename) lines.push(`- 文件：\`${code.filename}\``);
    /**
     * 围栏长度按内容现算：源码里本来就有 ``` 的时候（贴的是一段 markdown / 文档），
     * 固定三个反引号会把代码块从中间截断，后半段漏到正文里。
     */
    const longest = (code.source.match(/`{3,}/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
    const fence = "`".repeat(Math.max(3, longest + 1));
    lines.push("", `${fence}${code.language}`, code.source, fence);
    return lines;
  },
};

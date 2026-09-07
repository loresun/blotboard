/**
 * 帮助文档（`/docs` 页与 `GET /api/docs`）：**一个目录一份真源**。
 *
 * 内容全在 `docs/guide/*.md` —— 一份 md 就是一页，页面的标题 / 摘要 / 归到哪一组 / 排第几
 * 全写在文件抬头的 frontmatter 里。加一页帮助 = 往那个目录里放一个 .md，**代码一行不用改**，
 * 页面与接口自动跟上（后面要补「画板模式」那一整组，就是往里放几份 md 的事）。
 *
 * 为什么不做成画板上的卡片：帮助得跟着代码一起走——同一个 commit 改功能、改文档，
 * 换台机器 clone 下来也是同一套说明。卡片是用户数据，会被改被删，不适合当说明书。
 *
 * 读取方式与 skill 片段（lib/skill.ts）、模板、规格一致：**运行时读文件**，不进构建产物。
 * 改一句话不用 rebuild，`npm run dev` 下刷新即见。文档这口一天被打不了几次，不做缓存。
 */
import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./config";
import { DEFAULT_LOCALE, type Locale } from "./i18n";

export const DOCS_DIR = path.join(PROJECT_ROOT, "docs", "guide");

/**
 * 译文放在 `docs/guide/<locale>/`，文件名（= slug）与中文那份一一对应。
 *
 * 中文是原稿也是兜底：某一页还没译，就**按页**退回中文，而不是整站退回——
 * 译到哪儿用到哪儿，不必等 21 页齐了才敢上线。加一种语言 = 多一个目录。
 */
function localeDir(locale: Locale): string {
  return locale === DEFAULT_LOCALE ? DOCS_DIR : path.join(DOCS_DIR, locale);
}

/** 文件名即 slug，也是 URL 上的 `?doc=`：限死小写字母 / 数字 / 连字符，顺手挡掉路径穿越 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface DocMeta {
  slug: string;
  title: string;
  /** 目录里那行小字：这一页回答什么问题 */
  summary: string;
  /** 归到哪一组（目录里的小标题）；frontmatter 里没写就进「其他」 */
  group: string;
  /**
   * 全局序号（不是组内序号）。排序按它，组的先后 = 组内最小序号的先后——
   * 加一页只要挑个数字，不用回来维护一张组顺序表。
   */
  order: number;
  /** 正文首段的纯文本摘录，给搜索用（目录里的关键词匹配要能命中正文） */
  excerpt: string;
}

export interface DocEntry extends DocMeta {
  /** 去掉 frontmatter 之后的 Markdown 正文 */
  body: string;
}

export interface DocGroup {
  name: string;
  docs: DocMeta[];
}

/**
 * 极简 frontmatter：只认「文件开头的 `---` 到下一行 `---`」，值一律当字符串（`order` 转数字）。
 * 不引 YAML 依赖——这里的键值就四五个，引一整个解析器不划算，而且 md 是我们自己写的。
 */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
    if (key) data[key] = value;
  }
  return { data, body: raw.slice(match[0].length) };
}

/** 正文首段（跳过标题 / 引用 / 列表标记）压成一行纯文本，给目录搜索当干草堆 */
function firstParagraph(body: string): string {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block
      .replace(/^#{1,6}\s+.*$/gm, "")
      .replace(/[*_`>#|-]/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 12) return text.slice(0, 160);
  }
  return "";
}

function readDoc(slug: string, locale: Locale = DEFAULT_LOCALE): DocEntry | null {
  if (!SLUG_RE.test(slug)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(localeDir(locale), `${slug}.md`), "utf8");
  } catch {
    // 这一页还没译：退回中文原稿，读者看到的是「有内容但是中文」，不是 404
    if (locale === DEFAULT_LOCALE) return null;
    try {
      raw = fs.readFileSync(path.join(DOCS_DIR, `${slug}.md`), "utf8");
    } catch {
      return null;
    }
  }
  const { data, body } = parseFrontmatter(raw);
  const order = Number(data.order);
  return {
    slug,
    // frontmatter 没写标题就退回正文第一个 # 标题，再退回 slug——目录里永远有个能点的名字
    title: data.title || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || slug,
    summary: data.summary || "",
    group: data.group || "其他",
    order: Number.isFinite(order) ? order : 9999,
    excerpt: firstParagraph(body),
    body,
  };
}

/**
 * 目录里所有 .md，按 order 排好。
 *
 * 页的**清单**永远以中文目录为准：译文目录里多出来的文件不会凭空造出一页，
 * 少了的那几页也照样在目录里（正文按页退回中文）——两边的页数与顺序永远一致。
 */
export function listDocEntries(locale: Locale = DEFAULT_LOCALE): DocEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(DOCS_DIR);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .map((name) => readDoc(name.slice(0, -3), locale))
    .filter((doc): doc is DocEntry => Boolean(doc))
    .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

/** 目录（不含正文）：组的先后 = 组内最小序号的先后，也就是「按 order 排完之后第一次出现的顺序」 */
export function listDocs(locale: Locale = DEFAULT_LOCALE): { total: number; groups: DocGroup[] } {
  const groups: DocGroup[] = [];
  const byName = new Map<string, DocGroup>();
  let total = 0;
  for (const { body: _body, ...meta } of listDocEntries(locale)) {
    total += 1;
    let group = byName.get(meta.group);
    if (!group) {
      group = { name: meta.group, docs: [] };
      byName.set(meta.group, group);
      groups.push(group);
    }
    group.docs.push(meta);
  }
  return { total, groups };
}

/** 单页正文；slug 不合法 / 文件不在都返回 null（路由据此给 404） */
export function getDoc(slug: string, locale: Locale = DEFAULT_LOCALE): DocEntry | null {
  return readDoc(slug, locale);
}

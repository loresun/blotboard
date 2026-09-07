/**
 * 界面语言：**服务端渲染那一遍就定下来**，前端不再二次猜。
 *
 * 真源是浏览器里的一个 cookie（`blotboard.locale`）：根布局在服务端读它，写进
 * `<html lang>` 与 `<body data-locale>`，再经 LocaleProvider 交给客户端组件。
 * 选 cookie 而不是 localStorage，就为了**服务端那一遍也是对的语言**——否则英文用户
 * 每次进页面都要先闪一下中文（features 那套 dataset 是服务端配置，天然只有一份；
 * 语言是每个浏览器各选各的，不能照抄）。
 *
 * 字典**按界面区域拆成多份**（dicts/*.zh.ts + 同名 .en.ts）：一份文件对应一摊组件，
 * 几个人同时补翻译不会撞在同一个文件上。`zh` 那份是唯一的键源，`en` 那份用
 * `Record<keyof typeof xxxZh, string>` 钉死——漏译一条 typecheck 当场红，
 * 不用等用户看见空白。
 */
import { CARD_META_BY_TYPE } from "../card-metas";
import type { CardType } from "../types";
import { chromeZh } from "./dicts/chrome.zh";
import { chromeEn } from "./dicts/chrome.en";
import { sidebarZh } from "./dicts/sidebar.zh";
import { sidebarEn } from "./dicts/sidebar.en";
import { panelsZh } from "./dicts/panels.zh";
import { panelsEn } from "./dicts/panels.en";
import { cardsZh } from "./dicts/cards.zh";
import { cardsEn } from "./dicts/cards.en";
import { pagesZh } from "./dicts/pages.zh";
import { pagesEn } from "./dicts/pages.en";
import { canvasZh } from "./dicts/canvas.zh";
import { canvasEn } from "./dicts/canvas.en";

export const LOCALES = ["zh", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** 默认中文：这个项目的第一批用户、全部既有截图与文档都是中文的。 */
export const DEFAULT_LOCALE: Locale = "zh";

/** 语言自己的名字用自己的语言写——切换菜单里「English」比「英文」更容易被认出来。 */
export const LOCALE_LABEL: Record<Locale, string> = { zh: "中文", en: "English" };

/** `<html lang>` 的值：给屏幕阅读器与浏览器翻译用，不是给我们自己解析的。 */
export const LOCALE_HTML_LANG: Record<Locale, string> = { zh: "zh-CN", en: "en" };

export const LOCALE_COOKIE = "blotboard.locale";
/** 一年：语言是长期偏好，不该因为几天没来就被重置。 */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const zh = { ...chromeZh, ...sidebarZh, ...panelsZh, ...cardsZh, ...pagesZh, ...canvasZh };
const en: Record<keyof typeof zh, string> = { ...chromeEn, ...sidebarEn, ...panelsEn, ...cardsEn, ...pagesEn, ...canvasEn };

export type DictKey = keyof typeof zh;

const DICTS: Record<Locale, Record<DictKey, string>> = { zh, en };

/**
 * 这个键在字典里有没有。
 *
 * 卡片包的工具条文案（`CardToolbarSpec.title` / `label`）类型仍是普通字符串——那是**卡片包
 * 的公开 API**，第三方包塞一句自己的中文/英文就该能跑，不该逼它先学 i18n。所以内置包的译文
 * 按约定停在 `cards.<type>.toolbar`，工具条渲染时先问一句「有没有这条」：有就用译文，
 * 没有就照原样显示包自己给的那句。
 */
export function hasDictKey(key: string): key is DictKey {
  return key in zh;
}

/** 认不出来的值一律回落默认语言：cookie 是用户可改的，别让一个手写的怪值把页面搞崩。 */
export function parseLocale(raw: string | null | undefined): Locale {
  return (LOCALES as readonly string[]).includes(raw || "") ? (raw as Locale) : DEFAULT_LOCALE;
}

/**
 * 浏览器语言 → 本服务支持的语言。只在**用户还没选过**时用一次（cookie 为空）；
 * 选过之后一律听用户的——自动识别再准也不该覆盖人明确点过的选择。
 */
export function preferredLocale(acceptLanguage: string | null | undefined): Locale {
  for (const raw of (acceptLanguage || "").split(",")) {
    const tag = raw.toLowerCase().split(";")[0].trim();
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return DEFAULT_LOCALE;
}

/**
 * 取一条文案，`{name}` 形式的占位符按 vars 替换。
 *
 * 键不存在时返回键本身而不是空串：界面上看到 `topbar.export` 这种字样一眼就知道漏了翻译，
 * 比默默显示一片空白好查得多。
 */
export function t(locale: Locale, key: DictKey, vars?: Record<string, string | number>): string {
  const dict = DICTS[locale] || DICTS[DEFAULT_LOCALE];
  const raw = dict[key] ?? DICTS[DEFAULT_LOCALE][key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/**
 * 卡片类型的显示名。中文那份仍旧来自卡片包自己的 `meta.label`（服务端导出、信封、
 * 既有断言都吃它），英文走字典——卡片包目录里不塞第二种语言，加一种卡片时不必先学 i18n。
 */
export function cardLabel(locale: Locale, type: CardType): string {
  const fallback = CARD_META_BY_TYPE[type]?.label || type;
  if (locale === DEFAULT_LOCALE) return fallback;
  return (DICTS[locale] as Record<string, string>)[`card.${type}`] ?? fallback;
}

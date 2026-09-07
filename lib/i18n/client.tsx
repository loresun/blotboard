"use client";

/**
 * 语言的前端读法：根布局在服务端读 cookie，把结果同时写进 `<body data-locale>`
 * 和这个 Provider 的初值——所以**服务端与水合后的第一帧是同一种语言**，不闪。
 *
 * 为什么不用 useSyncExternalStore（features 那套的做法）：那套的真源在服务端配置，
 * 服务端快照恒定；语言是用户偏好，服务端每次请求都可能不同，必须由上往下传。
 *
 * 切换语言不做整页刷新：cookie 写好、state 一改，React 自己把界面重画一遍。
 * 只有帮助文档那类**服务端按语言拼好的正文**需要重新取，那由各自的页面自己感知 locale。
 */
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_HTML_LANG,
  parseLocale,
  t as translate,
  cardLabel as cardLabelOf,
  type DictKey,
  type Locale,
} from "./index";
import type { CardType } from "../types";

interface LocaleContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue>({ locale: DEFAULT_LOCALE, setLocale: () => {} });

export function LocaleProvider({ initial, children }: { initial: Locale; children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initial);
  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    // path=/ 才能让 /docs、/tasks 这些页面也认同一份选择；SameSite=Lax 足够，这是纯偏好
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
    document.documentElement.lang = LOCALE_HTML_LANG[next];
    // dataset 是给非组件代码（事件回调里的 toast）读的，跟着一起改
    document.body.dataset.locale = next;
  }, []);
  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

/** 渲染期取文案：`const t = useT(); t("topbar.export")`。 */
export function useT(): (key: DictKey, vars?: Record<string, string | number>) => string {
  const { locale } = useLocale();
  return useCallback((key: DictKey, vars?: Record<string, string | number>) => translate(locale, key, vars), [locale]);
}

/** 渲染期取卡片类型名（工具条按钮、列表分组标题都用它）。 */
export function useCardLabel(): (type: CardType) => string {
  const { locale } = useLocale();
  return useCallback((type: CardType) => cardLabelOf(locale, type), [locale]);
}

/**
 * 事件回调 / store 里没有 hook 可用的地方走这两个：直接读 dataset。
 * 与 features-client 的 featureOn 同一个套路——那时一定已经有 document 了。
 */
export function currentLocale(): Locale {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  return parseLocale(document.body.dataset.locale);
}

export function tr(key: DictKey, vars?: Record<string, string | number>): string {
  return translate(currentLocale(), key, vars);
}

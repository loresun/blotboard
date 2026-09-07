"use client";

/**
 * 帮助页（`/docs`）：左边目录、右边正文，一整套「这东西是什么 / 怎么上手 / 每个功能怎么用」。
 *
 * 内容不在这个文件里——真源是 `docs/guide/*.md`（见 lib/docs.ts 抬头），这一页只负责
 * 把它们摊开得好读：分组目录、关键词过滤、正文里的相互跳转、以及右上角「拿原文」
 * （同一页的 Markdown 裸文件，可以整段喂给 agent）。
 *
 * 三个刻意的选择：
 *  ① **地址栏带 `?doc=slug`** —— 帮助要能被转发。发给别人的链接必须直接落到那一页；
 *  ② 正文里的站内链接（`?doc=…` / `/docs?doc=…`）**就地切页**，不新开标签——
 *     读文档时来回跳是常态，攒一屏标签页很烦；外链照旧新标签；
 *  ③ 目录搜索连正文首段一起匹配——找「怎么回滚」的人不会先猜到那一页叫「历史」。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { SiteNav } from "./SiteNav";
import { Markdown } from "./cards/Markdown";
import { api, type DocEntryInfo, type DocMetaInfo } from "@/lib/api-client";
import { ICON_MD, ICON_SM, UI } from "@/lib/icons";
import { tr, useT } from "@/lib/i18n/client";

interface DocIndex {
  total: number;
  groups: { name: string; docs: DocMetaInfo[] }[];
}

/** 当前地址栏想看哪一页（没写就交给调用方兜到第一页） */
function slugFromLocation(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("doc") || "";
}

export function DocsApp() {
  const t = useT();
  const [index, setIndex] = useState<DocIndex | null>(null);
  const [slug, setSlug] = useState("");
  const [doc, setDoc] = useState<DocEntryInfo | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  /* 目录：进来先拉一次；地址栏没指定就落到第一页 */
  useEffect(() => {
    let alive = true;
    api
      .listDocs()
      .then((data) => {
        if (!alive) return;
        setIndex(data);
        const first = data.groups[0]?.docs[0]?.slug || "";
        setSlug((current) => current || slugFromLocation() || first);
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  /* 浏览器前进后退：地址栏是真源，回退要真的回到上一页帮助 */
  useEffect(() => {
    const onPop = () => setSlug(slugFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /* 正文：换页就拉，顺手把地址栏同步上（分享出去能直接落到这一页） */
  useEffect(() => {
    if (!slug) return;
    let alive = true;
    setError("");
    api
      .getDoc(slug)
      .then((data) => {
        if (!alive) return;
        setDoc(data);
        document.title = tr("pages.docs.documentTitle", { title: data.title });
        // 换页从头读起：上一页翻到一半的滚动位置留着没有任何意义
        document.querySelector(".doc-main")?.scrollTo({ top: 0 });
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      });
    if (slugFromLocation() !== slug) {
      window.history.pushState(null, "", `${window.location.pathname}?doc=${encodeURIComponent(slug)}`);
    }
    return () => {
      alive = false;
    };
  }, [slug]);

  /** 正文里的站内跳转就地切页（外链交给浏览器） */
  const onBodyClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest?.("a");
    const href = anchor?.getAttribute("href") || "";
    const match = /^(?:\/docs)?\?doc=([a-z0-9-]+)$/.exec(href);
    if (!match) return;
    event.preventDefault();
    setSlug(match[1]);
  }, []);

  const shown = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!index) return [];
    if (!keyword) return index.groups;
    return index.groups
      .map((group) => ({
        name: group.name,
        docs: group.docs.filter((item) =>
          `${item.title} ${item.summary} ${item.excerpt}`.toLowerCase().includes(keyword),
        ),
      }))
      .filter((group) => group.docs.length);
  }, [index, query]);

  const copyMarkdown = async () => {
    if (!doc) return;
    try {
      await navigator.clipboard.writeText(doc.body);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板被拒（无权限 / 非安全上下文）就静默：右边那颗「原文」按钮照样能拿到同一份 */
    }
  };

  return (
    <div className="app nav-app docs-app">
      <header className="topbar">
        <Link className="top-btn icon-only" href="/" title={t("pages.nav.back")} aria-label={t("pages.nav.back")}>
          <UI.back {...ICON_MD} />
        </Link>
        <div className="brand">{t("pages.docs.brand")}</div>
        {/* 五个页面同一副导航（真源 components/SiteNav.tsx） */}
        <SiteNav current="docs" />
        <div className="spacer" />
        {doc ? (
          <>
            <button className="top-btn" title={t("pages.docs.copyRaw.title")} onClick={copyMarkdown}>
              {copied ? <UI.check {...ICON_SM} /> : <UI.copy {...ICON_SM} />}
              <span className="top-btn-label">{copied ? t("common.copied") : t("pages.docs.copyRaw")}</span>
            </button>
            <a
              className="top-btn"
              href={`/api/docs?slug=${encodeURIComponent(doc.slug)}&format=md`}
              target="_blank"
              rel="noopener noreferrer"
              title={t("pages.docs.raw.title")}
            >
              <UI.code {...ICON_SM} />
              <span className="top-btn-label">/api/docs</span>
            </a>
          </>
        ) : null}
      </header>

      <div className="doc-wrap">
        <aside className="doc-side">
          <label className={`nav-search${query ? " active" : ""}`}>
            <UI.search size={14} strokeWidth={1.9} />
            <input
              value={query}
              placeholder={t("pages.docs.search")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  (event.target as HTMLInputElement).blur();
                }
              }}
            />
            {query ? (
              <button className="nav-search-clear" title={t("pages.docs.search.clear")} onClick={() => setQuery("")}>
                <UI.close size={14} strokeWidth={1.9} />
              </button>
            ) : null}
          </label>

          {!index ? <div className="doc-empty">{t("pages.docs.loadingIndex")}</div> : null}
          {index && !shown.length ? <div className="doc-empty">{t("pages.docs.noMatch")}</div> : null}
          {shown.map((group) => (
            <div className="doc-group" key={group.name}>
              <div className="doc-group-cap">{group.name}</div>
              {group.docs.map((item) => (
                <button
                  key={item.slug}
                  className={`doc-item${item.slug === slug ? " active" : ""}`}
                  title={item.summary || item.title}
                  onClick={() => setSlug(item.slug)}
                >
                  <span className="doc-item-title">{item.title}</span>
                  {item.summary ? <span className="doc-item-sub">{item.summary}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </aside>

        <main className="doc-main">
          {error ? (
            <div className="doc-error">{t("pages.docs.error", { message: error })}</div>
          ) : doc ? (
            <article className="doc-article">
              <div className="doc-crumb">{doc.group}</div>
              <h1 className="doc-title">{doc.title}</h1>
              {doc.summary ? <p className="doc-summary">{doc.summary}</p> : null}
              <div onClick={onBodyClick}>
                <Markdown text={doc.body} className="doc-md" />
              </div>
              <DocFoot index={index} slug={slug} onPick={setSlug} />
            </article>
          ) : (
            <div className="doc-empty">{t("pages.docs.loadingBody")}</div>
          )}
        </main>
      </div>
    </div>
  );
}

/** 页脚的「上一页 / 下一页」：按目录顺序串起来，一整套帮助能从头读到尾 */
function DocFoot({
  index,
  slug,
  onPick,
}: {
  index: DocIndex | null;
  slug: string;
  onPick: (slug: string) => void;
}) {
  const t = useT();
  const flat = useMemo(() => (index?.groups || []).flatMap((group) => group.docs), [index]);
  const at = flat.findIndex((item) => item.slug === slug);
  if (at < 0) return null;
  const prev = at > 0 ? flat[at - 1] : null;
  const next = at + 1 < flat.length ? flat[at + 1] : null;
  if (!prev && !next) return null;
  return (
    <nav className="doc-foot" aria-label={t("pages.docs.footAria")}>
      {prev ? (
        <button className="doc-foot-btn" onClick={() => onPick(prev.slug)}>
          <UI.prev size={14} strokeWidth={2} />
          <span className="doc-foot-text">
            <span className="doc-foot-cap">{t("pages.docs.prev")}</span>
            <span className="doc-foot-title">{prev.title}</span>
          </span>
        </button>
      ) : (
        <span />
      )}
      {next ? (
        <button className="doc-foot-btn next" onClick={() => onPick(next.slug)}>
          <span className="doc-foot-text">
            <span className="doc-foot-cap">{t("pages.docs.next")}</span>
            <span className="doc-foot-title">{next.title}</span>
          </span>
          <UI.next size={14} strokeWidth={2} />
        </button>
      ) : (
        <span />
      )}
    </nav>
  );
}

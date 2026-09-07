"use client";

/**
 * 站点导航（顶栏左上角）——这个服务的主要页面，全收在这一处。
 *
 * 为什么单独抽一个组件：在此之前「导航 / 资源 / 任务台」是三颗散在顶栏右半边的按钮，
 * 跟「整理」「导出」「Agent」这些**对当前这块板动手**的按钮混在一排。两类东西的心智
 * 完全不同——一类是「去别的页面看」，一类是「在这块板上做」——混排的结果就是顶栏又长又
 * 难认。现在左上角固定是「去哪儿」，右侧固定是「做什么」，中间是「怎么看画布」。
 *
 * 一条行为约定：**从画板出发一律新标签打开**（画布是工作面，点一下导航就把它顶掉太贵），
 * 子页面之间则同标签切换（那几页都是只读的翻找，来回跳不该攒一堆标签）。
 */
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ICON_SM, UI, type LucideIcon } from "@/lib/icons";
import { useFeatures } from "@/lib/features-client";
import { useT } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";
import { browserWorkspace } from "@/lib/storage-mode";

export type SitePage = "start" | "board" | "nav" | "resources" | "tasks" | "docs" | "agent";

interface SitePageItem {
  key: SitePage;
  href: string;
  icon: LucideIcon;
  /** 文案走字典：`nav.<key>` 是标签，`nav.<key>.title` 是 tooltip */
  labelKey: DictKey;
  titleKey: DictKey;
  /** e2e / 样式挂钩用的额外类名（任务台那颗有测试按类名点它） */
  className?: string;
}

const PAGES: SitePageItem[] = [
  { key: "start", href: "/start", icon: UI.detail, labelKey: "nav.start", titleKey: "nav.start.title" },
  { key: "board", href: "/", icon: UI.blocks, labelKey: "nav.board", titleKey: "nav.board.title" },
  { key: "nav", href: "/nav", icon: UI.compass, labelKey: "nav.nav", titleKey: "nav.nav.title" },
  { key: "resources", href: "/resources", icon: UI.library, labelKey: "nav.resources", titleKey: "nav.resources.title" },
  { key: "tasks", href: "/tasks", icon: UI.tasks, labelKey: "nav.tasks", titleKey: "nav.tasks.title", className: "tasks-link-btn" },
  { key: "agent", href: "/agent", icon: UI.agent, labelKey: "nav.agent", titleKey: "nav.agent.title" },
  { key: "docs", href: "/docs", icon: UI.docs, labelKey: "nav.docs", titleKey: "nav.docs.title" },
];

export function SiteNav({
  current,
  /** 在画板页时把当前板带给任务台，进去就是预过滤好的 */
  boardId,
  /**
   * 窄到放不下七个页面时收成一颗：只留「你在哪儿」，其余进一张下拉。
   * 由调用方（顶栏）量出来后传进来——SiteNav 自己不知道整条顶栏还剩多少地方。
   */
  compact = false,
}: {
  current: SitePage;
  boardId?: string | null;
  compact?: boolean;
}) {
  const { browserStorage } = useFeatures();
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLElement | null>(null);
  // 画板页出发一律新标签：把正在看的画布顶掉，代价远大于多一个标签
  const newTab = current === "board";
  const pages = browserStorage ? PAGES.filter((page) => page.key === current || !["resources", "tasks"].includes(page.key)) : PAGES;

  // 收起态的下拉：点到外面就关；档位一变（不再收起）也关
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);
  useEffect(() => {
    if (!compact) setOpen(false);
  }, [compact]);

  const items = pages.map((page) => {
    const Icon = page.icon;
    const label = t(page.labelKey);
    const title = t(page.titleKey);
    const href = page.key === "agent" && browserStorage
      ? `/agent?storage=browser&workspace=${encodeURIComponent(browserWorkspace())}${boardId ? `&board=${encodeURIComponent(boardId)}` : ""}`
      : (page.key === "tasks" || page.key === "agent") && boardId
        ? `/${page.key}?board=${encodeURIComponent(boardId)}`
        : page.href;
    const inner = (
      <>
        <Icon {...ICON_SM} />
        <span className="sn-label">{label}</span>
      </>
    );
    if (page.key === current) {
      return (
        <span key={page.key} className="sn-item current" aria-current="page" title={t("nav.current", { label })}>
          {inner}
        </span>
      );
    }
    const cls = `sn-item${page.className ? ` ${page.className}` : ""}`;
    return newTab ? (
      <a
        key={page.key}
        className={cls}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={t("nav.newTab", { title })}
        onClick={() => setOpen(false)}
      >
        {inner}
      </a>
    ) : (
      <Link key={page.key} className={cls} href={href} title={title} onClick={() => setOpen(false)}>
        {inner}
      </Link>
    );
  });

  return (
    <nav ref={wrapRef} className={`site-nav${compact ? " compact" : ""}`} aria-label={t("nav.aria")}>
      {compact ? (
        <>
          <button
            type="button"
            className={`sn-item sn-more${open ? " current" : ""}`}
            aria-haspopup="menu"
            aria-expanded={open}
            title={t("nav.aria")}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((value) => !value);
            }}
          >
            <UI.compass {...ICON_SM} />
            <UI.chevron size={12} strokeWidth={2} />
          </button>
          {open ? (
            <div className="sn-menu" role="menu">
              {items}
            </div>
          ) : null}
        </>
      ) : (
        items
      )}
    </nav>
  );
}

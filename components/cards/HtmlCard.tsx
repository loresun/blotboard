"use client";

/**
 * HTML 嵌入卡（外部 PPT / 网页）的渲染。
 *
 * 这张卡跟其它卡片有个本质区别：**卡面上跑的是别人的代码**。所以这里的每个约束都不是装饰：
 *
 * · `sandbox`：默认只给 allow-scripts（PPT 要靠 JS 翻页）+ allow-same-origin（页面要取自己的
 *   图表数据/字体）。**同源的地址会主动去掉 allow-same-origin**——同源 + allow-scripts 的 iframe
 *   能把自己的 sandbox 属性摘掉再重载，等于沙箱不存在；跨源时它拿不到父页面，这个组合才安全。
 * · `referrerpolicy=no-referrer`：画板可能开在 Tailscale 的 100.x 地址上，别把内网地址随
 *   referer 送给被嵌页面——那等于把自己的内网地址白送给对面。
 * · 只有进了可视区才挂 iframe，划出去一会儿就卸载：一页 PPT 就是一个渲染进程，
 *   12 张卡常驻 = 12 个进程，画布拖起来就开始掉帧。
 * · 平时 iframe 不吃鼠标事件（pointer-events:none），点「交互」才接管——
 *   否则鼠标一进卡片，拖画布/框选/滚轮缩放全被 iframe 吃掉，这张卡就成了画布上的一个黑洞。
 *
 * 「能嵌哪些地址」不在这里判断，在服务端写入时就挡掉了（lib/board-schema.ts normalizeHtmlField）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ICON_SM, UI } from "@/lib/icons";
import { useT } from "@/lib/i18n/client";
import type { HtmlField } from "@/lib/types";

/** 划出可视区多久后卸载 iframe：给来回平移留个窗口，免得手一抖就重载一次页面 */
const UNLOAD_GRACE_MS = 6000;
/** 提前多少像素开始加载（比可视区大一圈，滚到跟前时页面已经在了） */
const PRELOAD_MARGIN = "240px";

function sandboxFor(url: string): string {
  const base = "allow-scripts allow-forms allow-popups";
  if (typeof window === "undefined") return base;
  try {
    // 同源页面拿 allow-same-origin 就能自己摘掉沙箱（见文件头注释），只给它 allow-scripts
    return new URL(url, window.location.href).origin === window.location.origin ? base : `${base} allow-same-origin`;
  } catch {
    return base;
  }
}

export interface HtmlEmbedProps {
  html: HtmlField;
  title?: string;
  /** card = 卡面（默认不吃鼠标事件）；reader = 阅读模式（一进来鼠标就能操作；键盘归属见 ReaderModal） */
  variant?: "card" | "reader";
}

/**
 * 一块「活的」嵌入区域：懒加载 + 等比缩放 + 交互开关。
 * 卡面和阅读模式共用这一份，区别只在初始是否可交互、以及外面给多大的框。
 */
export function HtmlEmbed({ html, title, variant = "card" }: HtmlEmbedProps) {
  const t = useT();
  const { url, mode, frameW, frameH } = html;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [visible, setVisible] = useState(false);
  /** 手动模式下用户点过「加载」；也用来给「重新加载」换 key */
  const [manual, setManual] = useState(false);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [interactive, setInteractive] = useState(variant === "reader");

  // 卡片尺寸变了（拉伸卡片 / 窗口缩放）要重算缩放比例
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const apply = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 可视区探测：进来就加载，出去等一会儿再卸载
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          if (timer) clearTimeout(timer);
          timer = null;
          setVisible(true);
        } else if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            setVisible(false);
            setInteractive(variant === "reader");
          }, UNLOAD_GRACE_MS);
        }
      },
      { rootMargin: PRELOAD_MARGIN },
    );
    observer.observe(el);
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [variant]);

  // 换地址 = 换一张页面：手动模式重新回到「点了才加载」
  useEffect(() => {
    setManual(false);
    setInteractive(variant === "reader");
  }, [url, variant]);

  const sandbox = useMemo(() => sandboxFor(url), [url]);
  // 阅读模式是「我现在就要看这一页」的明确动作：手动模式在这儿也直接加载，不再让人多点一次
  const live = Boolean(url) && (visible || variant === "reader") && (mode === "auto" || manual || variant === "reader");
  // frameW=0：不缩放，iframe 直接铺满（页面自己是响应式的）
  const scale = frameW > 0 && frameH > 0 && box.w > 0 && box.h > 0 ? Math.min(box.w / frameW, box.h / frameH) : 1;

  return (
    <div className={`html-embed${interactive ? " live" : ""}`}>
      {/* 舞台单独一层：缩放比例量的是它的尺寸，不能把页脚那一行算进去 */}
      <div className="html-stage-wrap nowheel" ref={boxRef}>
        {!url ? (
          <span className="placeholder">{t("cards.html.empty")}</span>
        ) : live ? (
          <div
            className="html-embed-stage"
            style={frameW > 0 && frameH > 0 ? { width: frameW, height: frameH, transform: `scale(${scale})` } : undefined}
          >
            <iframe
              key={`${url}#${reloadSeq}`}
              className="html-embed-frame"
              src={url}
              title={title || url}
              sandbox={sandbox}
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          </div>
        ) : mode === "manual" ? (
          <button className="html-embed-load nodrag" onClick={() => setManual(true)}>
            <UI.run {...ICON_SM} /> {t("cards.html.load")}
          </button>
        ) : (
          <span className="placeholder">{t("cards.html.lazyHint")}</span>
        )}
      </div>
      {url ? (
        <div className="html-foot nodrag">
          <span className="host-chip" title={url}>
            {html.host || url}
          </span>
          <span className="foot-spacer" />
          {live ? (
            <button
              className="html-tool"
              title={t("cards.html.reloadTitle")}
              aria-label={t("cards.html.reload")}
              onClick={() => setReloadSeq((seq) => seq + 1)}
            >
              <UI.refresh {...ICON_SM} />
            </button>
          ) : null}
          <a className="html-tool" href={url} target="_blank" rel="noopener noreferrer" title={t("cards.html.openTab")}>
            <UI.external {...ICON_SM} />
          </a>
          {variant === "card" ? (
            <button
              className={`card-action${interactive ? " on" : ""}`}
              data-act="interact"
              title={
                interactive
                  ? t("cards.html.stopInteractTitle")
                  : t("cards.html.startInteractTitle")
              }
              onClick={() => {
                if (!interactive && !live) setManual(true);
                setInteractive((on) => !on);
              }}
            >
              {interactive ? <UI.ban {...ICON_SM} /> : <UI.select {...ICON_SM} />}
              {interactive ? t("cards.html.stopInteract") : t("cards.html.interact")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 卡面：一块嵌入区 + 一行页脚。 */
export function HtmlCard({ html, title }: { html?: HtmlField; title?: string }) {
  const t = useT();
  if (!html?.url) return <span className="placeholder">{t("cards.html.empty")}</span>;
  return <HtmlEmbed html={html} title={title} />;
}

"use client";

/**
 * 阅读模式：把一张卡片摊到整屏看，并且能一路读下去。
 *
 * 卡面为了摆得下永远是缩略的——SVG / Mermaid / 导图缩成一团，长正文只露前几行。
 * 这里给一个「像看图片一样」的壳：可缩放、可拖动、双击复位；
 * 文本类不缩放而是上下滚，因为放大文字不如直接把行宽拉开好读。
 *
 * 除了单张，整块板还被压成一条**阅读序列**（从上到下、同排从左到右，见 readingOrder）：
 * ←/→ 翻卡、左侧目录跳转、进度 n/N。画板是二维的，读的时候需要一维——
 * 摆版面时的上下左右，本来就带着作者心里的先后。
 *
 * 两件让「一路读下去」真的成立的事，各自的道理写在下面：
 * · **全屏**（F）：版面铺满整块屏，图 / PPT / 表格能大出一大截（见 toggleFull）。
 * · **键盘归属**：正文里嵌了别人的页面（网页卡 / PDF）时，焦点一旦掉进 iframe，
 *   ←/→ 就再也回不到这里。默认把焦点抢回来保证翻卡，要翻 PPT 就按头上那个开关（见 keysToEmbed）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReaderContent, cardLabel } from "../cards/CardFullView";
import { COLORS } from "@/lib/constants";
import { useCardLabel, useT } from "@/lib/i18n/client";
import { applyFullscreen, fullscreenBusy, fullscreenElement, onFullscreenChange } from "@/lib/fullscreen";
import { ICON_MD, ICON_SM, UI, typeIcon } from "@/lib/icons";
import { readingSequence, useBoardStore } from "@/lib/store";
import { readingChapters } from "@/lib/layout";
import type { BoardCard } from "@/lib/types";

/**
 * 缩放尺度：**10% – 1000%**，比原来的 25% – 400% 两头都放宽了一大截。
 * 阅读模式里那几种「一张图」的自然尺度差得极远——一张 A4 截图 100% 就够读，
 * 而子画板预览是整块板压进一个舞台，卡片标题在 100% 时只有几个像素高，
 * 非得推到七八倍才认得出字；反过来一张长图又需要退到很小才看得见全貌。
 * 上限给到 10 是因为这几类里除了 image 全是矢量（SVG / mermaid / 导图 / 子画板），
 * 放多大都不糊；位图放大会糊，但那是用户自己要的，拦着不放才是碍事。
 */
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 10;
/**
 * 按钮与 +/- 的档位。**只管按钮与键盘**——滚轮 / 触控板捏合走连续值（见 onWheel）。
 * 100% 附近密、两头疏：按一下的期望是「明显变一点」，在 100% 那一带 25 个点就很明显，
 * 到了 600% 再按 25 个点等于没动。
 */
const ZOOM_STEPS = [0.1, 0.15, 0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
/**
 * 滚轮 / 捏合的连续缩放速率：一格滚轮（100px）约 ±18%，触控板一次捏合只来几个像素，
 * 于是自然细成百分之几。原来这里每个 wheel 事件都硬跳一整档，
 * 捏合时一眨眼就从 25% 冲到 400%，根本停不到想要的那个尺度上。
 */
const ZOOM_WHEEL_RATE = 0.002;
/** 单个 wheel 事件的位移上限：惯性滚动偶尔一次给上千像素，不掐住就是一下子到底 */
const WHEEL_MAX_PX = 400;
/** 滚轮单位换算：deltaMode 0=像素 / 1=行 / 2=页（Firefox 常给「行」，不换算会慢得像没反应） */
const WHEEL_LINE_PX = 16;
const WHEEL_PAGE_PX = 400;
/** 这些类型是「一张图」，缩放才有意义；其余是文字，滚动更好读 */
// chart 走的就是 mermaid 那条渲染路径（cards/chart/ui.tsx），一起进来
const ZOOMABLE = new Set(["svg", "mermaid", "mindmap", "image", "board", "excalidraw", "chart"]);
/**
 * 舞台要不要给死尺寸。
 * SVG / Mermaid / 图片这些内部是按百分比排版的，父容器 auto 的话百分比解析不出来
 * ——SVG 直接塌成 0（一片空白），mermaid 缩回它自己的 max-width（小小一块）。
 * 导图不同：它有确定的自然尺寸，给死反而会被压扁，让它自然铺开再靠 transform 缩放。
 */
// media 与 pdf 同理：播放器要有确定的舞台，不给死尺寸时视频会塌成一条
const FIXED_STAGE = new Set(["svg", "mermaid", "image", "board", "pdf", "media", "excalidraw", "chart"]);

/** 焦点被嵌入页抢来抢去时的认输阈值：1.5 秒内抢回超过这么多次就不抢了（见 keysToEmbed） */
const STEAL_WINDOW_MS = 1500;
const STEAL_LIMIT = 6;

export function ReaderModal() {
  const open = useBoardStore((state) => state.drawer === "read");
  const cardId = useBoardStore((state) => state.readCardId);
  // 订阅 cards 而不是整个 board：平移画布也会换 board 引用，阅读时没必要跟着重渲染
  const cards = useBoardStore((state) => state.board?.cards);
  const search = useBoardStore((state) => state.search);
  const typeFilter = useBoardStore((state) => state.typeFilter);
  const t = useT();
  const typeLabel = useCardLabel();

  /**
   * 阅读范围在「打开那一刻」定死：从筛选命中的卡进来就只读命中的那批，
   * 从一张被筛掉的卡进来（右键直接开的）就读整板。
   * 不能每翻一张重判——那样从整板序列翻到一张恰好命中筛选的卡时，
   * 序列会突然从 8 张缩成 2 张，进度条整个跳掉。
   */
  const entryRef = useRef<string | null>(null);
  if (!open) entryRef.current = null;
  else if (!entryRef.current) entryRef.current = cardId;
  const entryId = entryRef.current || cardId;

  const sequence = useMemo(
    () => readingSequence(cards, search, typeFilter, entryId),
    [cards, search, typeFilter, entryId],
  );
  const index = cardId ? sequence.findIndex((item) => item.id === cardId) : -1;
  const card = index >= 0 ? sequence[index] : null;
  const total = sequence.length;
  /** 序列比整板短 = 筛选或「跳过」在生效，目录上要说清楚现在读的只是其中一部分 */
  const partial = total < (cards?.length || 0);
  /** 目录里的层级：框里的卡缩进挂在它的框下面（框本身就是那一章的标题） */
  const chapters = useMemo(() => readingChapters(sequence), [sequence]);

  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [outline, setOutline] = useState(true);
  /** 全屏版面：CSS 那层（铺满窗口）永远生效，原生全屏能进就顺手进（见 toggleFull） */
  const [full, setFull] = useState(false);
  /** 正文里有没有嵌别人的页面（iframe）——运行时探测，不按卡片类型硬编码 */
  const [embedded, setEmbedded] = useState(false);
  /** true = 键盘交给那张嵌入页（←/→ 翻 PPT）；false = 归阅读模式（←/→ 翻卡） */
  const [keysToEmbed, setKeysToEmbed] = useState(false);
  const dragging = useRef<{ x: number; y: number } | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<HTMLButtonElement | null>(null);
  const stealRef = useRef({ at: 0, count: 0 });
  const zoomable = card ? ZOOMABLE.has(card.type) : false;

  const close = useCallback(() => useBoardStore.getState().openReader(null), []);
  const reset = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  /**
   * 全屏：**同一个节点上加个类 + 请求原生全屏**，不搬 DOM。
   * 搬一下里面的 iframe 就会重载——翻到第 7 页的 PPT 会跳回第 1 页（lib/fullscreen.ts 头注）。
   *
   * 原生全屏进不去（iOS Safari 没有元素全屏、或被权限策略拦了）也不回滚版面：
   * CSS 那层已经把弹窗铺满窗口，少的只是浏览器自己那条地址栏。
   */
  const setFullscreen = useCallback((next: boolean) => {
    // 副作用放在 setState 外面：updater 必须是纯函数（React 可以重放它），
    // 把 requestFullscreen 写进去就会被重放第二次——而第二次已经不在用户手势里了
    setFull(next);
    void applyFullscreen(backdropRef.current, next);
  }, []);
  const toggleFull = useCallback(() => setFullscreen(!full), [full, setFullscreen]);

  /** 翻到序列里的第 target 张（越界就不动：到头停住比绕回第一张更容易知道自己读到哪） */
  const jump = useCallback(
    (target: number) => {
      const next = sequence[target];
      if (!next || next.id === cardId) return;
      const state = useBoardStore.getState();
      state.openReader(next.id);
      // 顺手把画布也带过去：读完一关掉，视野正停在你读到的这张上
      state.setSelection({ kind: "card", id: next.id });
      state.requestFocus(next.id);
    },
    [sequence, cardId],
  );

  useEffect(() => {
    reset();
    setKeysToEmbed(false);
    stealRef.current = { at: 0, count: 0 };
    // 换卡要回到正文顶部，不然上一张滚到一半的位置会带过来
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [cardId, reset]);

  /**
   * 焦点落在弹窗自己身上：keydown 挂在 document 上，只要焦点还在本页面就收得到，
   * 但**从卡头点进来时焦点还留在那颗按钮上**——按钮在弹窗外面（画布上的卡片），
   * 弹窗一开它就被卸载了，焦点会掉回 body。这里明确接过来，←/→ 与 Esc 一进来就能用。
   */
  useEffect(() => {
    if (open) shellRef.current?.focus({ preventScroll: true });
  }, [open, cardId]);

  /** 目录里的当前项跟着走，翻到看不见的地方要自己滚出来 */
  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, cardId, outline]);

  /* ── 全屏 ────────────────────────────────────── */

  /**
   * 原生全屏一旦真的生效，**它才是真源**：用户按 Esc、点浏览器自己那个退出按钮都不经过我们。
   * 所以状态从 fullscreenchange 回读，两个方向都跟——否则会留下「按钮说着全屏、其实已经退出」
   * 或者反过来的壳。进不去原生全屏的浏览器不发这个事件，CSS 那层的版面不受影响。
   */
  useEffect(() => {
    if (!open) return;
    return onFullscreenChange(() => {
      // 自己刚请求的那一次不跟：并发的请求会被收敛成「最后一次意图说了算」，
      // 中途难免掠过「进了又退」这种中间态，跟着它走就会把中间那一帧当成结论
      // （连按两下全屏时真会卡在错的一边）
      if (fullscreenBusy()) return;
      setFull(Boolean(fullscreenElement()));
    });
  }, [open]);

  /** 关掉阅读模式时把全屏一并退掉：留着的话用户会对着一块空白的全屏画布发愣 */
  useEffect(() => {
    if (open) return;
    setFull(false);
    void applyFullscreen(null, false);
  }, [open]);

  /* ── 嵌入页（iframe）与键盘归属 ──────────────── */

  /**
   * 正文里有没有 iframe，**探测而不是按类型判断**：阅读模式是横切服务，
   * 不该认识「html 卡 / pdf 卡」这些具体类型；以后哪个卡片包嵌了页面，这里自动跟上。
   * 嵌入页是懒加载的（HtmlCard 进可视区才挂 iframe），所以要盯着 DOM 变化。
   */
  useEffect(() => {
    const body = bodyRef.current;
    if (!open || !body) return;
    const scan = () => setEmbedded(Boolean(body.querySelector("iframe")));
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [open, cardId]);

  /**
   * 键盘归阅读模式时：焦点一旦掉进 iframe 就抢回来。
   *
   * 不抢的话，点一下嵌入的 PPT，键盘就永久归了那张页面——document 上的 keydown
   * 收不到任何东西，←/→ 与 Esc 双双静默失效，而界面上没有任何迹象说明为什么。
   * 抢回来不影响鼠标：那一下点击早就送进页面了（该翻的页翻了），少的只是焦点。
   * 真要用键盘操作页面，按头上那个「键盘」开关——那才是明确的、看得见的交接。
   */
  useEffect(() => {
    if (!open || !embedded || keysToEmbed) return;
    const takeBack = () => {
      const shell = shellRef.current;
      const active = document.activeElement;
      if (!shell || !(active instanceof HTMLIFrameElement) || !shell.contains(active)) return;
      const now = Date.now();
      const steal = stealRef.current;
      if (now - steal.at > STEAL_WINDOW_MS) {
        steal.at = now;
        steal.count = 0;
      }
      steal.count += 1;
      if (steal.count > STEAL_LIMIT) {
        // 有的嵌入页会在被 blur 之后立刻把焦点抢回去（自带编辑器的页面就这样）。
        // 抢来抢去是个死循环，这时候认输：键盘归它，开关照样能把它收回来。
        setKeysToEmbed(true);
        return;
      }
      active.blur();
      shell.focus({ preventScroll: true });
    };
    // 焦点进同页 iframe，两种浏览器给的信号不一样：Chromium 系发 window blur，
    // 也有把 focusin 派到 iframe 元素上的。两个都听，处理本身是幂等的。
    const onBlur = () => window.setTimeout(takeBack, 0);
    window.addEventListener("blur", onBlur);
    document.addEventListener("focusin", takeBack);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("focusin", takeBack);
    };
  }, [open, embedded, keysToEmbed]);

  /** 交给页面的那一刻就把焦点送进去，省得用户还要再点一下才生效 */
  useEffect(() => {
    if (!open || !keysToEmbed) return;
    bodyRef.current?.querySelector("iframe")?.focus();
  }, [open, keysToEmbed, cardId]);

  /**
   * 滚轮：跟画布本身一个习惯——**滚轮平移，⌘/Ctrl+滚轮缩放**。
   * 之前只认带修饰键的缩放，普通滚轮直接 return，而容器又是 overflow:hidden，
   * 结果就是滚轮完全没反应。
   *
   * 缩放走**连续值**而不是档位：触控板捏合是一串「每次几个像素」的 wheel 事件，
   * 一个事件跳一整档的话，手指刚碰上去就已经冲到头了，中间那些尺度根本停不住。
   * 档位留给按钮与 +/-（那里一下按一档才顺手），手上的手势要多细有多细。
   *
   * 必须用原生监听 + passive:false：React 在根节点上注册的 wheel 是 passive 的，
   * 在 onWheel 里调 preventDefault 是空操作，⌘+滚轮会连带触发浏览器自己的页面缩放。
   */
  useEffect(() => {
    const body = bodyRef.current;
    if (!open || !zoomable || !body) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { x: dx, y: dy } = wheelPixels(event);
      if (event.metaKey || event.ctrlKey) {
        // 以光标为锚点缩放：不然放大时目标会跑出视野，得再拖回来
        const rect = body.getBoundingClientRect();
        const px = event.clientX - rect.left - rect.width / 2;
        const py = event.clientY - rect.top - rect.height / 2;
        setZoom((current) => {
          // 指数：同样一下滚轮，在 20% 和在 500% 上「变化的感觉」一样大
          const next = clampZoom(current * Math.exp(-clamp(dy, WHEEL_MAX_PX) * ZOOM_WHEEL_RATE));
          if (Math.abs(next - current) < 1e-4) return current;
          const ratio = next / current;
          setOffset((prev) => ({ x: px - (px - prev.x) * ratio, y: py - (py - prev.y) * ratio }));
          return next;
        });
        return;
      }
      setOffset((prev) => ({ x: prev.x - dx, y: prev.y - dy }));
    };
    body.addEventListener("wheel", onWheel, { passive: false });
    return () => body.removeEventListener("wheel", onWheel);
  }, [open, zoomable]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      // 正文里也可能有输入框（清单卡的勾选、表格卡的搜索…），别抢它们的键
      if ((event.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (event.key === "Escape") {
        // 全屏时 Esc 的本意是「回到窗口」，不是「别读了」。
        // 多数浏览器压根不把这一下发给页面（自己吞掉去退全屏），这里是给会发的那些兜底。
        if (full) {
          setFullscreen(false);
          return;
        }
        close();
        return;
      }
      // ←/→ 翻卡；带修饰键的留给浏览器（⌘← 是后退）
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          jump(index - 1);
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          jump(index + 1);
        }
        if (event.key === "Home") jump(0);
        if (event.key === "End") jump(total - 1);
        if (event.key === "f" || event.key === "F") {
          event.preventDefault();
          toggleFull();
        }
      }
      if (!zoomable) return;
      if (event.key === "+" || event.key === "=") setZoom((z) => nextZoom(z, 1));
      if (event.key === "-") setZoom((z) => nextZoom(z, -1));
      if (event.key === "0") reset();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, zoomable, close, reset, jump, index, total, full, toggleFull, setFullscreen]);

  if (!open || !card) return null;
  const TypeIcon = typeIcon(card.type);
  const prev = index > 0 ? sequence[index - 1] : null;
  const next = index + 1 < total ? sequence[index + 1] : null;
  const skipped = card?.reading?.skip === true;

  /**
   * 「下次别读这张」。读到一半发现某张卡打断了节奏，最顺手的地方就是在这里按一下，
   * 而不是关掉阅读模式、去画布上找到它、双击进抽屉。
   *
   * 标上之后当场翻到下一张（没有下一张就退回上一张）——留在一张已经标成跳过的卡上
   * 会让人以为按钮没生效。这张卡只是从**阅读序列**里退出，画布、导出、大纲都还有它。
   */
  // 普通函数不是 hook：这一段在 `if (!open || !card) return null` **之后**，
  // 写成 useCallback 会让两次渲染的 hook 数量对不上（React 当场炸掉整个弹窗）
  async function toggleSkip() {
    const state = useBoardStore.getState();
    const target = skipped ? null : next || prev;
    try {
      // 取消跳过时只清 skip，显式序号（如果设过）留着
      await state.patchCard(card!.id, {
        reading: skipped ? { order: card!.reading?.order ?? null } : { ...(card!.reading || {}), skip: true },
      });
      if (target) {
        state.openReader(target.id);
        state.setSelection({ kind: "card", id: target.id });
        state.requestFocus(target.id);
      }
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }
  const hint = keysToEmbed
    ? t("panels.reader.hint.embed")
    : [
        total > 1 ? t("panels.reader.hint.flip") : "",
        zoomable ? t("panels.reader.hint.zoom") : "",
        t("panels.reader.hint.full"),
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <div
      ref={backdropRef}
      className={`modal-backdrop${full ? " immersive" : ""}`}
      onPointerDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        ref={shellRef}
        className="modal reader-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t("panels.reader.title")}
        tabIndex={-1}
      >
        <div className="modal-head">
          <h2>
            <TypeIcon size={17} strokeWidth={1.8} />
            {card.title || t("panels.reader.untitled", { type: typeLabel(card.type) })}
          </h2>
          {total > 1 ? (
            <div className="reader-nav">
              <button
                title={prev ? t("panels.reader.prev.title", { name: cardLabel(prev) }) : t("panels.reader.first")}
                aria-label={t("panels.reader.prev")}
                disabled={!prev}
                onClick={() => jump(index - 1)}
              >
                <UI.prev {...ICON_SM} />
              </button>
              <span className="rn-count" title={t("panels.reader.progress.title")}>
                <b>{index + 1}</b> / {total}
              </span>
              <button
                title={next ? t("panels.reader.next.title", { name: cardLabel(next) }) : t("panels.reader.last")}
                aria-label={t("panels.reader.next")}
                disabled={!next}
                onClick={() => jump(index + 1)}
              >
                <UI.next {...ICON_SM} />
              </button>
            </div>
          ) : null}
          <span className="foot-spacer" />
          {total > 1 ? (
            <button
              className={`ro-toggle${outline ? " on" : ""}`}
              title={outline ? t("panels.reader.outline.hide") : t("panels.reader.outline.show")}
              aria-pressed={outline}
              onClick={() => setOutline((value) => !value)}
            >
              <UI.outline {...ICON_SM} /> {t("panels.reader.outline")}
            </button>
          ) : null}
          <button
            className={`ro-toggle${skipped ? " on" : ""}`}
            data-act="skip"
            title={skipped ? t("panels.reader.skip.off.title") : t("panels.reader.skip.on.title")}
            aria-pressed={skipped}
            onClick={() => void toggleSkip()}
          >
            {skipped ? <UI.eye {...ICON_SM} /> : <UI.eyeOff {...ICON_SM} />}
            {skipped ? t("panels.reader.skip.off") : t("panels.reader.skip.on")}
          </button>
          {/* 这张卡里嵌了别人的页面：键盘只能归一边，把归属摆到明面上让用户自己选 */}
          {embedded ? (
            <button
              className={`ro-toggle${keysToEmbed ? " on" : ""}`}
              data-act="keys"
              title={keysToEmbed ? t("panels.reader.keys.toEmbed.title") : t("panels.reader.keys.toReader.title")}
              aria-pressed={keysToEmbed}
              onClick={() => setKeysToEmbed((value) => !value)}
            >
              <UI.keyboard {...ICON_SM} /> {keysToEmbed ? t("panels.reader.keys.page") : t("panels.reader.keys.card")}
            </button>
          ) : null}
          {zoomable ? (
            <div className="scope-switch">
              <button
                title={t("panels.reader.zoomOut")}
                disabled={zoom <= ZOOM_MIN + 0.001}
                onClick={() => setZoom((z) => nextZoom(z, -1))}
              >
                <UI.zoomOut {...ICON_SM} />
              </button>
              <button title={t("panels.reader.zoomActual")} onClick={reset}>
                {Math.round(zoom * 100)}%
              </button>
              <button
                title={t("panels.reader.zoomIn")}
                disabled={zoom >= ZOOM_MAX - 0.001}
                onClick={() => setZoom((z) => nextZoom(z, 1))}
              >
                <UI.zoomIn {...ICON_SM} />
              </button>
            </div>
          ) : null}
          {hint ? <span className="hint">{hint}</span> : null}
          <button
            className={`ro-toggle${full ? " on" : ""}`}
            data-act="fullscreen"
            title={full ? t("panels.reader.full.exit.title") : t("panels.reader.full.enter.title")}
            aria-pressed={full}
            onClick={toggleFull}
          >
            {full ? <UI.fullscreenExit {...ICON_SM} /> : <UI.fullscreen {...ICON_SM} />}
            {full ? t("panels.reader.full.exit") : t("panels.reader.full")}
          </button>
          <button className="drawer-close" title={t("panels.closeEsc")} onClick={close}>
            <UI.close {...ICON_MD} />
          </button>
        </div>

        <div className="reader-main">
          {outline && total > 1 ? (
            <nav className="reader-outline" aria-label={t("panels.reader.order")}>
              <div className="ro-head">
                {t("panels.reader.order")}
                {partial ? <span className="ro-chip">{t("panels.reader.filteredOnly")}</span> : null}
              </div>
              <div className="ro-list">
                {sequence.map((item, at) => {
                  const ItemIcon = typeIcon(item.type);
                  const current = at === index;
                  // 框是一章的标题，框里的卡缩进挂在它下面——目录因此有了层级，
                  // 而序列本身还是一条直线（readingOrder 已经把成员排在它的框后面）
                  const chapterHead = item.type === "frame";
                  const inChapter = chapters.has(item.id);
                  return (
                    <button
                      key={item.id}
                      ref={current ? activeRef : undefined}
                      className={`ro-item${current ? " on" : ""}${chapterHead ? " chapter" : ""}${inChapter ? " nested" : ""}`}
                      title={cardLabel(item)}
                      onClick={() => jump(at)}
                    >
                      <span className="ro-idx">{at + 1}</span>
                      <ItemIcon size={13} strokeWidth={1.8} />
                      <span className="ro-title">{cardLabel(item)}</span>
                      {item.reading?.skip ? <span className="ro-chip">{t("panels.reader.skipped")}</span> : null}
                    </button>
                  );
                })}
              </div>
            </nav>
          ) : null}

          <div
            ref={bodyRef}
            className={`reader-body${zoomable ? " zoomable" : ""}`}
            style={{ ["--card-accent" as string]: COLORS[card.color] }}
            onDoubleClick={zoomable ? reset : undefined}
            onPointerDown={
              zoomable
                ? (event) => {
                    dragging.current = { x: event.clientX - offset.x, y: event.clientY - offset.y };
                    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
                  }
                : undefined
            }
            onPointerMove={
              zoomable
                ? (event) => {
                    if (!dragging.current) return;
                    setOffset({ x: event.clientX - dragging.current.x, y: event.clientY - dragging.current.y });
                  }
                : undefined
            }
            onPointerUp={zoomable ? () => (dragging.current = null) : undefined}
          >
            <div
              className={`reader-stage${card && FIXED_STAGE.has(card.type) ? " fixed" : ""}`}
              style={zoomable ? { transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` } : undefined}
            >
              <ReaderContent card={card} />
            </div>
          </div>

          {/* 翻页按钮浮在正文两侧，而不是放进 .reader-body：
              body 上挂着缩放卡片的拖拽手势，按钮混在里面会被当成一次拖动。
              嵌了别人页面时它们还兼着「键盘归了页面也照样能翻卡」的退路。 */}
          {prev ? (
            <button
              className="reader-edge prev"
              title={t("panels.reader.prev.title", { name: cardLabel(prev) })}
              aria-label={t("panels.reader.prev")}
              onClick={() => jump(index - 1)}
            >
              <UI.prev size={24} strokeWidth={1.7} />
            </button>
          ) : null}
          {next ? (
            <button
              className="reader-edge next"
              title={t("panels.reader.next.title", { name: cardLabel(next) })}
              aria-label={t("panels.reader.next")}
              onClick={() => jump(index + 1)}
            >
              <UI.next size={24} strokeWidth={1.7} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 按钮 / +- 换到下一档。
 *
 * 不是「按下标 ±1」：当前值可能是滚轮或捏合留下的任意数（比如 137%），
 * 那时候要的是**严格更大 / 更小的第一档**——从 137% 按一下缩小该落到 125%，
 * 而不是先跳到 150% 再往下。两头到底就停在上下限上。
 */
function nextZoom(current: number, direction: 1 | -1): number {
  const epsilon = 0.001;
  if (direction === 1) return ZOOM_STEPS.find((step) => step > current + epsilon) ?? ZOOM_MAX;
  const smaller = ZOOM_STEPS.filter((step) => step < current - epsilon);
  return smaller.length ? smaller[smaller.length - 1] : ZOOM_MIN;
}

function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

function clamp(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}

/** wheel 的位移一律换算成像素：deltaMode 0=像素 / 1=行 / 2=页 */
function wheelPixels(event: WheelEvent): { x: number; y: number } {
  const unit = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? WHEEL_PAGE_PX : 1;
  return { x: event.deltaX * unit, y: event.deltaY * unit };
}

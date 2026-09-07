"use client";

/**
 * 浏览器全屏（Fullscreen API）的一层薄封装。
 *
 * 为什么值得单独一份，而不是就地 `el.requestFullscreen()`：
 * · **Safari 至今只认 webkit 前缀**（`webkitRequestFullscreen` / `webkitFullscreenElement`），
 *   桌面 Safari 上不带兜底就是「按了没反应」；
 * · **iOS Safari 根本不给元素全屏**（只有 `<video>` 有），调用直接 reject——
 *   所以入口返回「成没成」，调用方好退回自己那套「铺满窗口」的版面，而不是傻等；
 * · `exitFullscreen()` 在不处于全屏时会 reject（Chrome 抛 TypeError），不吃掉就是
 *   控制台里一条无来由的红字；
 * · **进 / 出都是异步的**，而按钮和快捷键可以按得比它快：这份封装把并发的请求收敛成
 *   「最后一次意图说了算」（见 desired），不然真会走到「界面说着窗口、浏览器停在全屏」；
 * · 退出全屏有三条路——页面自己调、用户按 Esc、浏览器自己的界面——
 *   后两条不经过页面，所以调用方还要订阅 `fullscreenchange` 回读状态（见 onFullscreenChange），
 *   并用 `fullscreenBusy()` 把自己刚请求的那些回声筛掉。
 *
 * 使用铁律（踩过才写下来的）：**要全屏的那个元素，切换前后必须是同一个 DOM 节点**。
 * 一旦为了全屏把它搬进别的容器 / 重新挂载，节点里的 iframe 会重新加载——
 * 翻到第 7 页的 PPT 会跳回第 1 页。正确做法只有「同一个节点上加个类 + 请求全屏」。
 */

type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenEnabled?: boolean;
};

function doc(): FsDocument | null {
  return typeof document === "undefined" ? null : (document as FsDocument);
}

/**
 * 「最后一次意图说了算」的收敛器。
 *
 * 进 / 出全屏都是异步的，而按钮和快捷键可以按得比它快。这里**不排队执行每一次请求**
 * （排队会把「进 → 退 → 进」原样跑一遍，中途掠过好几个中间态，事件也跟着乱飞），
 * 而是只记住最新那一次意图：正在跑的那次结束后回头看一眼，与现状不符再补一下。
 *
 * 于是连按两下全屏的结局是确定的——最后按下的那一下就是最终状态。
 * 不这么做真会走到「界面说着窗口、浏览器停在全屏」：进全屏还没落定时按 Esc，
 * 退出打在空处（那会儿 fullscreenElement 还是 null），紧接着那次请求才生效。
 */
let desired: { el: HTMLElement | null; want: boolean } | null = null;
let running: Promise<boolean> | null = null;

/** 现在处于全屏的那个元素（没有就是 null）。 */
export function fullscreenElement(): Element | null {
  const d = doc();
  if (!d) return null;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

async function request(el: HTMLElement): Promise<void> {
  const target = el as FsElement;
  if (typeof target.requestFullscreen === "function") await target.requestFullscreen();
  else if (typeof target.webkitRequestFullscreen === "function") await target.webkitRequestFullscreen();
}

async function release(d: FsDocument): Promise<void> {
  if (typeof d.exitFullscreen === "function") await d.exitFullscreen();
  else if (typeof d.webkitExitFullscreen === "function") await d.webkitExitFullscreen();
}

async function drain(d: FsDocument): Promise<boolean> {
  while (desired) {
    const { el, want } = desired;
    desired = null;
    const current = fullscreenElement();
    // 已经是要的样子就不动手：省掉一次没必要的状态跳变（连带它那个 fullscreenchange）
    if (want ? current === el : !current) continue;
    try {
      if (want) {
        if (!el) continue;
        // 全屏的是别的元素：先退出去，`requestFullscreen` 的换人语义各家不一致
        if (current) await release(d);
        await request(el);
      } else {
        await release(d);
      }
    } catch {
      /* 被拒（不支持 / 不在用户手势里）/ 已经退出：以 fullscreenElement 为准，无可补救 */
    }
  }
  return Boolean(fullscreenElement());
}

/**
 * 把全屏状态设成 `want`，返回落定之后**实际**在不在全屏。
 *
 * 返回 false 而 want 为 true = 没进去（不支持 / 被拒 / 不在用户手势里）。
 * 调用方据此决定要不要提示，但**不必回滚自己的版面**——CSS 那层铺满窗口照样成立。
 */
export function applyFullscreen(el: HTMLElement | null, want: boolean): Promise<boolean> {
  const d = doc();
  if (!d) return Promise.resolve(false);
  desired = { el, want };
  if (running) return running;
  const run = drain(d).finally(() => {
    if (running === run) running = null;
  });
  running = run;
  return run;
}

/**
 * 还有没落定的全屏请求吗。
 *
 * 用来分辨 `fullscreenchange` 是谁造成的：忙的时候那是我们自己刚请求的回声
 * （调用方的状态早就算好了，再跟一次只会把中途那一帧当成结论）；
 * 闲的时候才是用户自己按 Esc / 点浏览器的退出按钮——那才需要跟。
 */
export function fullscreenBusy(): boolean {
  return Boolean(running);
}

/** 订阅全屏状态变化（含用户按 Esc、点浏览器自己那个退出按钮）；返回退订函数。 */
export function onFullscreenChange(handler: () => void): () => void {
  const d = doc();
  if (!d) return () => {};
  d.addEventListener("fullscreenchange", handler);
  d.addEventListener("webkitfullscreenchange", handler);
  return () => {
    d.removeEventListener("fullscreenchange", handler);
    d.removeEventListener("webkitfullscreenchange", handler);
  };
}

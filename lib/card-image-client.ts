"use client";

/**
 * 卡面图片的加载闸门：同源连接是稀缺资源，别让图片把它占光。
 *
 * 浏览器对同一个源只开 6 条 HTTP/1.1 连接。一块画廊板上十来张 2 MB 的卡面图一起开下，
 * 6 条全被占住，接下来 `GET /api/boards/:id`（切板要的那一个）只能排在图片后面——
 * 慢一点的网上实测要等 **15 秒**，用户看到的就是「图还在转，点别的画板没反应」。
 *
 * 这里做两件事：
 *
 * 1. **限流**：同时最多 {@link MAX_INFLIGHT} 张图在路上，剩下的连接永远留给应用自己的请求，
 *    所以切板、保存、轮询在任何时候都是即时的。
 * 2. **离场即取消**：卡片卸载（切板 / 划出可视区被 React Flow 摘掉）时把 `src` 摘掉。
 *    **只把 `<img>` 从 DOM 上删掉是不够的**——实测 Chrome 会把那张图默默下完、连接照占，
 *    只有 `removeAttribute("src")` 才真的取消（切到新板后新板的图能立刻开下，就靠这一条）。
 *
 * 顺带把「屏幕外先不拉」也接了过来：以前靠原生 `loading="lazy"`，但那个属性没法配合限流
 * （浏览器什么时候真开始下这张图，页面这边收不到任何回声，队列就没法放行下一张），
 * 所以改成自己用 IntersectionObserver 判断视野。行为与 lazy 一致，多了一道闸门。
 */

import { useCallback, useEffect, useRef } from "react";

/** 同时最多几张图在路上（浏览器给 6 条，留一半给应用自己的请求） */
const MAX_INFLIGHT = 3;
/** 离视野还有这么远就开始预取，滚过去时图已经在了 */
const NEAR_VIEWPORT = "400px";
/** 兜底：一张图既不 load 也不 error（极少数代理会这样吊着），到点就放行下一张，别把队列卡死 */
const STUCK_MS = 30_000;
/** 闸门还没放行 / 正在下：先不显示，免得 alt 文本在卡面上闪一下 */
const LOADING_CLASS = "img-gated";

type Phase = "idle" | "queued" | "loading" | "done";

type Entry = {
  img: HTMLImageElement;
  url: string;
  phase: Phase;
  timer: ReturnType<typeof setTimeout> | null;
  onSettle: () => void;
  /** 这张图挂在哪个观察者下（卸载时按同一个 root 取消观察） */
  root: Element | null;
};

const entries = new Map<HTMLImageElement, Entry>();
const queue: Entry[] = [];
let inflight = 0;
/**
 * 按「裁剪祖先」分组的观察者。
 *
 * 用默认 root（整个窗口）在画布上不管用：IntersectionObserver 会连祖先的 overflow 一起算，
 * 画布那层 `overflow: hidden` 把卡片裁掉之后，rootMargin 再大也扩不出去，预取就没了。
 * 所以画布里的图以 `.react-flow` 自己为 root —— 这样 {@link NEAR_VIEWPORT} 才真的
 * 是「离视野还有多远就开始拉」。抽屉 / 阅读模式里的图没有这层祖先，走默认 root。
 */
const watchers = new Map<Element | null, IntersectionObserver>();

function watcher(root: Element | null): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  const existing = watchers.get(root);
  if (existing) return existing;
  const created = new IntersectionObserver(
    (records) => {
      for (const record of records) {
        const entry = entries.get(record.target as HTMLImageElement);
        // 只在「进视野」这一侧动手：划出去的不打断（半截下载丢了要从头再来，
        // 来回拖几下画布就成了反复重下），限流本来就压着并发
        if (entry && record.isIntersecting) enqueue(entry);
      }
    },
    { root, rootMargin: NEAR_VIEWPORT },
  );
  watchers.set(root, created);
  return created;
}

function enqueue(entry: Entry): void {
  if (entry.phase !== "idle") return;
  entry.phase = "queued";
  queue.push(entry);
  pump();
}

function pump(): void {
  while (inflight < MAX_INFLIGHT) {
    const next = queue.shift();
    if (!next) return;
    if (next.phase !== "queued") continue;
    next.phase = "loading";
    inflight += 1;
    next.timer = setTimeout(() => settle(next), STUCK_MS);
    next.img.src = next.url;
  }
}

/** 这张图有结果了（成功 / 失败 / 吊死到点）：让出名额 */
function settle(entry: Entry): void {
  if (entry.phase !== "loading") return;
  entry.phase = "done";
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  inflight -= 1;
  pump();
}

/** 这张图不要了（卸载 / 换了 url）：在途的当场取消，排队的直接出队 */
function release(entry: Entry): void {
  if (entry.phase === "queued") {
    const at = queue.indexOf(entry);
    if (at >= 0) queue.splice(at, 1);
    entry.phase = "idle";
    return;
  }
  if (entry.phase !== "loading") return;
  // 关键的一行：光卸载 <img> 不取消下载，摘掉 src 才取消
  entry.img.removeAttribute("src");
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  entry.phase = "idle";
  inflight -= 1;
  pump();
}

function attach(img: HTMLImageElement, url: string): void {
  const entry: Entry = { img, url, phase: "idle", timer: null, onSettle: () => {}, root: img.closest(".react-flow") };
  entry.onSettle = () => {
    settle(entry);
    img.classList.remove(LOADING_CLASS);
  };
  entries.set(img, entry);
  img.classList.add(LOADING_CLASS);
  img.addEventListener("load", entry.onSettle);
  img.addEventListener("error", entry.onSettle);
  const io = watcher(entry.root);
  // 没有 IntersectionObserver 的环境（老浏览器 / 测试桩）就不做视野判断，只保留限流
  if (io) io.observe(img);
  else enqueue(entry);
}

function detach(img: HTMLImageElement): void {
  const entry = entries.get(img);
  if (!entry) return;
  watcher(entry.root)?.unobserve(img);
  img.removeEventListener("load", entry.onSettle);
  img.removeEventListener("error", entry.onSettle);
  release(entry);
  entries.delete(img);
  img.classList.remove(LOADING_CLASS);
}

/**
 * 把一张卡面图交给闸门管：`<img ref={useCardImage(url)} … />`，**不要再写 `src`**
 * （src 由闸门在轮到它的时候发下去；写了 JSX src 就等于绕过闸门）。
 */
export function useCardImage(url: string | null | undefined): (node: HTMLImageElement | null) => void {
  const node = useRef<HTMLImageElement | null>(null);
  const target = useRef<string>(url || "");
  target.current = url || "";

  const ref = useCallback((next: HTMLImageElement | null) => {
    if (node.current === next) return;
    if (node.current) detach(node.current);
    node.current = next;
    if (next && target.current) attach(next, target.current);
  }, []);

  // url 变了（比如手绘卡改完，v= 哈希跟着变）：旧的取消，新的重新排队
  useEffect(() => {
    const img = node.current;
    if (!img) return;
    const current = entries.get(img);
    if (current && current.url === (url || "")) return;
    detach(img);
    if (url) attach(img, url);
  }, [url]);

  // 卸载（切板 / 划出可视区）：在途的下载当场取消，把连接还给应用
  useEffect(() => () => {
    if (node.current) detach(node.current);
    node.current = null;
  }, []);

  return ref;
}

/** 只给测试用：看闸门当前放了几张图上路、还有几张在排队 */
export function cardImageQueueState(): { inflight: number; queued: number; max: number } {
  return { inflight, queued: queue.length, max: MAX_INFLIGHT };
}

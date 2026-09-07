"use client";

/**
 * SVG 卡 / Mermaid 卡的渲染。
 *
 * SVG 走 `<img src="data:image/svg+xml,…">`：图片上下文本来就不执行脚本，
 * 比把外来 SVG 直接 innerHTML 进 DOM 安全得多（服务端还会再剥一层，见 normalizeSvgField）。
 * Mermaid 按需 import——那个包近 3MB，没有图表卡的板不该为它买单。
 */
import { useEffect, useRef, useState } from "react";
import { sceneRev } from "@/lib/excalidraw-scene";
import { useBoardStore } from "@/lib/store";
import { useT } from "@/lib/i18n/client";

export function SvgCard({ source }: { source: string }) {
  const t = useT();
  if (!source) return <span className="placeholder">{t("cards.svg.empty")}</span>;
  return (
    <div className="diagram-wrap">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="diagram-img" src={`data:image/svg+xml;utf8,${encodeURIComponent(source)}`} alt={t("cards.svg.alt")} draggable={false} />
    </div>
  );
}

let mermaidReady: Promise<typeof import("mermaid").default> | null = null;

function loadMermaid() {
  if (!mermaidReady) {
    mermaidReady = import("mermaid").then((module) => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "neutral",
        fontFamily: "inherit",
      });
      return mermaid;
    });
  }
  return mermaidReady;
}

let renderSeq = 0;

/**
 * 渲染结果按**源码**缓存。
 *
 * 一是同一张图重新挂载时不必再渲染一遍——大板上开了「只渲染可视区」，
 * 卡片划出屏幕会卸载、划回来又挂载，没有缓存的话每次都要重跑一次 mermaid；
 * 二是同一份图表在阅读模式和卡面上各渲染一次，本来也是白跑。
 */
const mermaidCache = new Map<string, { svg: string } | { error: string }>();
const MERMAID_CACHE_MAX = 64;

function rememberMermaid(source: string, value: { svg: string } | { error: string }): void {
  if (mermaidCache.size >= MERMAID_CACHE_MAX) {
    const oldest = mermaidCache.keys().next().value;
    if (oldest !== undefined) mermaidCache.delete(oldest);
  }
  mermaidCache.set(source, value);
}

export function MermaidCard({ source, cardId }: { source: string; cardId: string }) {
  const t = useT();
  const cached = mermaidCache.get(source);
  const [svg, setSvg] = useState(cached && "svg" in cached ? cached.svg : "");
  const [error, setError] = useState<string | null>(cached && "error" in cached ? cached.error : null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!source.trim()) {
      setSvg("");
      setError(null);
      return;
    }
    const hit = mermaidCache.get(source);
    if (hit) {
      setSvg("svg" in hit ? hit.svg : "");
      setError("error" in hit ? hit.error : null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const mermaid = await loadMermaid();
        renderSeq += 1;
        const { svg: out } = await mermaid.render(`mmd-${cardId}-${renderSeq}`, source);
        rememberMermaid(source, { svg: out });
        if (!cancelled && alive.current) {
          setSvg(out);
          setError(null);
        }
      } catch (err) {
        // mermaid 的报错第一行就点出哪一行语法不对，够用户改了
        const message = String((err as Error)?.message || err).split("\n").slice(0, 3).join("\n");
        rememberMermaid(source, { error: message });
        if (!cancelled && alive.current) {
          setSvg("");
          setError(message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, cardId]);

  if (!source.trim()) return <span className="placeholder">{t("cards.mermaid.empty")}</span>;
  if (error) return <pre className="diagram-error">{error}</pre>;
  if (!svg) return <span className="placeholder">{t("cards.mermaid.rendering")}</span>;
  return <div className="diagram-wrap" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * Excalidraw 卡面。
 *
 * 优先用保存时回写的 PNG 缩略图（编辑器里那次导出字体是齐的，最准）；
 * 没有缩略图但有 source 时——比如 JSON 是从别处粘进来的、或者上个版本存下的——
 * 就地把 .excalidraw 场景渲染成 PNG 顶上，不再让卡面空着只写一句「双击重新保存」。
 *
 * 渲染仍然走官方 exportToBlob（canvas），不把场景里的东西塞进 DOM：
 * 那份 JSON 可能带图片 dataURL / 外链，canvas 里没有执行上下文，最省心。
 */
/**
 * 手绘卡的卡面：一张 `<img>`，图由服务端按场景现渲（`/api/…/cards/:id/drawing`）。
 *
 * 以前这里是浏览器现场干的活——动态 import 官方 Excalidraw（约 345 KB）再 exportToBlob。
 * 一块 76 张手绘卡的板每次打开都要为此多下几百 KB、主线程再堵三百多毫秒，
 * 而这些卡九成没进过编辑器、连缩略图都没有，等于每个人每次开板都替 agent 重画一遍。
 * 服务端那支笔（roughjs，跟排版导出同一条路）画完就进浏览器缓存，第二次开板零成本；
 * 渲不出来的场景（比如只有图片元素）由服务端退回那张存过的缩略图，前端不用管。
 */
export function ExcalidrawThumb({ source, cardId }: { source: string; cardId: string }) {
  const t = useT();
  const boardId = useBoardStore((state) => state.boardId);
  // 服务端也画不出来：退回占位，别留一个破图标
  const [broken, setBroken] = useState("");

  if (!source.trim()) return <span className="placeholder">{t("cards.excalidraw.empty")}</span>;
  if (!boardId || broken === source) {
    return (
      <div className="diagram-wrap excalidraw-thumb excalidraw-stale">
        <span className="placeholder">{t("cards.excalidraw.broken")}</span>
      </div>
    );
  }
  // v= 是源码的哈希：画一改哈希就变、URL 就变，所以那张图可以按 immutable 缓存
  const url = `/api/boards/${encodeURIComponent(boardId)}/cards/${encodeURIComponent(cardId)}/drawing?v=${sceneRev(source)}`;
  return (
    <div className="diagram-wrap excalidraw-thumb">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="diagram-img"
        src={url}
        alt={t("cards.excalidraw.alt")}
        draggable={false}
        /* 屏幕外的卡先不拉图：一块 76 张手绘卡的板，一进来只有十来张在视野里，
           其余的等滚过去再拿（大板本来就开着「只渲染可视区」，两者正好对上） */
        loading="lazy"
        decoding="async"
        onError={() => setBroken(source)}
      />
    </div>
  );
}

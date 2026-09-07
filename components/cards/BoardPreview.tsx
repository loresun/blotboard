"use client";

/**
 * 子画板卡的缩略图：左边一张**结构地图**（缩着画的卡片位置、颜色、连线），
 * 右边一列**代表内容**（按阅读顺序取前几张卡的标题，正常字号）。
 *
 * 为什么是两栏，而不是把整块板整个塞进预览区缩小（那是这张卡以前的样子）：
 *
 * 1. **长宽比不匹配才是主因**。卡面的预览区是宽扁的（290×240 的卡上约 262×156），
 *    而子板多半是竖的（实测一批真板：0.63 ~ 1.81，多数不到 1）。整块板 `meet` 进去，
 *    缩放由高度决定，宽度只用掉四分之一——左右一片空白，卡片缩成火柴盒。
 *    所以地图那栏的**宽度按目标板的长宽比反算**（`splitFor`）：板有多竖它就有多窄，
 *    省下的宽度让给读得出的字。同一批真板改完填充率是 99%~100%。
 * 2. **一两个字的标题不是信息，是噪点**。地图上的卡片只有十几像素宽时，
 *    「21…」「全 …」既读不出内容又糊住结构，不如干脆不画（`LABEL_MIN_W/H` /
 *    `LABEL_MIN_CHARS`）——分工是死的：**地图只讲结构，标题只在右栏讲**，
 *    同一句话不写两遍。窄到放不下右栏时地图才接管标题，那时候卡片也够大了。
 * 3. 剩下的极端形状（长宽比 0.1 那种一列到底的板）怎么摆都填不满，才**动裁刀**
 *    （`frameFor`，最多放大到「全装下」的 2.2 倍，即至少露出长边的 45%），
 *    裁切贴着左上角（版面从左上开始读），并在角上给一个**全景开关**——
 *    裁掉的东西一按就回来，不是偷偷藏掉。
 *
 * 只拉 /preview（几何 + 颜色 + 标题，不带正文），结果缓存在 store，
 * 同一块板被多张子画板卡引用只请求一次；右栏的标题复用同一份数据，不多打一次接口。
 * 上千张卡的板只画前 `MAX_SHAPES` 个形状——再多也落在同一个像素上。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { COLORS } from "@/lib/constants";
import { readingOrder } from "@/lib/layout";
import { ICON_SM, typeIcon, UI } from "@/lib/icons";
import { useBoardStore } from "@/lib/store";
import { useCardLabel, useT } from "@/lib/i18n/client";
import type { BoardPreviewCard } from "@/lib/types";

const PAD = 60;
const LABEL_PX = 11;
/** 卡片在屏幕上窄于这个宽度（或矮于对应高度）就不画标题——画了也读不出，只剩噪点 */
const LABEL_MIN_W = 66;
const LABEL_MIN_H = 16;
/** 一个 CJK 字大致占一个字号宽；按这个估能塞几个字，宁可少估也别溢出 */
const CJK_RATIO = 1.02;
/** 少于这么多字就别画了：「全 …」这种残标题比空白更难看 */
const LABEL_MIN_CHARS = 4;
/**
 * 裁多少：**默认不裁**。整块板装进去之后短边还剩多少没填满（`fill`），
 * 低于 `MIN_FILL` 才裁，而且只裁到刚好够到 `MIN_FILL`——「填满」不值得拿「看不全」去换，
 * 所以先把栏宽调窄（splitFor），实在还差得远才动裁刀。`MAX_ZOOM_OVER_FIT` 是硬上限：
 * 再怎么样也至少露出长边的 45%，否则看到的已经不是这块板了。
 */
const MIN_FILL = 0.62;
const MAX_ZOOM_OVER_FIT = 2.2;
/**
 * 裁切还有一道闸：整块板装进去时，一张卡在屏幕上已经有这么宽了就**不裁**。
 * 卡片本来就看得见的板（五张卡的横板），裁掉两张换来「填满」是亏的——
 * 该裁的是「一百张卡挤成一片针尖」那种，裁完才分得出块。
 */
const CROP_BLOCK_PX = 26;
/** 地图那栏再窄就看不出结构了 */
const MAP_MIN_W = 72;
/**
 * 右栏窄于这个宽度就别要了——放不下一个词的列表不如把地方还给地图。
 * 108 是量出来的：减去色条 + 类型图标 + 两处间距（23px），还剩 7 个汉字，
 * 够认出「这是讲什么的一张卡」；再窄就只剩两三个字加省略号，又变回噪点了。
 */
const DIGEST_MIN_W = 108;
const DIGEST_GAP = 8;
const DIGEST_ROW_H = 19;
const DIGEST_MAX_ROWS = 10;
/** 上千张卡的板也只画这么多形状：缩略图看的是分布，多画的那些落在同一个像素上 */
const MAX_SHAPES = 600;

type Box = { w: number; h: number };
type World = { x: number; y: number; w: number; h: number };

/** 世界坐标里的取景框：跟视口同长宽比，所以 SVG 里不会有第二次缩放 */
type Frame = World & { scale: number; cropped: boolean };

/**
 * 取景：默认整块板全装下；只有「装下之后短边填不到 MIN_FILL，且卡片已经小到看不出块」
 * 才裁，而且只裁到刚好够到 MIN_FILL。裁的那一边贴着起点（上 / 左），版面是从左上开始读的。
 */
function frameFor(world: World, box: Box, crop: { allowed: boolean; blockW: number }): Frame {
  const fit = Math.min(box.w / world.w, box.h / world.h);
  const cover = Math.max(box.w / world.w, box.h / world.h);
  // fill = 整块板装进去之后，短边填满了取景框的几成
  const fill = cover > 0 ? fit / cover : 1;
  const worth = crop.allowed && fill < MIN_FILL && crop.blockW * fit < CROP_BLOCK_PX;
  const zoom = worth ? Math.min(MIN_FILL / fill, MAX_ZOOM_OVER_FIT) : 1;
  const scale = Math.max(Math.min(cover, fit * zoom), Number.MIN_VALUE);
  const w = box.w / scale;
  const h = box.h / scale;
  return {
    x: w < world.w ? world.x : world.x + (world.w - w) / 2,
    y: h < world.h ? world.y : world.y + (world.h - h) / 2,
    w,
    h,
    scale,
    cropped: w < world.w - 0.5 || h < world.h - 0.5,
  };
}

/** 整块板装进这个框之后，短边填满了几成——0.9 以上肉眼就看不出空边了 */
function fillOf(world: World, box: Box): number {
  const fit = Math.min(box.w / world.w, box.h / world.h);
  const cover = Math.max(box.w / world.w, box.h / world.h);
  return cover > 0 ? fit / cover : 1;
}

/**
 * 分栏：地图那栏的宽度**按目标板的长宽比反算**——板越竖它越窄，省下的宽度让给右栏的标题。
 *
 * 右栏不是白拿的：它从地图身上割走一块宽度。所以决定权交给一句话——
 * **「割完之后地图还填得满吗」**。
 * · 竖板：地图本来就只要一条窄栏，割完照样填满 → 右栏留着。
 * · 横板：地图横着要的比整个预览区还宽，再割就只能靠裁切补 → 右栏让位，
 *   地图占满整宽；这时候卡片在屏幕上够大了，标题直接画在地图里。
 * 判据里的 `Math.min(MIN_FILL, ...)` 是给「怎么摆都填不满的极端竖板」留的活口：
 * 它宽着摆更填不满，那就没有理由为了填充率把右栏也砍掉。
 */
function splitFor(world: World, box: Box): { mapW: number; digest: boolean } {
  const wanted = box.h * (world.w / world.h);
  const cap = box.w - DIGEST_MIN_W - DIGEST_GAP;
  const squeezed = Math.round(Math.max(MAP_MIN_W, Math.min(wanted, cap)));
  const digest =
    cap >= MAP_MIN_W && fillOf(world, { w: squeezed, h: box.h }) >= Math.min(MIN_FILL, fillOf(world, box));
  return { mapW: digest ? squeezed : box.w, digest };
}

function worldOf(cards: BoardPreviewCard[]): World {
  if (!cards.length) return { x: 0, y: 0, w: 1, h: 1 };
  const minX = Math.min(...cards.map((card) => card.x)) - PAD;
  const minY = Math.min(...cards.map((card) => card.y)) - PAD;
  const maxX = Math.max(...cards.map((card) => card.x + card.w)) + PAD;
  const maxY = Math.max(...cards.map((card) => card.y + card.h)) + PAD;
  return { x: minX, y: minY, w: Math.max(maxX - minX, 1), h: Math.max(maxY - minY, 1) };
}

export function BoardPreview({ boardId, variant = "card" }: { boardId: string; variant?: "card" | "full" }) {
  const t = useT();
  const cardLabel = useCardLabel();
  const preview = useBoardStore((state) => state.boardPreviews[boardId]);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<Box>({ w: 0, h: 0 });
  const [panorama, setPanorama] = useState(false);

  useEffect(() => {
    void useBoardStore.getState().loadBoardPreview(boardId);
  }, [boardId]);

  const cards = useMemo(() => preview?.cards || [], [preview]);
  const world = useMemo(() => worldOf(cards), [cards]);
  // 右栏与「多画了几张」都按阅读顺序取，跟阅读模式 / 大纲同一个口径
  const ordered = useMemo(() => readingOrder(cards), [cards]);
  // 中位数而不是平均：一张特别宽的镇板大图不该把「这块板的卡有多大」整体带偏
  const medianW = useMemo(() => {
    if (!cards.length) return 0;
    const widths = cards.map((card) => card.w).sort((a, b) => a - b);
    return widths[Math.floor(widths.length / 2)];
  }, [cards]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const next = { w: wrap.clientWidth, h: wrap.clientHeight };
      setBox((prev) => (Math.abs(prev.w - next.w) < 0.5 && Math.abs(prev.h - next.h) < 0.5 ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [Boolean(preview)]);

  if (preview === undefined) return <span className="placeholder">{t("cards.board.previewLoading")}</span>;
  if (preview === null) return <span className="placeholder bp-broken">{t("cards.board.previewGone")}</span>;
  if (!cards.length) return <span className="placeholder">{t("cards.board.previewEmpty")}</span>;

  // 阅读模式那种大舞台不缩栏也不裁：地方够，整块板铺开看得最清楚
  const full = variant === "full";
  const digestRows = Math.min(DIGEST_MAX_ROWS, Math.floor((box.h + 3) / DIGEST_ROW_H));
  const split = full || box.w <= 0 ? { mapW: box.w, digest: false } : splitFor(world, box);
  const showDigest = split.digest && digestRows >= 2;
  const mapW = showDigest ? split.mapW : box.w;
  const frame = frameFor(
    world,
    { w: Math.max(mapW, 1), h: Math.max(box.h, 1) },
    { allowed: !full && !panorama, blockW: medianW },
  );
  const scale = frame.scale;

  // 字号按缩放反算：缩得越小，世界坐标里的字号越大，屏幕上保持恒定
  const fontSize = LABEL_PX / scale;
  const stroke = 1.5 / scale;
  const shapes = cards.length > MAX_SHAPES ? ordered.slice(0, MAX_SHAPES) : cards;
  const edges = preview.edges.slice(0, MAX_SHAPES);
  // 取景框外还剩多少张——全景开关的提示语要说清楚按下去能多看到什么
  const outside = frame.cropped
    ? cards.filter(
        (card) =>
          card.x + card.w < frame.x ||
          card.x > frame.x + frame.w ||
          card.y + card.h < frame.y ||
          card.y > frame.y + frame.h,
      ).length
    : 0;

  // 右栏已经用正常字号列了标题，地图再写一遍就是同一句话说两次——
  // 何况取景框边上那半张卡会把字裁成「连线」这种残句。分工清楚：地图只讲结构。
  const showLabels = !showDigest;
  const digestItems = showDigest ? ordered.slice(0, digestRows - (ordered.length > digestRows ? 1 : 0)) : [];
  const rest = ordered.length - digestItems.length;
  const panoramaLabel = panorama
    ? t("cards.board.previewFocus")
    : outside > 0
      ? t("cards.board.previewPanoramaMore", { count: outside })
      : t("cards.board.previewPanorama");

  return (
    <div className="board-preview-wrap" ref={wrapRef} data-variant={variant}>
      <div className="bp-map" style={full ? undefined : { flex: `0 0 ${mapW}px` }}>
        <svg
          className="board-preview"
          viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`}
          preserveAspectRatio="xMidYMid meet"
          aria-label={t("cards.board.previewAria", { name: preview.name })}
        >
          {edges.map((edge, index) => (
            <line
              key={index}
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              className="bp-edge"
              strokeWidth={stroke * 1.4}
            />
          ))}
          {shapes.map((card) => {
            const accent = COLORS[card.color] || COLORS.slate;
            // 这张卡此刻在屏幕上有多大——画不画字、画多大字都看它
            const screenW = card.w * scale;
            const screenH = card.h * scale;
            // 字号再受卡片高度封顶：宁可字小一点，也不让它戳出卡片外面
            const size = Math.min(fontSize, card.h * 0.34);
            const pad = size * 0.6;
            const barW = Math.max(card.w * 0.02, size * 0.4);
            const inner = card.w - barW - pad * 2;
            const maxChars = Math.floor(inner / (size * CJK_RATIO));
            // 卡片被取景框切掉一角时也不写字：半截词比不写更难看
            const whole =
              card.x >= frame.x &&
              card.y >= frame.y &&
              card.x + card.w <= frame.x + frame.w &&
              card.y + card.h <= frame.y + frame.h;
            const readable =
              showLabels &&
              whole &&
              screenW >= LABEL_MIN_W &&
              screenH >= LABEL_MIN_H &&
              maxChars >= LABEL_MIN_CHARS;
            const label = !readable || !card.title
              ? ""
              : card.title.length > maxChars
                ? `${card.title.slice(0, Math.max(1, maxChars - 1))}…`
                : card.title;
            return (
              <g key={card.id}>
                {/* 缩略图上的字必然要截断，完整标题挂在这里：鼠标停一下就看得到（<title> 要放在首位） */}
                {card.title ? <title>{card.title}</title> : null}
                <rect
                  x={card.x}
                  y={card.y}
                  width={card.w}
                  height={card.h}
                  rx={Math.min(size, card.h * 0.18)}
                  className="bp-card"
                  strokeWidth={stroke}
                />
                {/* 左侧那条色条跟真卡片上的一样，一眼看出类型/配色 */}
                <rect x={card.x} y={card.y} width={barW} height={card.h} rx={barW * 0.4} fill={accent} />
                {label ? (
                  <text
                    x={card.x + barW + pad}
                    y={card.y + Math.min(pad + size * 0.9, card.h * 0.62)}
                    className="bp-title"
                    fontSize={size}
                  >
                    {label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {frame.cropped || panorama ? (
          <button
            type="button"
            className="bp-zoom nodrag"
            title={panoramaLabel}
            aria-label={panoramaLabel}
            aria-pressed={panorama}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              setPanorama((prev) => !prev);
            }}
          >
            {panorama ? <UI.fullscreenExit {...ICON_SM} /> : <UI.fullscreen {...ICON_SM} />}
          </button>
        ) : null}
      </div>
      {showDigest ? (
        <ul className="bp-digest" aria-label={t("cards.board.previewDigest")}>
          {digestItems.map((card) => {
            const Icon = typeIcon(card.type);
            const title = card.title || cardLabel(card.type);
            return (
              <li key={card.id} title={title}>
                <i className="bp-dot" style={{ background: COLORS[card.color] || COLORS.slate }} />
                <Icon size={12} strokeWidth={1.9} />
                <span>{title}</span>
              </li>
            );
          })}
          {rest > 0 ? <li className="bp-more">{t("cards.board.previewRest", { count: rest })}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

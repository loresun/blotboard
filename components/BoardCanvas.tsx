"use client";

/**
 * 画布主体（React Flow）。
 *
 * 交互对齐 goal-agent 版画板：
 *  · 滚轮平移 / ⌘+滚轮缩放 · 双击空白建卡 · 双击卡片编辑
 *  · 拖锚点连线，拖到空白 → 衍生一张新文本卡并自动连线
 *  · 选中连线出标签工具条 · Delete 删卡 · 拖文件 / 粘贴入卡
 * 位置与尺寸由 React Flow 托管，拖完 / 缩放完才回写 store 并防抖落库。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  SelectionMode,
  applyNodeChanges,
  useReactFlow,
  useStoreApi,
  useUpdateNodeInternals,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnectEnd,
  type Viewport as RFViewport,
} from "@xyflow/react";
import { CardNode, type CardNodeData } from "./cards/CardNode";
import type { CardPatch } from "./cards/CardEditor";
import type { CardAction } from "./cards/CardBody";
import { FloatingEdge } from "./FloatingEdge";
import { EdgeToolbar } from "./EdgeToolbar";
import { boardEditSignature } from "@/lib/history-content";
import { boardAgentPrompt, browserAgentPrompt } from "@/lib/agent-onboarding";
import { copyText } from "@/lib/copy-text";
import { boardOrigin } from "@/lib/origins";
import { ContextMenu, type MenuItem, type MenuState } from "./ContextMenu";
import { CommentLayer } from "./CommentLayer";
import AlignGuides from "./AlignGuides";
import { KeyboardHelp } from "./KeyboardHelp";
import { SafeNodeToolbar } from "./SafeNodeToolbar";
import { canvasFitPadding } from "./canvas-fit";
import { boardKeyBlocked, historyShortcut } from "@/lib/keyboard-shortcuts";
import {
  CARD_SIZE_LIMITS,
  COLORS,
  COMPARE_MAX,
  EDGE_KIND_HINT_KEY,
  EDGE_KIND_LABEL_KEY,
  SNAP_GRID,
  TYPE_META,
  ZOOM_MAX,
  ZOOM_MIN,
} from "@/lib/constants";
import { cardLabel, type DictKey } from "@/lib/i18n";
import { currentLocale, tr, useT } from "@/lib/i18n/client";
import { CARD_COLORS as COLOR_KEYS } from "@/lib/types";
import { featureOn, taskBackendKind } from "@/lib/features-client";
import { browserStorageActive, browserWorkspace } from "@/lib/storage-mode";
import { TYPE_ICON, UI } from "@/lib/icons";
import {
  ALIGN_SNAP_TOLERANCE,
  computeAlignSnap,
  computeResizeSnap,
  frameSnapTargets,
  sameGuides,
  type AlignGuide,
  type SnapRect,
} from "@/lib/align-snap";
import { alignCards, type AlignAction } from "@/lib/layout";
import { cardMatches, focusSetOf, openCommentCount, readingSequence, useBoardStore } from "@/lib/store";
import { frameCandidateIds } from "@/lib/frames";
import { EDGE_KINDS, type BoardCard, type CardColor, type CardType, type EdgeKind } from "@/lib/types";

const ALIGN_LABEL: Record<AlignAction, DictKey> = {
  left: "canvas.align.left",
  hcenter: "canvas.align.hcenter",
  right: "canvas.align.right",
  top: "canvas.align.top",
  vcenter: "canvas.align.vcenter",
  bottom: "canvas.align.bottom",
  hspace: "canvas.align.hspace",
  vspace: "canvas.align.vspace",
};

/**
 * 事件回调里取卡片类型名。右键菜单是在 contextmenu 回调里现拼的，那儿没有 hook 可用——
 * 跟 tr() 同一个套路：语言从 body.dataset 读，与渲染那一遍拿到的是同一个值。
 */
function typeLabel(type: CardType): string {
  return cardLabel(currentLocale(), type);
}

const nodeTypes = { card: CardNode };
const edgeTypes = { floating: FloatingEdge };

/** 没有任务卡的板上，所有卡片共用这一个空关联对象，引用恒定 → 节点可整体复用 */
const EMPTY_RELATED: { up: BoardCard[]; down: BoardCard[] } = { up: [], down: [] };

/* ── 分组框：画布这一侧的三件事 ─────────────────────
   数据上「谁在框里」只有一处真源——子卡身上的 `frameId`（见 lib/board-service.ts）。
   画布要把它翻译成 React Flow 的父子节点，再把拖动结果翻译回绝对坐标。 */

/**
 * 落点判定：这个点落在哪个框里？重叠时取**最小的那个**（小框在大框上面，直觉如此）。
 *
 * 为什么不用 React Flow 的 `extent: "parent"`：那个开关会把子节点**锁死在父框内**，
 * 于是「把卡拖出框 = 解除归属」这条路直接没了——而那正是分组框必须有的退出手势。
 * 改成落点判定之后，拖进去就归属、拖出来就解除，进出都是同一个动作，也不用记菜单在哪。
 */
function frameAtPoint(cards: BoardCard[], x: number, y: number): string | null {
  let hit: BoardCard | null = null;
  for (const card of cards) {
    if (card.type !== "frame") continue;
    if (x < card.x || x > card.x + card.w || y < card.y || y > card.y + card.h) continue;
    if (!hit || card.w * card.h < hit.w * hit.h) hit = card;
  }
  return hit?.id || null;
}

/** 子节点的 position 是**相对父框**的；我们落库的是画布绝对坐标，回写前换算回来。 */
function absoluteOf(node: Node<CardNodeData>, byId: Map<string, BoardCard>): { x: number; y: number } {
  const parent = node.parentId ? byId.get(node.parentId) : null;
  return parent
    ? { x: node.position.x + parent.x, y: node.position.y + parent.y }
    : { x: node.position.x, y: node.position.y };
}

/**
 * 框动了，框里的卡跟着动。
 *
 * React Flow 拖父节点时，子节点是靠「相对坐标不变」自然跟过去的，它们自己**没有**位置变更事件；
 * 而我们存的是绝对坐标——不补这一刀，刷新之后框回到新位置、卡还留在原地。
 * 已经在这一批里的子卡跳过（框和子卡一起多选拖动时，别把位移算两遍）。
 */
function withFrameFollowers(
  entries: { id: string; x: number; y: number; z?: number }[],
  cards: BoardCard[],
): { id: string; x: number; y: number; z?: number }[] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const moved = new Set(entries.map((entry) => entry.id));
  const extra: { id: string; x: number; y: number }[] = [];
  for (const entry of entries) {
    const frame = byId.get(entry.id);
    if (frame?.type !== "frame") continue;
    const dx = entry.x - frame.x;
    const dy = entry.y - frame.y;
    if (!dx && !dy) continue;
    for (const child of cards) {
      if (child.frameId !== frame.id || moved.has(child.id)) continue;
      extra.push({ id: child.id, x: child.x + dx, y: child.y + dy });
    }
  }
  return extra.length ? [...entries, ...extra] : entries;
}

/**
 * 吸附参照物：视口里**看得见**的卡片，正在动的那些除外。拖动与缩放共用。
 *
 * 只挑看得见的，是因为吸过去的参考线要落在视野之内——线在屏幕外，人只会觉得卡片自己跳了一下。
 * `carried` 说的是「框里的卡是否跟着框一起动」：拖框时它们跟着走，数据里却还是旧位置，
 * 拿旧位置当参照会把框吸歪；拉框的边时它们留在原地，正好可以当参照。
 */
function visibleSnapTargets(
  cards: BoardCard[],
  byId: Map<string, BoardCard>,
  view: { x: number; y: number; w: number; h: number },
  bounds: SnapRect,
  moving: Set<string>,
  options: { carried: boolean; movingFrame: boolean },
): SnapRect[] {
  const targets: SnapRect[] = [];
  for (const card of cards) {
    if (moving.has(card.id)) continue;
    if (options.carried && card.frameId && moving.has(card.frameId)) continue;
    // 折叠的框里那些卡一张都没画出来，看不见的东西不该参与吸附
    const parent = card.frameId ? byId.get(card.frameId) : null;
    if (parent?.frame?.collapsed) continue;
    if (card.x > view.x + view.w || card.x + card.w < view.x) continue;
    if (card.y > view.y + view.h || card.y + card.h < view.y) continue;
    const target = { id: card.id, x: card.x, y: card.y, w: card.w, h: card.h };
    targets.push(...(card.type === "frame"
      ? frameSnapTargets(target, bounds, options.movingFrame || card.frame?.collapsed)
      : [target]));
  }
  return targets;
}

/**
 * 超过这个卡片数才开「只渲染可视区」。
 *
 * 这个开关不是白拿的：平移时节点要不断挂载/卸载，卡面上的重内容（SVG 图、mermaid 图）
 * 会跟着重建。卡片不多时那点收益抵不过这份抖动，多了才划算——
 * 出问题的板都是 100 张 SVG 卡那一档，日常的板普遍在 10 张上下。
 */
const CULL_THRESHOLD = 60;

/** 判断「这条边动了没有」的容差：亚像素的浮点尾数不算动。 */
const EDGE_EPS = 0.01;

export interface CanvasHandlers {
  onCardAction: (cardId: string, action: CardAction) => void;
  onUploadFiles: (files: File[]) => Promise<void>;
  /** 工具条等浮层挂在画布容器内，才能相对画布定位。 */
  children?: React.ReactNode;
}

export function BoardCanvas({ onCardAction, onUploadFiles, children }: CanvasHandlers) {
  const board = useBoardStore((state) => state.board);
  const boardId = useBoardStore((state) => state.boardId);
  const editingCardId = useBoardStore((state) => state.editingCardId);
  const taskStatuses = useBoardStore((state) => state.taskStatuses);
  const selection = useBoardStore((state) => state.selection);
  const selectedCardIds = useBoardStore((state) => state.selectedCardIds);
  const focusRequest = useBoardStore((state) => state.focusRequest);
  const fitRequest = useBoardStore((state) => state.fitRequest);
  const search = useBoardStore((state) => state.search);
  const typeFilter = useBoardStore((state) => state.typeFilter);
  const tool = useBoardStore((state) => state.tool);
  const focusMode = useBoardStore((state) => state.focusMode);
  const snapGrid = useBoardStore((state) => state.snapGrid);
  const alignSnap = useBoardStore((state) => state.alignSnap);
  const dragging = useBoardStore((state) => state.dragging);
  const nodeToolbar = useBoardStore((state) => state.nodeToolbar);
  // 导出 PNG 时要把屏幕外的卡片也画进 DOM，否则截出来的图会缺卡
  const renderAllNodes = useBoardStore((state) => state.renderAllNodes);
  const cullOffscreen = !renderAllNodes && (board?.cards.length || 0) > CULL_THRESHOLD;
  const store = useBoardStore;
  // 渲染期用 t()，右键菜单 / 键盘回调里用 tr()——那些回调不该因为换语言重建（依赖数组保持原样）
  const t = useT();
  // 按住空格临时切平移（Figma/Miro 的肌肉记忆），松开回到原工具
  const [spaceHeld, setSpaceHeld] = useState(false);
  const panning = tool === "pan" || spaceHeld;

  const flow = useReactFlow();
  // React Flow 自己的 store：拖动时要按当前缩放换算吸附半径、按当前视口挑参照卡片
  const rfStore = useStoreApi();
  const updateNodeInternals = useUpdateNodeInternals();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [nodes, setNodes] = useState<Node<CardNodeData>[]>([]);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [edgeMenu, setEdgeMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  /** 拖动 / 缩放中的对齐参考线（画布坐标，见 lib/align-snap.ts） */
  const [guides, setGuides] = useState<AlignGuide[]>([]);
  // 缩放期间由 alignResize 接管网格量化（RF 的 22px 一跳会跨过吸附区），松手还给 RF
  const [resizing, setResizing] = useState(false);
  /** 缩放中最后一帧吸附后的尺寸：RF 松手时补的那一帧带的是它自己算的原始值，要拿这个盖回去 */
  const resizeSession = useRef<{ id: string; w: number; h: number } | null>(null);
  // RF 的 dragStop 参数来自内部原始 dragItems，不包含受控 onNodesChange 的吸附修正。
  const dragPositions = useRef(new Map<string, { x: number; y: number }>());
  const viewportRef = useRef<RFViewport>({ x: 0, y: 0, zoom: 1 });

  /* ── 动作回调（放进节点 data，避免节点组件直接依赖 store 写方法） ── */
  const handleCommitEdit = useCallback(
    async (cardId: string, patch: CardPatch) => {
      const state = store.getState();
      try {
        await state.patchCard(cardId, patch as Record<string, unknown>);
        state.setEditing(null);
      } catch (err) {
        state.showToast((err as Error).message);
      }
    },
    [store],
  );

  const deleteCard = useCallback(
    // 单张删除不再拦一个系统弹窗：删完提示里带「撤销」，比事前确认更省事也更救得回来
    (cardId: string) => store.getState().deleteCardsWithUndo([cardId]),
    [store],
  );

  /* ── 右键菜单：卡片 / 连线 / 空白三套 ─────────── */
  const [menu, setMenu] = useState<MenuState | null>(null);

  /** 多选时的批量菜单：右键任意一张选中的卡都出这个 */
  const bulkMenuItems = useCallback(
    (ids: string[]): MenuItem[] => {
      const state = store.getState();
      const run = (fn: () => Promise<unknown> | void) => () => {
        Promise.resolve(fn()).catch((err: Error) => state.showToast(err.message));
      };
      return [
        {
          key: "bulk-color",
          label: "",
          colors: {
            value: "slate" as CardColor,
            onSelect: (color: CardColor) =>
              run(() => state.patchCards(ids, { color }).then((n) => state.showToast(tr("canvas.toast.colored", { count: n }))))(),
          },
        },
        { key: "sep1", label: "", separator: true },
        {
          key: "bulk-task",
          label: tr("canvas.bulk.toTask"),
          icon: TYPE_ICON.task,
          onSelect: run(() =>
            state.patchCards(ids, { type: "task" }).then((n) => state.showToast(tr("canvas.toast.toTask", { count: n }))),
          ),
        },
        { key: "sep-align", label: "", separator: true },
        {
          key: "bulk-align",
          label: "",
          // 对齐 / 等距只动选中的这几张，是「手动收拾细节」那一档，跟整块板重排不是一回事
          aligns: {
            onSelect: (action: AlignAction) =>
              run(async () => {
                const board = state.board;
                if (!board) return;
                const picked = board.cards.filter((card) => ids.includes(card.id));
                const positions = alignCards(picked, action);
                if (!positions.length) return;
                const targetBoardId = state.boardId!;
                const count = await state.alignSelection(positions);
                const savedRevision = store.getState().board?.updatedAt || 0;
                const savedContent = boardEditSignature(store.getState().board);
                state.showToast(tr("canvas.toast.aligned", { action: tr(ALIGN_LABEL[action]), count }), count && !browserStorageActive() ? {
                  label: tr("canvas.action.undo"),
                  run: () => void state.undoHistoryIfCurrent(targetBoardId, savedRevision, savedContent),
                } : undefined);
              })(),
          },
        },
        { key: "sep-align2", label: "", separator: true },
        {
          key: "bulk-tidy",
          label: tr("canvas.bulk.tidy"),
          icon: UI.tidy,
          onSelect: run(async () => {
            const board = state.board;
            if (!board) return;
            const picked = new Set(ids);
            const subset = board.cards.filter((card) => picked.has(card.id));
            const subEdges = board.edges.filter((edge) => picked.has(edge.from) && picked.has(edge.to));
            const { tidyBoard } = await import("@/lib/layout");
            const positions = tidyBoard(subset, subEdges);
            state.applyGeometry(positions);
            state.showToast(tr("canvas.toast.tidied", { count: positions.length }));
          }),
        },
        { key: "sep-compare", label: "", separator: true },
        {
          key: "bulk-compare",
          // 2-4 张才并排：一张没得比，五张以上每栏窄到读不成正文（见 CompareModal 抬头）
          label: tr("canvas.bulk.compare", { count: Math.min(ids.length, COMPARE_MAX) }),
          icon: UI.compare,
          disabled: ids.length < 2,
          hint: ids.length > COMPARE_MAX ? tr("canvas.bulk.compare.cap", { max: COMPARE_MAX }) : tr("canvas.bulk.compare.esc"),
          onSelect: () => state.openCompare(ids),
        },
        { key: "sep2", label: "", separator: true },
        {
          key: "bulk-copy",
          label: tr("canvas.bulk.copy", { count: ids.length }),
          icon: UI.copy,
          hint: "⌘C",
          onSelect: () => void state.copyCards(ids),
        },
        {
          key: "bulk-copy-ids",
          label: tr("canvas.bulk.copyIds"),
          icon: UI.copy,
          hint: tr("canvas.bulk.copyIds.hint", { count: ids.length }),
          onSelect: () => {
            void navigator.clipboard.writeText(ids.join("\n"));
            state.showToast(tr("canvas.toast.copiedIds", { count: ids.length }));
          },
        },
        { key: "sep3", label: "", separator: true },
        {
          key: "bulk-delete",
          label: tr("canvas.bulk.delete", { count: ids.length }),
          icon: UI.remove,
          danger: true,
          hint: "Del",
          onSelect: () => {
            // 一次几十张是另一档风险，确认还是要问；问完删掉也照样给「撤销」
            if (!window.confirm(tr("canvas.confirm.deleteCards", { count: ids.length }))) return;
            void state.deleteCardsWithUndo(ids);
          },
        },
      ];
    },
    [store],
  );

  const openCardMenu = useCallback(
    (cardId: string, x: number, y: number) => {
      const state = store.getState();
      const card = state.board?.cards.find((item) => item.id === cardId);
      if (!card) return;
      // 右键点在「已经被多选中的某一张」上 → 出批量菜单，不要把多选打散
      const selectedIds = state.selectedCardIds;
      if (selectedIds.length > 1 && selectedIds.includes(cardId)) {
        setMenu({ x, y, items: bulkMenuItems(selectedIds) });
        return;
      }
      state.setSelection({ kind: "card", id: cardId });
      const run = (fn: () => Promise<unknown> | void) => () => {
        Promise.resolve(fn()).catch((err: Error) => state.showToast(err.message));
      };
      const items: MenuItem[] = [
        {
          key: "read",
          label: tr("canvas.card.read"),
          icon: UI.fit,
          hint: tr("canvas.card.read.hint"),
          onSelect: () => state.openReader(cardId),
        },
        { key: "edit", label: tr("canvas.card.edit"), icon: UI.edit, hint: tr("canvas.card.edit.hint"), onSelect: () => state.setEditing(cardId) },
        {
          key: "comment",
          label: tr("canvas.card.comment"),
          icon: UI.commentAdd,
          // 已经有意见挂在这张卡上时把条数摆出来：不点开也知道这儿是个待办
          hint: openCommentCount(state.board, "card", cardId)
            ? tr("canvas.card.comment.hint", { count: openCommentCount(state.board, "card", cardId) })
            : "C",
          onSelect: () => state.startComment({ target: "card", targetId: cardId, x: null, y: null, screen: { x, y } }),
        },
        {
          key: "color",
          separator: false,
          label: "",
          colors: { value: card.color, onSelect: (color: CardColor) => run(() => state.patchCard(cardId, { color }))() },
        },
        { key: "sep1", label: "", separator: true },
      ];

      // 分组框自己：折叠 / 展开摆在最前（框上那颗按钮的键鼠替身）
      if (card.type === "frame") {
        const members = (state.board?.cards || []).filter((item) => item.frameId === cardId).length;
        // 「圈住了但归属还是空的」那几张：只**提示**，收不收由这一项决定——
        // 系统绝不因为两个矩形重叠就替用户改归属（见 lib/frames.ts 抬头）
        const loose = frameCandidateIds(state.board?.cards, cardId).length;
        items.push({
          key: "frame-fold",
          label: tr(card.frame?.collapsed ? "canvas.card.frame.expand" : "canvas.card.frame.collapse"),
          icon: UI.chevron,
          hint: members ? tr("canvas.card.frame.members", { count: members }) : tr("canvas.card.frame.empty"),
          onSelect: () => onCardAction(cardId, "toggle-frame"),
        });
        if (loose) {
          items.push({
            key: "frame-capture",
            label: tr("canvas.card.frame.capture", { count: loose }),
            icon: UI.add,
            hint: tr("canvas.card.frame.capture.hint"),
            onSelect: run(async () => {
              const boardKey = state.boardId;
              const captured = await state.captureFrameCards(cardId);
              if (!captured || !boardKey) return;
              // 「过期判定」认的是写完之后那一版（同顶栏「整理」那颗撤销）
              const savedRevision = useBoardStore.getState().board?.updatedAt || 0;
              const savedContent = boardEditSignature(useBoardStore.getState().board);
              useBoardStore.getState().showToast(tr("cards.frame.captureDone", { count: captured }), {
                label: tr("cards.frame.captureUndo"),
                run: () => void useBoardStore.getState().undoHistoryIfCurrent(boardKey, savedRevision, savedContent),
              });
            }),
          });
        }
        items.push({ key: "sep-frame", label: "", separator: true });
      } else if (card.frameId) {
        // 在框里的卡：给一条不靠拖拽的退出路（触控板上把卡拖出框并不总是顺手）
        items.push(
          {
            key: "frame-out",
            label: tr("canvas.card.frame.out"),
            icon: UI.open,
            onSelect: run(() => state.setCardsFrame([cardId], null)),
          },
          { key: "sep-frame", label: "", separator: true },
        );
      }

      if (card.type === "task") {
        const status = card.task?.status || "idea";
        // 任务链路永远可用（没配外部 Runner 时是 local 后端）；
        // local 下「发起」不真派单，而是生成完整 prompt 供复制，菜单文案跟着换
        if (featureOn("tasks")) items.push(
          {
            key: "issue",
            label: tr("canvas.card.issue"),
            icon: UI.send,
            disabled: status !== "idea",
            onSelect: () => onCardAction(cardId, "issue"),
          },
          {
            key: "launch",
            label: tr(taskBackendKind() === "local" ? "canvas.card.prompt" : "canvas.card.launch"),
            icon: UI.run,
            disabled: status !== "issued",
            onSelect: () => onCardAction(cardId, "launch"),
          },
          { key: "detail", label: tr("canvas.card.detail"), icon: UI.detail, onSelect: () => onCardAction(cardId, "detail") },
        );
        else items.push({ key: "detail", label: tr("canvas.card.localDetail"), icon: UI.detail, onSelect: () => onCardAction(cardId, "detail") });
        items.push(
          {
            key: "done",
            label: tr(status === "done" ? "canvas.card.reopen" : "canvas.card.done"),
            icon: status === "done" ? UI.undo : UI.check,
            onSelect: () => onCardAction(cardId, status === "done" ? "reopen" : "done"),
          },
          { key: "to-text", label: tr("canvas.card.toText"), icon: TYPE_ICON.text, onSelect: run(() => state.patchCard(cardId, { type: "text" })) },
        );
      } else if (["text", "quote", "link"].includes(card.type)) {
        items.push({
          key: "to-task",
          label: tr("canvas.card.toTask"),
          icon: TYPE_ICON.task,
          onSelect: run(() =>
            state.patchCard(cardId, {
              type: "task",
              task: { goal: card.content || card.title || "", priority: "medium" },
            }),
          ),
        });
      }

      items.push(
        { key: "sep2", label: "", separator: true },
        {
          key: "copy",
          label: tr("canvas.card.copy"),
          icon: UI.copy,
          hint: "⌘C",
          onSelect: () => void state.copyCards([cardId]),
        },
        { key: "duplicate", label: tr("canvas.card.duplicate"), icon: UI.copy, hint: tr("canvas.card.duplicate.hint"), onSelect: run(() => state.duplicateCard(cardId)) },
        {
          key: "front",
          label: tr("canvas.card.front"),
          icon: UI.pin,
          onSelect: () => {
            const maxZ = Math.max(10, ...(state.board?.cards || []).map((item) => item.z || 0));
            state.applyGeometry([{ id: cardId, x: card.x, y: card.y, z: maxZ + 1 }]);
          },
        },
        {
          key: "copy-id",
          label: tr("canvas.card.copyId"),
          icon: UI.copy,
          onSelect: () => {
            void navigator.clipboard.writeText(cardId);
            state.showToast(tr("canvas.toast.copiedId"));
          },
        },
        // 来源标识从卡面降权到这里：只在 agent 建的卡上出现，纯信息不可点
        ...(card.createdBy === "agent"
          ? [{ key: "provenance", label: tr("canvas.card.byAgent"), icon: UI.agent, disabled: true } satisfies MenuItem]
          : []),
        { key: "sep3", label: "", separator: true },
        {
          key: "delete",
          label: tr(card.type === "frame" ? "canvas.card.deleteFrame" : "canvas.card.delete"),
          icon: UI.remove,
          danger: true,
          hint: card.type === "frame" ? tr("canvas.card.deleteFrame.hint") : "Del",
          onSelect: () => {
            if (card.type === "frame") {
              const members = (state.board?.cards || []).filter((item) => item.frameId === cardId).length;
              // 框是组织手段不是容器：删框只解除归属。这一句得说在前面，
              // 不然「删掉框 = 删掉框里的东西」这个直觉会让人不敢按
              if (members && !window.confirm(tr("canvas.confirm.deleteFrame", { count: members }))) return;
            }
            void deleteCard(cardId);
          },
        },
      );
      setMenu({ x, y, items });
    },
    [bulkMenuItems, deleteCard, onCardAction, store],
  );

  /* ── board → React Flow nodes ─────────────────── */
  const cardsSignature = useMemo(
    () =>
      (board?.cards || [])
        .map((card) => `${card.id}:${card.x},${card.y},${card.w},${card.h},${card.z}`)
        .join("|"),
    [board?.cards],
  );

  const filtering = Boolean(search.trim() || typeFilter.length);
  // 聚焦模式：选中一张卡 → 只亮它和一跳邻居；没选卡时不生效（全亮）
  const focusSet = useMemo(
    () => (focusMode && selection?.kind === "card" ? focusSetOf(board, selection.id) : null),
    [focusMode, selection, board],
  );

  const selectedIdSet = useMemo(() => new Set(selectedCardIds), [selectedCardIds]);

  /**
   * 「上下游关联」索引。
   *
   * 以前是每张卡在**渲染函数里**调 relatedOf()，而那个实现要为每张卡各建一次
   * 全board的 Map 再扫一遍全部连线——整体 O(N²)，而且每次都返回新对象，
   * 把下游的 memo 也一起废掉了。
   *
   * 只给任务卡建索引：卡面上用得到「关联 N」的只有任务卡页脚，
   * 而一块板上常常一张任务卡都没有——那样这里返回空 Map，
   * 所有卡片共用同一个 EMPTY_RELATED，引用恒定，节点就能整个复用。
   */
  const relatedIndex = useMemo(() => {
    const index = new Map<string, { up: BoardCard[]; down: BoardCard[] }>();
    const cards = board?.cards || [];
    for (const card of cards) if (card.type === "task") index.set(card.id, { up: [], down: [] });
    if (!index.size) return index;
    const byId = new Map(cards.map((card) => [card.id, card]));
    for (const edge of board?.edges || []) {
      const downstream = index.get(edge.from);
      if (downstream) {
        const to = byId.get(edge.to);
        if (to) downstream.down.push(to);
      }
      const upstream = index.get(edge.to);
      if (upstream) {
        const from = byId.get(edge.from);
        if (from) upstream.up.push(from);
      }
    }
    return index;
  }, [board?.cards, board?.edges]);

  /**
   * board.cards → React Flow 节点。**差量**重建：逐张比对，没变的那张连同它的 data
   * 一起原样复用。
   *
   * 为什么要这么写：这个 effect 的触发条件里有「每次点选」「搜索每敲一个字」，
   * 而以前每次都给每张卡造一个全新的 data 对象——CardNode 虽然 memo 过，
   * data 引用变了 memo 就一律失效，于是整块板的卡片全部重渲染
   * （实测 100 张 SVG 卡的板一次要 154 ms + 52 ms 两段长任务）。
   */
  useEffect(() => {
    const all = board?.cards || [];
    /**
     * 分组框排在最前面：React Flow 要求**父节点在数组里排在子节点之前**，
     * 否则子节点找不到父亲，位置会按绝对坐标画出去（表现是卡片整批跑到框外）。
     * 框不能再套框（服务端也挡着），所以「框全排前面」就够了，不用做拓扑排序。
     */
    const frames = all.filter((card) => card.type === "frame");
    const cards = frames.length ? [...frames, ...all.filter((card) => card.type !== "frame")] : all;
    const frameById = new Map(frames.map((frame) => [frame.id, frame]));
    setNodes((previous) => {
      const prevById = new Map(previous.map((node) => [node.id, node]));
      let changed = previous.length !== cards.length;
      const solo = selectedIdSet.size <= 1;
      const next = cards.map((card, index) => {
        const prev = prevById.get(card.id);
        // 归属的框还在、且 id 对得上才认；服务端已经清过悬空引用，这里只是渲染侧的兜底
        const parent = card.frameId ? frameById.get(card.frameId) : undefined;
        const parentId = parent?.id;
        // 折叠：框里的卡整批不画（数据一张不动）。框上会显示计数，见 cards/frame/ui.tsx
        const hidden = Boolean(parent?.frame?.collapsed);
        // 框永远垫在最底下：它是一块地，不是一张压在别人上面的卡
        const zIndex = card.type === "frame" ? 0 : 10 + (card.z || 0);
        const position = parent
          ? { x: card.x - parent.x, y: card.y - parent.y }
          : { x: card.x, y: card.y };
        const editing = editingCardId === card.id;
        const dimmed =
          (filtering && !cardMatches(card, search, typeFilter)) || Boolean(focusSet && !focusSet.has(card.id));
        const hit = filtering && !dimmed;
        const live = taskStatuses[card.id];
        const flash = flashId === card.id;
        const related = relatedIndex.get(card.id) || EMPTY_RELATED;
        const selected = selectedIdSet.has(card.id);
        const previousData = prev?.data;
        if (
          prev &&
          previousData &&
          previousData.card === card &&
          previousData.live === live &&
          previousData.editing === editing &&
          previousData.flash === flash &&
          previousData.dimmed === dimmed &&
          previousData.hit === hit &&
          previousData.solo === solo &&
          previousData.related === related &&
          previousData.onAction === onCardAction &&
          previousData.onCommitEdit === handleCommitEdit &&
          previousData.onMenu === openCardMenu &&
          prev.selected === selected &&
          prev.zIndex === zIndex &&
          prev.parentId === parentId &&
          Boolean(prev.hidden) === hidden &&
          prev.width === card.w &&
          prev.height === card.h &&
          prev.position.x === position.x &&
          prev.position.y === position.y &&
          previous[index]?.id === card.id
        ) {
          return prev;
        }
        changed = true;
        const data: CardNodeData = {
          card,
          live,
          editing,
          flash,
          onAction: onCardAction,
          onCommitEdit: handleCommitEdit,
          onMenu: openCardMenu,
          dimmed,
          hit,
          solo,
          related,
        };
        return {
          ...(prev || {}),
          id: card.id,
          type: "card",
          position,
          width: card.w,
          height: card.h,
          zIndex,
          selected,
          // parentId 给「框动子卡跟着动」；**不设 extent: "parent"**，
          // 那会把子卡锁死在框里，拖出去解除归属这条路就没了（见 frameAtPoint 抬头）
          ...(parentId ? { parentId } : { parentId: undefined }),
          hidden,
          // 能不能拖交给 ReactFlow 的 nodesDraggable 统一管（抓手模式下要整体关掉）：
          // 写在节点上的 draggable 优先级更高，会把那个开关顶掉
          data,
        } satisfies Node<CardNodeData>;
      });
      // 一张都没变就把原数组还回去：React Flow 拿到同一个引用，整轮 diff 都省了
      return changed ? next : previous;
    });
  }, [
    board?.cards,
    cardsSignature,
    taskStatuses,
    editingCardId,
    flashId,
    selectedIdSet,
    onCardAction,
    handleCommitEdit,
    openCardMenu,
    filtering,
    search,
    typeFilter,
    focusSet,
    relatedIndex,
  ]);

  /**
   * 卡片集合变化后强制重算一次 handle 位置。
   * React Flow 只有量到 handleBounds 才画边（isNodeInitialized），
   * 而节点对象是我们每次从 board.cards 重建的——一旦 measured 没被带过去，
   * 边会在「等下一次 ResizeObserver 回调」的窗口里整片消失。这里补一刀，代价极低。
   */
  const cardIds = useMemo(() => (board?.cards || []).map((card) => card.id).join(","), [board?.cards]);
  const measuredIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!cardIds) {
      measuredIds.current = new Set();
      return;
    }
    const ids = cardIds.split(",");
    // 只给「这一轮新出现的」卡片重算：加一张卡不该把另外 99 张的 handle 位置也算一遍
    const fresh = ids.filter((id) => !measuredIds.current.has(id));
    measuredIds.current = new Set(ids);
    if (!fresh.length) return;
    const frame = requestAnimationFrame(() => updateNodeInternals(fresh));
    return () => cancelAnimationFrame(frame);
  }, [cardIds, updateNodeInternals]);

  const edges: Edge[] = useMemo(() => {
    const cardById = new Map((board?.cards || []).map((card) => [card.id, card]));
    // 折叠的框：框里的卡不画，挂在它们身上的线也别画——
    // 留着的话线会从框边缘扎向一个看不见的点，比缺条线更难懂
    const foldedFrames = new Set(
      (board?.cards || []).filter((card) => card.type === "frame" && card.frame?.collapsed).map((card) => card.id),
    );
    const folded = (id: string) => {
      const card = cardById.get(id);
      return Boolean(card?.frameId && foldedFrames.has(card.frameId));
    };
    /**
     * 同一对卡片之间的多条连线：它们的曲线几乎重合，标签又都钉在中点上，
     * 于是文字叠成一团谁也读不出来。这里一次 O(E) 把「你是这对里的第几条、一共几条」
     * 算出来交给 FloatingEdge，让它把标签沿曲线错开——**只动标签，不动线**，
     * 连线的走向与语义一个字节没变。
     *
     * 算在这里而不是每条边自己去 store 里找同伴：那是 O(E²)，大板上每次重渲染都要跑一遍。
     */
    const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
    const pairRank = new Map<string, number>();
    const pairSize = new Map<string, number>();
    for (const edge of board?.edges || []) {
      const key = pairKey(edge.from, edge.to);
      const next = (pairSize.get(key) || 0) + 1;
      pairSize.set(key, next);
      pairRank.set(edge.id, next - 1);
    }
    return (board?.edges || []).map((edge) => {
      const from = cardById.get(edge.from);
      const to = cardById.get(edge.to);
      // 两端都没命中筛选时，连线跟着变淡
      const dimmed =
        (filtering &&
          !(from && cardMatches(from, search, typeFilter)) &&
          !(to && cardMatches(to, search, typeFilter))) ||
        // 聚焦时只留「跟选中卡直接相连」的那些线，邻居之间的线也淡掉
        Boolean(focusSet && !(edge.from === selection?.id || edge.to === selection?.id));
      return {
        id: edge.id,
        source: edge.from,
        target: edge.to,
        type: "floating",
        label: edge.label || undefined,
        selected: selection?.kind === "edge" && selection.id === edge.id,
        hidden: folded(edge.from) || folded(edge.to),
        data: {
          kind: edge.kind || "rel",
          color: edge.color,
          style: edge.style,
          width: edge.width,
          dimmed,
          labelSlot: pairRank.get(edge.id) || 0,
          labelSlots: pairSize.get(pairKey(edge.from, edge.to)) || 1,
        },
      };
    });
  }, [board?.edges, board?.cards, selection, filtering, search, typeFilter, focusSet]);

  /* ── 视口：打开画板时恢复，操作时回写 ─────────── */
  useEffect(() => {
    if (!board) return;
    const viewport = board.viewport || { x: 0, y: 0, zoom: 1 };
    viewportRef.current = viewport;
    flow.setViewport(viewport);
    // 只在切板时恢复，之后视口跟随用户操作
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  const handleMove = useCallback(
    (_event: unknown, viewport: RFViewport) => {
      viewportRef.current = viewport;
    },
    [],
  );

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: RFViewport) => {
      viewportRef.current = viewport;
      store.getState().setViewport(viewport);
    },
    [store],
  );

  /* ── 对齐吸附 ─────────────────────────────────── */

  /**
   * 拖动中把这一批位置变更**整体**挪一点点，让被拖的包围盒对上附近卡片的边线 / 中线 /
   * 等间距，同时算出该画哪几条参考线。没吸上就原样返回，一个字节都不改。
   *
   * 为什么挪的是「包围盒」而不是逐张卡：多选拖动时如果每张各吸各的，队形当场就散了。
   * 一次位移作用到整批变更上，组内相对位置永远不变。
   *
   * 开启邻居吸附时使用原始拖动坐标，先找邻居线，没有候选的轴再吸网格。
   * 不能先量化网格：在高倍缩放下它可能跨过整个 6px 吸附区，永远碰不到目标线。
   */
  const alignDrag = useCallback(
    (changes: NodeChange<Node<CardNodeData>>[]): NodeChange<Node<CardNodeData>>[] => {
      type Move = Extract<NodeChange<Node<CardNodeData>>, { type: "position" }>;
      const clearGuides = () => setGuides((previous) => (previous.length ? [] : previous));
      const moves = changes.filter(
        (change): change is Move =>
          change.type === "position" && change.dragging != null && Boolean(change.position),
      );
      if (!moves.length) {
        if (changes.some((change) => change.type === "position")) clearGuides();
        return changes;
      }

      const state = store.getState();
      const cards = state.board?.cards || [];
      const finished = moves.every((move) => move.dragging === false);
      if (!state.alignSnap) {
        clearGuides();
        for (const move of moves) dragPositions.current.set(move.id, move.position!);
        return changes;
      }
      const byId = new Map(cards.map((card) => [card.id, card]));
      const movesById = new Map(moves.map((move) => [move.id, move]));

      // 1) 被拖的整体包围盒
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (const move of moves) {
        const card = byId.get(move.id);
        if (!card || !move.position) continue;
        // 框里的卡记的是相对坐标；框自己也在这一批里被拖时，得拿它的**新**位置当参照
        const parent = card.frameId ? byId.get(card.frameId) : null;
        const origin = parent
          ? movesById.get(parent.id)?.position ?? { x: parent.x, y: parent.y }
          : { x: 0, y: 0 };
        const x = move.position.x + origin.x;
        const y = move.position.y + origin.y;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + card.w);
        bottom = Math.max(bottom, y + card.h);
      }
      if (!Number.isFinite(left)) return changes;
      const bounds: SnapRect = { id: "moving", x: left, y: top, w: right - left, h: bottom - top };
      const movingFrame = moves.some((move) => byId.get(move.id)?.type === "frame");

      // 2) 参照物：只挑**看得见**的卡片；拖框时框里的卡跟着走，不能当参照
      const moving = new Set(moves.map((move) => move.id));
      const { transform, width, height } = rfStore.getState();
      const [tx, ty, zoom] = transform;
      const view = { x: -tx / zoom, y: -ty / zoom, w: width / zoom, h: height / zoom };
      const targets = visibleSnapTargets(cards, byId, view, bounds, moving, { carried: true, movingFrame });

      // 3) 吸附半径按缩放折算：放大时不至于甩不掉，缩小时也还吸得到
      const result = computeAlignSnap(
        bounds,
        targets,
        ALIGN_SNAP_TOLERANCE / zoom,
      );
      if (finished) clearGuides();
      else setGuides((previous) => (sameGuides(previous, result.guides) ? previous : result.guides));
      const dx = result.guides.some((guide) => guide.axis === "x") ? result.dx
        : state.snapGrid ? Math.round(left / SNAP_GRID) * SNAP_GRID - left : 0;
      const dy = result.guides.some((guide) => guide.axis === "y") ? result.dy
        : state.snapGrid ? Math.round(top / SNAP_GRID) * SNAP_GRID - top : 0;
      return changes.map((change) => {
        if (change.type !== "position" || change.dragging == null || !change.position) return change;
        // 父节点已经平移时，子节点的相对位置不能再加一次同样的位移。
        const parentMoving = moving.has(byId.get(change.id)?.frameId || "");
        const position = parentMoving ? change.position : { x: change.position.x + dx, y: change.position.y + dy };
        dragPositions.current.set(change.id, position);
        return { ...change, position };
      });
    },
    [rfStore, store],
  );

  /**
   * 缩放中把这一帧的尺寸改一点点，让**手上拉的那条边**贴上邻居的边线 / 中线，并画出参考线。
   *
   * 跟拖动是同一件事的另一半：拖动对齐的是「卡片摆在哪」，缩放对齐的是「这条边拉到哪」。
   * 少了这一半，一排卡片位置齐了、宽度却总差那么几像素——只能靠肉眼凑。
   *
   * 三处跟拖动不同：
   *  ① 在拉哪条边不用猜：store 里的几何要等松手才回写，**它就是开拉之前的原始矩形**，
   *     哪条边跟它对不上，哪条边就在手上。斜角把手两条边同时动，两条轴各解各的。
   *  ② 拉框的边时框里的卡留在原地（React Flow 用相对坐标把它们钉住），所以它们是**合格的参照物**——
   *     拖动时不是这样，那时它们跟着框走，数据里却还是旧位置。
   *  ③ 松手时 React Flow 会补一帧「原始尺寸」（它按自己的账算，不认吸附），
   *     照单全收的话卡片会在松手瞬间弹回去几像素——这里换成最后一帧吸附后的尺寸。
   */
  const alignResize = useCallback(
    (changes: NodeChange<Node<CardNodeData>>[]): NodeChange<Node<CardNodeData>>[] => {
      type Dimension = Extract<NodeChange<Node<CardNodeData>>, { type: "dimensions" }>;
      const clearGuides = () => setGuides((previous) => (previous.length ? [] : previous));
      const change = changes.find(
        (item): item is Dimension =>
          item.type === "dimensions" && item.resizing != null && Boolean(item.dimensions),
      );
      if (!change?.dimensions) return changes;

      // 松手：把 RF 补的那一帧换成最后一帧吸附后的尺寸，否则吸上的边会当场弹开
      if (change.resizing === false) {
        const session = resizeSession.current;
        resizeSession.current = null;
        setResizing(false);
        clearGuides();
        if (!session || session.id !== change.id) return changes;
        return changes.map((item) =>
          item === change ? { ...change, dimensions: { width: session.w, height: session.h } } : item);
      }

      const state = store.getState();
      const cards = state.board?.cards || [];
      const card = cards.find((entry) => entry.id === change.id);
      if (!card || !state.alignSnap) {
        clearGuides();
        return changes;
      }
      // 接管期间关掉 RF 自带的网格量化：22px 一跳会直接跨过 6px 的吸附区，永远碰不到目标线。
      // 网格由下面在吸附落空的轴上自己兜底。
      setResizing(true);

      const byId = new Map(cards.map((entry) => [entry.id, entry]));
      const parent = card.frameId ? byId.get(card.frameId) : null;
      const origin = parent ? { x: parent.x, y: parent.y } : { x: 0, y: 0 };
      const moved = changes.find(
        (item) => item.type === "position" && item.id === change.id && item.position,
      ) as Extract<NodeChange<Node<CardNodeData>>, { type: "position" }> | undefined;
      const rect: SnapRect = {
        id: card.id,
        x: moved?.position ? moved.position.x + origin.x : card.x,
        y: moved?.position ? moved.position.y + origin.y : card.y,
        w: change.dimensions.width,
        h: change.dimensions.height,
      };
      // 跟开拉之前的矩形比：动了的边就是手上这条（另一条边此刻纹丝不动）
      const edges = {
        left: Math.abs(rect.x - card.x) > EDGE_EPS,
        right: Math.abs(rect.x + rect.w - card.x - card.w) > EDGE_EPS,
        top: Math.abs(rect.y - card.y) > EDGE_EPS,
        bottom: Math.abs(rect.y + rect.h - card.y - card.h) > EDGE_EPS,
      };

      const { transform, width, height } = rfStore.getState();
      const [tx, ty, zoom] = transform;
      const view = { x: -tx / zoom, y: -ty / zoom, w: width / zoom, h: height / zoom };
      const targets = visibleSnapTargets(cards, byId, view, rect, new Set([card.id]), {
        carried: false,
        movingFrame: card.type === "frame",
      });
      const result = computeResizeSnap(rect, edges, targets, ALIGN_SNAP_TOLERANCE / zoom, CARD_SIZE_LIMITS);
      setGuides((previous) => (sameGuides(previous, result.guides) ? previous : result.guides));

      // 没吸上的轴退回网格：量的是**手上那条边**的绝对坐标，跟拖动量左上角是同一个口径。
      // 上下限跟吸附一样要认——量化的幅度可以到半格，比吸附更容易把卡片推出手柄的范围。
      const grid = (at: number, size: number, sign: number, min: number, max: number) => {
        const delta = Math.round(at / SNAP_GRID) * SNAP_GRID - at;
        const next = size + sign * delta;
        return next >= min && next <= max ? delta : 0;
      };
      let { dx, dy, dw, dh } = result;
      const { minW, maxW, minH, maxH } = CARD_SIZE_LIMITS;
      if (state.snapGrid && !result.guides.some((guide) => guide.axis === "x")) {
        if (edges.left) dw = -(dx = grid(rect.x, rect.w, -1, minW, maxW));
        else if (edges.right) dw = grid(rect.x + rect.w, rect.w, 1, minW, maxW);
      }
      if (state.snapGrid && !result.guides.some((guide) => guide.axis === "y")) {
        if (edges.top) dh = -(dy = grid(rect.y, rect.h, -1, minH, maxH));
        else if (edges.bottom) dh = grid(rect.y + rect.h, rect.h, 1, minH, maxH);
      }

      const size = { width: rect.w + dw, height: rect.h + dh };
      resizeSession.current = { id: card.id, w: size.width, h: size.height };
      if (!dx && !dy && !dw && !dh) return changes;
      return changes.map((item) => {
        if (item === change) return { ...change, dimensions: size };
        // 只挪框自己：框里的卡记的是相对坐标，框的左上角被吸走多少它们就跟着走多少，
        // 跟松手后落库的口径（withFrameFollowers：框动了卡跟着动）正好对上
        if (item.type !== "position" || !item.position || item.id !== card.id) return item;
        return { ...item, position: { x: item.position.x + dx, y: item.position.y + dy } };
      });
    },
    [rfStore, store],
  );

  /* ── 节点变化：位置 / 尺寸 / 选中 ─────────────── */
  const onNodesChange = useCallback(
    (incoming: NodeChange<Node<CardNodeData>>[]) => {
      // 缩放与拖动不会同时发生，各走各的：混在一起的话，缩放带来的位置变更会被当成拖动清掉参考线
      const resizeBatch = incoming.some((change) => change.type === "dimensions" && change.resizing != null);
      const changes = resizeBatch ? alignResize(incoming) : alignDrag(incoming);
      setNodes((current) => {
        const next = applyNodeChanges(changes, current);
        // 尺寸拖完（resizing=false）立即回写，位置等 dragStop 统一回写
        const finishedResize = changes.filter(
          (change) => change.type === "dimensions" && change.resizing === false,
        ) as Extract<NodeChange<Node<CardNodeData>>, { type: "dimensions" }>[];
        if (finishedResize.length) {
          const cards = store.getState().board?.cards || [];
          const byId = new Map(cards.map((card) => [card.id, card]));
          const geometry = finishedResize
            .map((change) => next.find((node) => node.id === change.id))
            .filter(Boolean)
            .map((node) => {
              const at = absoluteOf(node!, byId);
              return {
                id: node!.id,
                x: Math.round(at.x),
                y: Math.round(at.y),
                w: Math.round((node!.width as number) || node!.measured?.width || 280),
                h: Math.round((node!.height as number) || node!.measured?.height || 170),
              };
            });
          // 从左上角拉大一个框会同时改它的位置，框里的卡得跟着挪
          if (geometry.length) {
            const withFollowers = withFrameFollowers(geometry, cards);
            queueMicrotask(() => store.getState().applyGeometry(withFollowers));
          }
        }
        return next;
      });
      if (changes.some((change) => change.type === "select")) {
        // 用 RF 应用完变更后的结果做真源，避免自己拼一份可能错位的选中集
        setNodes((current) => {
          const ids = current.filter((node) => node.selected).map((node) => node.id);
          queueMicrotask(() => {
            const state = store.getState();
            // 先写 selection（它会顺带重置 selectedCardIds），再用 RF 的真实结果覆盖，顺序不能反
            if (ids.length === 1) state.setSelection({ kind: "card", id: ids[0] });
            else if (state.selection?.kind === "card") state.setSelection(null);
            state.setSelectedCardIds(ids);
          });
          return current;
        });
        setEdgeMenu(null);
      }
    },
    [alignDrag, alignResize, store],
  );

  const onNodeDragStart = useCallback(() => {
    dragPositions.current.clear();
    store.getState().setDragging(true);
  }, [store]);

  /**
   * 拖动结束后的统一收尾（单张拖动与多选包围盒拖动共用）：
   *  ① 子节点的相对坐标换算回画布绝对坐标；② 框动了就把框里的卡一起挪；
   *  ③ 按落点重算归属——中心点落进哪个框就归哪个框，落在框外就解除。
   * 归属改动跟几何分开发：几何走防抖批量落库，归属是一次内容改动，得立刻确定。
   */
  const settleDrag = useCallback(
    (moved: Node<CardNodeData>[]) => {
      const state = store.getState();
      // RF 拖多选包围盒会同时调用 node 与 selection 的 stop；只提交一次。
      if (!state.dragging) return;
      const cards = state.board?.cards || [];
      const byId = new Map(cards.map((card) => [card.id, card]));
      const maxZ = Math.max(10, ...cards.map((card) => card.z || 0));
      const finalNodes = moved.map((node) => ({ ...node, position: dragPositions.current.get(node.id) ?? node.position }));
      const finalParents = new Map(byId);
      for (const node of finalNodes) {
        const card = byId.get(node.id);
        if (card?.type === "frame") finalParents.set(card.id, { ...card, ...node.position });
      }
      const geometry = finalNodes.map((node, index) => {
        const at = absoluteOf(node, finalParents);
        return {
          id: node.id,
          x: at.x,
          y: at.y,
          // 拖过的卡置顶（与旧版一致：点一下就浮到最上层）；框不参与，它永远垫在底下
          ...(byId.get(node.id)?.type === "frame" ? {} : { z: maxZ + 1 + index }),
        };
      });
      state.applyGeometry(withFrameFollowers(geometry, cards));
      state.setDragging(false);
      dragPositions.current.clear();
      setGuides([]);

      // 归属重算：框自己不进框（不做嵌套分组，服务端也挡着）
      const regroup = new Map<string | null, string[]>();
      for (const entry of geometry) {
        const card = byId.get(entry.id);
        if (!card || card.type === "frame") continue;
        const next = frameAtPoint([...finalParents.values()], entry.x + card.w / 2, entry.y + card.h / 2);
        if (next === (card.frameId || null)) continue;
        if (!regroup.has(next)) regroup.set(next, []);
        regroup.get(next)!.push(card.id);
      }
      for (const [frameId, ids] of regroup) {
        void state.setCardsFrame(ids, frameId).catch((err: Error) => state.showToast(err.message));
      }
    },
    [store],
  );

  /** 多选后 RF 会盖一层包围盒；拖它 / 右键它都不走 onNode*，得单独接。 */
  const onSelectionDragStop = useCallback(
    (_event: unknown, dragged: Node<CardNodeData>[]) => settleDrag(dragged),
    [settleDrag],
  );

  const onSelectionContextMenu = useCallback(
    (event: React.MouseEvent, selectedNodes: Node<CardNodeData>[]) => {
      event.preventDefault();
      event.stopPropagation();
      const ids = selectedNodes.map((node) => node.id);
      if (!ids.length) return;
      setMenu({ x: event.clientX, y: event.clientY, items: bulkMenuItems(ids) });
    },
    [bulkMenuItems],
  );

  const onNodeDragStop = useCallback(
    (_event: unknown, node: Node<CardNodeData>, dragged: Node<CardNodeData>[]) =>
      settleDrag(dragged?.length ? dragged : [node]),
    [settleDrag],
  );

  /* ── 连线 ─────────────────────────────────────── */
  const onConnect = useCallback(
    async (connection: { source: string | null; target: string | null }) => {
      const state = store.getState();
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      try {
        await state.addEdge(connection.source, connection.target);
      } catch (err) {
        state.showToast((err as Error).message);
      }
    },
    [store],
  );

  /** 拖线落在空白处 → 在该处衍生一张新文本卡并自动连线（旧版核心手势，原样保留）。 */
  const onConnectEnd = useCallback<OnConnectEnd>(
    async (event, connectionState) => {
      if (connectionState.isValid || connectionState.toNode) return;
      const fromId = connectionState.fromNode?.id;
      if (!fromId) return;
      const point = "clientX" in event
        ? { x: event.clientX, y: event.clientY }
        : { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
      const target = document.elementFromPoint(point.x, point.y);
      if (target?.closest(".toolbar, .drawer, .edge-toolbar, .topbar, .sidebar")) return;
      const position = flow.screenToFlowPosition(point);
      const meta = TYPE_META.text;
      const state = store.getState();
      try {
        const card = await state.createCard({
          type: "text",
          x: Math.round(position.x - meta.size[0] / 2),
          y: Math.round(position.y - meta.size[1] / 2),
          color: "amber",
        });
        await state.addEdge(fromId, card.id);
        state.setEditing(card.id);
      } catch (err) {
        state.showToast((err as Error).message);
      }
    },
    [flow, store],
  );

  /* ── 双击：空白建卡 / 卡片进编辑 ───────────────── */
  const onPaneDoubleClick = useCallback(
    async (event: React.MouseEvent) => {
      const state = store.getState();
      // 节点上的 dblclick 会冒泡到 pane：那是「进编辑」，不该再建一张新卡
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".react-flow__node, .toolbar, .drawer, .edge-toolbar")) return;
      if (state.editingCardId) {
        state.setEditing(null);
        return;
      }
      if (!state.boardId) {
        state.showToast(tr("toolbar.toast.needBoard"));
        return;
      }
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      try {
        const card = await state.createCard({
          type: "text",
          x: Math.round(position.x - 140),
          y: Math.round(position.y - 40),
        });
        state.setEditing(card.id);
      } catch (err) {
        state.showToast((err as Error).message);
      }
    },
    [flow, store],
  );

  const onNodeDoubleClick = useCallback(
    (event: React.MouseEvent, node: Node<CardNodeData>) => {
      // 点在正文里的链接 / 按钮上时不进编辑
      if ((event.target as HTMLElement)?.closest("a, button, input, textarea, select")) return;
      event.stopPropagation();
      const state = store.getState();
      // 子画板卡：双击的自然语义是「进去看看」，改指向哪块板走右键 / ⋯ 菜单
      const card = state.board?.cards.find((item) => item.id === node.id);
      if (card?.type === "board" && card.boardRef?.boardId) {
        void state
          .drillInto(card.boardRef.boardId, card.boardRef.name || card.title || card.boardRef.boardId)
          .catch((err: Error) => state.showToast(err.message));
        return;
      }
      state.setEditing(node.id);
    },
    [store],
  );

  /* ── 连线选中 → 标签工具条 ─────────────────────── */
  const onEdgeClick = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.stopPropagation();
      const state = store.getState();
      state.setSelection({ kind: "edge", id: edge.id });
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setEdgeMenu({ id: edge.id, x: position.x, y: position.y });
    },
    [flow, store],
  );

  const onPaneClick = useCallback(() => {
    const state = store.getState();
    if (state.editingCardId) state.setEditing(null);
    state.setSelection(null);
    setEdgeMenu(null);
    setMenu(null);
  }, [store]);

  const activeEdge = useMemo(
    () => (edgeMenu ? board?.edges.find((item) => item.id === edgeMenu.id) || null : null),
    [edgeMenu, board?.edges],
  );

  const edgeMenuScreen = useMemo(() => {
    if (!edgeMenu) return null;
    const viewport = viewportRef.current;
    return {
      left: edgeMenu.x * viewport.zoom + viewport.x,
      top: edgeMenu.y * viewport.zoom + viewport.y - 40,
    };
  }, [edgeMenu, nodes]);

  const openPaneMenu = useCallback(
    (event: MouseEvent | React.MouseEvent) => {
      event.preventDefault();
      const state = store.getState();
      const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const add = (type: CardType) => async () => {
        const [w, h] = TYPE_META[type].size;
        try {
          const card = await state.createCard({
            type,
            x: Math.round(position.x - w / 2),
            y: Math.round(position.y - h / 2),
          });
          state.setEditing(card.id);
        } catch (err) {
          state.showToast((err as Error).message);
        }
      };
      const clipboard = state.clipboardCards();
      const items: MenuItem[] = [
        {
          key: "copy-board-agent",
          label: tr(browserStorageActive() ? "canvas.pane.agentPrompt.cdp" : "canvas.pane.agentPrompt"),
          icon: UI.agent,
          disabled: !state.boardId,
          onSelect: () => {
            if (!state.boardId) return;
            const prompt = browserStorageActive()
              ? browserAgentPrompt(boardOrigin(), browserWorkspace(), state.boardId)
              : boardAgentPrompt(boardOrigin(), state.boardId);
            void copyText(prompt).then((ok) =>
              state.showToast(tr(ok ? "canvas.toast.promptCopied" : "canvas.toast.promptFailed")),
            );
          },
        },
        { key: "sep-agent", label: "", separator: true },
        // 剪贴板里有东西才给这一项，落点就是右键点的那处
        ...(clipboard
          ? ([
              {
                key: "paste",
                label: tr("canvas.pane.paste", { count: clipboard.cards.length }),
                icon: UI.copy,
                hint: "⌘V",
                onSelect: () => void state.pasteCards(clipboard, { at: position }),
              },
              { key: "sep-paste", label: "", separator: true },
            ] as MenuItem[])
          : []),
        { key: "text", label: tr("canvas.pane.new", { label: typeLabel("text") }), icon: TYPE_ICON.text, hint: tr("canvas.pane.new.hint"), onSelect: add("text") },
        { key: "task", label: tr("canvas.pane.new", { label: typeLabel("task") }), icon: TYPE_ICON.task, onSelect: add("task") },
        { key: "link", label: tr("canvas.pane.new", { label: typeLabel("link") }), icon: TYPE_ICON.link, onSelect: add("link") },
        { key: "quote", label: tr("canvas.pane.new", { label: typeLabel("quote") }), icon: TYPE_ICON.quote, onSelect: add("quote") },
        { key: "sep-comment", label: "", separator: true },
        {
          key: "comment",
          label: tr("canvas.pane.comment"),
          icon: UI.commentAdd,
          hint: tr("canvas.pane.comment.hint"),
          onSelect: () =>
            state.startComment({
              target: "board",
              targetId: null,
              x: Math.round(position.x),
              y: Math.round(position.y),
              screen: { x: event.clientX, y: event.clientY },
            }),
        },
        {
          key: "comment-list",
          label: tr("canvas.pane.comments"),
          icon: UI.comment,
          hint: (state.board?.comments || []).filter((comment) => !comment.resolved).length
            ? tr("canvas.pane.comments.hint", {
                count: (state.board?.comments || []).filter((comment) => !comment.resolved).length,
              })
            : undefined,
          onSelect: () => state.openComments(),
        },
        { key: "sep1", label: "", separator: true },
        {
          key: "fit",
          label: tr("canvas.pane.fit"),
          icon: UI.fit,
          onSelect: () => flow.fitView({ padding: canvasFitPadding(), maxZoom: 1.4, duration: 260 }),
        },
        {
          key: "refresh",
          label: tr("canvas.pane.refresh"),
          icon: UI.refresh,
          onSelect: () => {
            state.refreshBoard().catch((err: Error) => state.showToast(err.message));
          },
        },
      ];
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [flow, store],
  );

  const openEdgeMenu = useCallback(
    (event: MouseEvent | React.MouseEvent, edge: Edge) => {
      event.preventDefault();
      const state = store.getState();
      state.setSelection({ kind: "edge", id: edge.id });
      const found = state.board?.edges.find((item) => item.id === edge.id);
      const currentKind = (found?.kind || "rel") as EdgeKind;
      const items: MenuItem[] = [
        {
          key: "label",
          label: tr(found?.label ? "canvas.edge.label.edit" : "canvas.edge.label.add"),
          icon: UI.edit,
          onSelect: () => {
            const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
            setEdgeMenu({ id: edge.id, x: position.x, y: position.y });
          },
        },
        {
          key: "comment",
          label: tr("canvas.card.comment"),
          icon: UI.commentAdd,
          hint: openCommentCount(state.board, "edge", edge.id)
            ? tr("canvas.card.comment.hint", { count: openCommentCount(state.board, "edge", edge.id) })
            : undefined,
          onSelect: () =>
            state.startComment({
              target: "edge",
              targetId: edge.id,
              x: null,
              y: null,
              screen: { x: event.clientX, y: event.clientY },
            }),
        },
        { key: "sep-kind", label: "", separator: true },
        ...EDGE_KINDS.map((kind) => ({
          key: `kind-${kind}`,
          label: tr(EDGE_KIND_LABEL_KEY[kind]),
          hint: currentKind === kind ? tr("canvas.edge.current") : tr(EDGE_KIND_HINT_KEY[kind]),
          icon: currentKind === kind ? UI.check : undefined,
          disabled: currentKind === kind,
          onSelect: () => {
            state.setEdgeKind(edge.id, kind).catch((err: Error) => state.showToast(err.message));
          },
        })),
        { key: "sep", label: "", separator: true },
        {
          key: "delete",
          label: tr("canvas.edge.delete"),
          icon: UI.remove,
          danger: true,
          onSelect: () => {
            void state.deleteEdgeWithUndo(edge.id);
            setEdgeMenu(null);
          },
        },
      ];
      setMenu({ x: event.clientX, y: event.clientY, items });
    },
    [flow, store],
  );

  /* ── 定位到卡片（深链 / 任务台「回到卡片」）───────────── */
  useEffect(() => {
    if (!focusRequest) return;
    const card = board?.cards.find((item) => item.id === focusRequest.cardId);
    if (!card) {
      store.getState().consumeFocus();
      return;
    }
    flow.setCenter(card.x + card.w / 2, card.y + card.h / 2, { zoom: viewportRef.current.zoom, duration: 320 });
    store.getState().setSelection({ kind: "card", id: card.id });
    setFlashId(card.id);
    const timer = setTimeout(() => setFlashId(null), 1600);
    store.getState().consumeFocus();
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.seq]);

  /**
   * 适应内容（应用模板后）。
   * 依赖里带上 nodes.length：请求可能比节点先到（openBoard 之后节点要等一次渲染），
   * 节点一到就会再跑一次；rAF 再让一帧，等 React Flow 把节点同步进自己的 store。
   */
  useEffect(() => {
    if (!fitRequest || !nodes.length) return;
    const raf = requestAnimationFrame(() => {
      flow.fitView({ padding: canvasFitPadding(0.14), duration: 380, maxZoom: 1.1 });
      store.getState().consumeFit();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitRequest?.seq, nodes.length]);

  /* ── 拖文件进画布 ─────────────────────────────── */
  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    setDropping(true);
  }, []);

  const onDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      setDropping(false);
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length) await onUploadFiles(files);
    },
    [onUploadFiles],
  );

  /* ── 空格临时平移 ─────────────────────────────── */
  useEffect(() => {
    const onDown = (event: KeyboardEvent) => {
      const interactive = (event.target as HTMLElement)?.closest?.("button, a[href], [role='button']");
      if (event.code === "Space" && !event.repeat && !event.ctrlKey && !event.metaKey && !interactive && !boardKeyBlocked(event, store.getState())) {
        event.preventDefault();
        setSpaceHeld(true);
      }
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceHeld(false);
    };
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  /* ── 全局快捷键 ───────────────────────────────── */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const state = store.getState();
      if (boardKeyBlocked(event, state)) return;
      const history = historyShortcut(event);
      if (history) {
        event.preventDefault();
        if (event.repeat || state.historyBusy) return;
        const action = history === "undo" ? state.undoHistory : state.redoHistory;
        void action().catch((error: Error) => state.showToast(error.message));
        return;
      }
      if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        setNodes((current) => current.map((node) => ({ ...node, selected: false })));
        state.setSelectedCardIds([]);
        state.setSelection(null);
        setEdgeMenu(null);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && (event.key === "=" || event.key === "+")) {
        event.preventDefault();
        flow.zoomIn();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "-") {
        event.preventDefault();
        flow.zoomOut();
        return;
      }
      if (!state.editingCardId && !event.metaKey && !event.ctrlKey) {
        if (event.key.toLowerCase() === "v") {
          state.setTool("select");
          return;
        }
        if (event.key.toLowerCase() === "h") {
          state.setTool("pan");
          return;
        }
        // C：给选中的那张卡加评论（右键 →「加评论」的键盘版）
        if (event.key.toLowerCase() === "c") {
          const target = state.selection?.kind === "card" ? state.selection.id : null;
          const card = target ? state.board?.cards.find((item) => item.id === target) : null;
          if (!card) return;
          // 输入框开在卡片右上角旁边——跟气泡将来落的位置是同一处，视线不用跳
          const screen = flow.flowToScreenPosition({ x: card.x + card.w, y: card.y });
          state.startComment({
            target: "card",
            targetId: card.id,
            x: null,
            y: null,
            screen: { x: screen.x + 8, y: screen.y },
          });
          return;
        }
        // R：进阅读模式。选中了就从那张开始，没选中就从整板阅读顺序的第一张开始通读
        if (event.key.toLowerCase() === "r") {
          const first = readingSequence(state.board?.cards, state.search, state.typeFilter)[0];
          const target = state.selection?.kind === "card" ? state.selection.id : first?.id;
          if (target) state.openReader(target);
          return;
        }
      }
      // ⌘C / Ctrl+C：复制选中的卡片（⌘V 粘到任意画板，见 BoardApp 的 paste 处理）
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && !state.editingCardId) {
        // 页面上正选着字就让浏览器复制那段字去，别抢
        if (window.getSelection()?.toString()) return;
        const ids = state.selectedCardIds.length
          ? state.selectedCardIds
          : state.selection?.kind === "card"
            ? [state.selection.id]
            : [];
        if (!ids.length) return;
        event.preventDefault();
        void state.copyCards(ids);
        return;
      }
      // ⌘A / Ctrl+A：全选当前画板卡片
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && !state.editingCardId) {
        event.preventDefault();
        setNodes((current) => current.map((node) => ({ ...node, selected: true })));
        state.setSelectedCardIds((state.board?.cards || []).map((card) => card.id));
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && !state.editingCardId) {
        const ids = state.selectedCardIds;
        if (ids.length > 1) {
          event.preventDefault();
          // 多选删除还是先问一句：一按 Del 少掉半块板，撤销窗口只有几秒，值得多这一下
          if (window.confirm(tr("canvas.confirm.deleteCards", { count: ids.length }))) {
            void state.deleteCardsWithUndo(ids);
          }
          return;
        }
        const selected = state.selection;
        if (selected?.kind === "card") {
          event.preventDefault();
          void state.deleteCardsWithUndo([selected.id]);
        } else if (selected?.kind === "edge") {
          event.preventDefault();
          void state.deleteEdgeWithUndo(selected.id);
          setEdgeMenu(null);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flow, store]);

  const empty = Boolean(board) && !(board?.cards || []).length;

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap tool-${panning ? "pan" : "select"}${dropping ? " dropping" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onSelectionDragStart={onNodeDragStart}
        onSelectionDragStop={onSelectionDragStop}
        onSelectionContextMenu={onSelectionContextMenu}
        onNodeDoubleClick={onNodeDoubleClick}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onEdgeClick={onEdgeClick}
        onEdgeContextMenu={openEdgeMenu}
        onPaneContextMenu={openPaneMenu}
        onPaneClick={onPaneClick}
        onMove={handleMove}
        onMoveEnd={handleMoveEnd}
        minZoom={ZOOM_MIN}
        maxZoom={ZOOM_MAX}
        zoomOnDoubleClick={false}
        panOnScroll
        // 选择模式：左键拖 = 框选，中键/右键拖 = 平移；平移模式反过来
        selectionOnDrag={!panning}
        panOnDrag={panning ? [0, 1, 2] : [1, 2]}
        // spaceHeld owns temporary panning and editor focus rules. React Flow's
        // default Space listener would preventDefault before that handler runs.
        panActivationKeyCode={null}
        /**
         * 抓手模式（含按住空格的临时抓手）下，卡片既不能拖走也不能拉线：
         * 手型光标承诺的是「抓的是画布」，此时从卡片上按下去就该平移整块板。
         * 少了这两条，同一个手势在卡片上和空白处会做两件完全不同的事——
         * 想平移却把压在光标下的那张卡拖跑了，是这个工具最容易踩的坑。
         * （缩放手柄同样要收，见 globals.css 的 .tool-pan .react-flow__resize-control）
         */
        nodesDraggable={!panning}
        nodesConnectable={!panning}
        /**
         * 吸附网格（工具条上的「吸附」开关，默认关）：拖动 / 缩放时卡片吸到画布点阵上。
         * 格距取 22 = `<Background gap={22}>` 的点距，吸完正好落在看得见的点上（见 lib/constants.ts）。
         * 不默认打开——已经习惯自由摆放的人会觉得手被拽住了，这该是主动选择。
         */
        snapToGrid={snapGrid && !(alignSnap && (dragging || resizing))}
        snapGrid={[SNAP_GRID, SNAP_GRID]}
        selectionMode={SelectionMode.Partial}
        selectNodesOnDrag={false}
        multiSelectionKeyCode={["Meta", "Shift", "Control"]}
        zoomOnScroll={false}
        zoomOnPinch
        preventScrolling
        // 大板才只渲染可视区：100 张 SVG 卡的板上屏幕里通常只看得到几张，
        // 其余没必要进 DOM 再让浏览器栅格化一遍（卡片都有确定的 w/h，满足这个开关的前提）
        onlyRenderVisibleElements={cullOffscreen}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
        nodesFocusable={false}
        edgesFocusable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={SNAP_GRID} size={1.1} color="#dcd9d0" />
        {/* 对齐参考线浮在卡片上方、面板下方；不吸附时 guides 是空的，这层直接不渲染 */}
        <AlignGuides guides={guides} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => COLORS[(node.data as CardNodeData)?.card?.color || "slate"] || COLORS.slate}
          nodeStrokeWidth={2}
          maskColor="rgba(246,245,241,.72)"
          style={{ width: 150, height: 100 }}
        />
        <Controls showInteractive={false} position="bottom-left" fitViewOptions={{
          // Controls reads options on click; a getter measures the current toolbox rather than an old render.
          get padding() { return canvasFitPadding(); }, maxZoom: 1.4, duration: 260,
        }}><KeyboardHelp /></Controls>
        {/* 多选批量条：NodeToolbar 的 nodeId 收数组，它会自己算出这几张卡的包围盒并浮在上沿。
            取项同样是「右键批量菜单里最常按的」——改色 / 并排对比 / 复制 / 删除。 */}
        {nodeToolbar && selectedCardIds.length > 1 ? (
          <SafeNodeToolbar
            nodeId={selectedCardIds}
            isVisible
            offset={16}
            className="node-bar nodrag nopan"
          >
            <span className="nb-count">{t("canvas.bar.count", { count: selectedCardIds.length })}</span>
            {COLOR_KEYS.map((color) => (
              <button
                key={color}
                className="nb-dot"
                style={{ background: COLORS[color] }}
                title={t("canvas.bar.recolorTitle")}
                aria-label={t("canvas.bar.recolor", { color })}
                data-color={color}
                onClick={() => {
                  const state = store.getState();
                  state
                    .patchCards(selectedCardIds, { color })
                    .then((count) => state.showToast(tr("canvas.toast.colored", { count })))
                    .catch((err: Error) => state.showToast(err.message));
                }}
              />
            ))}
            <span className="nb-sep" />
            <button
              className="nb-btn"
              title={t("canvas.bar.compareTitle", { count: Math.min(selectedCardIds.length, COMPARE_MAX) })}
              aria-label={t("canvas.bar.compare")}
              data-act="bar-compare"
              onClick={() => store.getState().openCompare(selectedCardIds)}
            >
              <UI.compare size={14} strokeWidth={2} />
            </button>
            <button
              className="nb-btn"
              title={t("canvas.bar.copyTitle")}
              aria-label={t("common.copy")}
              data-act="bar-copy"
              onClick={() => void store.getState().copyCards(selectedCardIds)}
            >
              <UI.copy size={14} strokeWidth={2} />
            </button>
            <button
              className="nb-btn danger"
              title={t("canvas.bar.deleteTitle")}
              aria-label={t("common.delete")}
              data-act="bar-delete"
              onClick={() => {
                // 跟右键批量菜单同一条规矩：一次几十张是另一档风险，确认还是要问
                if (!window.confirm(tr("canvas.confirm.deleteCards", { count: selectedCardIds.length }))) return;
                void store.getState().deleteCardsWithUndo(selectedCardIds);
              }}
            >
              <UI.remove size={14} strokeWidth={2} />
            </button>
          </SafeNodeToolbar>
        ) : null}
      </ReactFlow>

      {empty ? (
        <div className="empty-board">
          <div className="hintbox">
            {t("canvas.empty.title")}
            <br />
            {t("canvas.empty.hint")}
          </div>
        </div>
      ) : null}

      {edgeMenu && edgeMenuScreen && activeEdge ? (
        <EdgeToolbar
          edge={activeEdge}
          left={edgeMenuScreen.left}
          top={edgeMenuScreen.top}
          onClose={() => setEdgeMenu(null)}
        />
      ) : null}

      {children}

      <CommentLayer />

      <ContextMenu state={menu} onClose={() => setMenu(null)} />

      <PaneDoubleClick onDoubleClick={onPaneDoubleClick} />
    </div>
  );
}

/**
 * React Flow 的 pane 双击默认是缩放（已关掉），双击建卡挂在 .react-flow__pane 上。
 * 用一个空组件在挂载后绑事件，避免把整个画布包一层影响命中测试。
 */
function PaneDoubleClick({ onDoubleClick }: { onDoubleClick: (event: React.MouseEvent) => void }) {
  useEffect(() => {
    const pane = document.querySelector(".react-flow__pane");
    if (!pane) return;
    const handler = (event: Event) => onDoubleClick(event as unknown as React.MouseEvent);
    pane.addEventListener("dblclick", handler);
    return () => pane.removeEventListener("dblclick", handler);
  }, [onDoubleClick]);
  return null;
}

export type { BoardCard };

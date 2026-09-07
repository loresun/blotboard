"use client";

/**
 * 工具条——按钮从卡片包注册表派生（cards/&lt;type&gt;/ui.tsx 的 toolbar 槽位）。
 *
 * 一个按钮要显示，得过两道闸：
 *  ① 卡片包启用（卡片中心的开关，store.cardPacks；没拉到清单前默认全显示）；
 *  ② 包声明的可选集成配置了（阶段 A 的 feature：ref 要 search、book 要 library）。
 * 停用一个包 = 这里的入口消失 + 服务端新建 400；画板上已有的卡照常渲染。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type FocusEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useReactFlow } from "@xyflow/react";
import { useFeatures } from "@/lib/features-client";
import { useBoardStore } from "@/lib/store";
import { UPLOAD_ACCEPT } from "@/lib/upload-accept";
import { SNAP_GRID, TYPE_META } from "@/lib/constants";
import { ICON_SM, typeIcon, UI } from "@/lib/icons";
import { CLIENT_CARD_PACKS } from "@/lib/card-registry-client";
import { useCardLabel, useT, tr } from "@/lib/i18n/client";
import { hasDictKey, type DictKey } from "@/lib/i18n";
import type { CardToolbarCtx, CardToolbarSpec } from "@/lib/card-pack-client";
import type { CardType } from "@/lib/types";

interface ToolbarEntry {
  type: CardType;
  /** 包自己写的那句（第三方包可能就只有这一句），译文找不到时按它显示 */
  label: string;
  spec: CardToolbarSpec;
}

type ToolbarHelpKey = "outline" | "focus" | "align" | "grid" | "nodebar";

/** 文案走字典：`toolbar.help.<key>.title` 是标题，`.body` 是那段解释（网格那条吃 {size}） */
const TOOLBAR_HELP: Record<ToolbarHelpKey, { titleKey: DictKey; bodyKey: DictKey }> = {
  outline: { titleKey: "toolbar.help.outline.title", bodyKey: "toolbar.help.outline.body" },
  focus: { titleKey: "toolbar.help.focus.title", bodyKey: "toolbar.help.focus.body" },
  align: { titleKey: "toolbar.help.align.title", bodyKey: "toolbar.help.align.body" },
  grid: { titleKey: "toolbar.help.grid.title", bodyKey: "toolbar.help.grid.body" },
  nodebar: { titleKey: "toolbar.help.nodebar.title", bodyKey: "toolbar.help.nodebar.body" },
};

interface ToolbarHelpCard {
  key: ToolbarHelpKey;
  left: number;
  top: number;
  width: number;
  arrowX: number;
}

const HELP_DELAY_MS = 320;
const HELP_WIDTH = 300;
const HELP_MARGIN = 12;

/** 注册表里声明了工具条入口的包，按 group + order 排好（模块级算一次就够）。 */
const TOOLBAR_ENTRIES: ToolbarEntry[] = Object.values(CLIENT_CARD_PACKS)
  .filter((pack) => pack.ui?.toolbar)
  .map((pack) => ({ type: pack.meta.type, label: pack.ui!.toolbar!.label || pack.meta.label, spec: pack.ui!.toolbar! }))
  .sort((a, b) => a.spec.group - b.spec.group || a.spec.order - b.spec.order);

export function Toolbar({ onUploadFiles }: { onUploadFiles: (files: File[]) => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [help, setHelp] = useState<ToolbarHelpCard | null>(null);
  const helpTimer = useRef<number | null>(null);
  const focusMode = useBoardStore((state) => state.focusMode);
  const outline = useBoardStore((state) => state.viewMode === "outline");
  const snapGrid = useBoardStore((state) => state.snapGrid);
  const alignSnap = useBoardStore((state) => state.alignSnap);
  const nodeBar = useBoardStore((state) => state.nodeToolbar);
  const collapsed = useBoardStore((state) => state.toolboxCollapsed);
  // 收起时筛选还在生效（卡片仍是淡的），小按钮上得留个点提示
  const filterActive = useBoardStore((state) => Boolean(state.search.trim() || state.typeFilter.length));
  // 卡片包开关：null = 清单还没拉到（先全显示，拉到后立即收敛）
  const cardPacks = useBoardStore((state) => state.cardPacks);
  // 可选集成没配就整个不渲染入口（已有的 ref/book 卡照常显示，只是没有新建入口）
  const features = useFeatures();
  const flow = useReactFlow();
  const t = useT();
  const cardLabel = useCardLabel();

  const clearHelpTimer = useCallback(() => {
    if (helpTimer.current === null) return;
    window.clearTimeout(helpTimer.current);
    helpTimer.current = null;
  }, []);

  const hideHelp = useCallback(() => {
    clearHelpTimer();
    setHelp(null);
  }, [clearHelpTimer]);

  const showHelp = useCallback(
    (key: ToolbarHelpKey, target: HTMLButtonElement, delayed: boolean) => {
      clearHelpTimer();
      const open = () => {
        helpTimer.current = null;
        if (!target.isConnected) return;
        const rect = target.getBoundingClientRect();
        const width = Math.min(HELP_WIDTH, window.innerWidth - HELP_MARGIN * 2);
        const idealLeft = rect.left + rect.width / 2 - width / 2;
        const left = Math.max(HELP_MARGIN, Math.min(idealLeft, window.innerWidth - width - HELP_MARGIN));
        setHelp({
          key,
          left,
          top: rect.bottom + 9,
          width,
          arrowX: Math.max(14, Math.min(rect.left + rect.width / 2 - left, width - 14)),
        });
      };
      if (delayed) helpTimer.current = window.setTimeout(open, HELP_DELAY_MS);
      else open();
    },
    [clearHelpTimer],
  );

  useEffect(() => () => clearHelpTimer(), [clearHelpTimer]);

  const helpProps = (key: ToolbarHelpKey) => ({
    "data-help-key": key,
    "aria-describedby": help?.key === key ? "toolbar-help-card" : undefined,
    onPointerEnter: (event: PointerEvent<HTMLButtonElement>) => showHelp(key, event.currentTarget, true),
    onPointerLeave: hideHelp,
    onFocus: (event: FocusEvent<HTMLButtonElement>) => showHelp(key, event.currentTarget, false),
    onBlur: hideHelp,
  });

  /** 子画板：先建一块空板，再在当前板上放一张指向它的卡（用户也可以之后改指向别的板） */
  async function addSubBoard() {
    const state = useBoardStore.getState();
    if (!state.boardId) {
      state.showToast(tr("toolbar.toast.needBoard"));
      return;
    }
    try {
      // 挂在当前板下面：左栏就会缩进显示，分组也自动继承
      const created = await state.createBoard(tr("toolbar.subboard.name"), { parentId: state.boardId });
      const card = await state.createCard({
        type: "board",
        title: created.name,
        boardRef: { boardId: created.id, name: created.name },
        ...centerPosition(flow, "board"),
      });
      state.setEditing(card.id);
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  async function add(type: CardType) {
    const state = useBoardStore.getState();
    if (!state.boardId) {
      state.showToast(tr("toolbar.toast.needBoard"));
      return;
    }
    try {
      // 新卡片落在视口中心附近（略随机避免完全重叠），与旧版一致
      const card = await state.createCard({ type, ...centerPosition(flow, type) });
      state.setEditing(card.id);
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  const ctx: CardToolbarCtx = { add: (type) => void add(type), addSubBoard: () => void addSubBoard() };

  // 点别处 / Esc 收起「更多」——面板挡着画布时点一下就能继续画
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const visible = TOOLBAR_ENTRIES.filter((entry) => {
    if (cardPacks && cardPacks[entry.type] === false) return false;
    if (entry.spec.feature && !features[entry.spec.feature]) return false;
    return true;
  });
  // 1、2 组常驻；3、4 组收进「更多」——十八个按钮排一行会把画布顶到屏幕外
  const group1 = visible.filter((entry) => entry.spec.group === 1);
  const group2 = visible.filter((entry) => entry.spec.group === 2);
  const overflow = visible.filter((entry) => entry.spec.group >= 3);
  const helpStates: Record<ToolbarHelpKey, boolean> = {
    outline,
    focus: focusMode,
    align: alignSnap,
    grid: snapGrid,
    nodebar: nodeBar,
  };

  // 收起态：整个工具箱（工具条 + 搜索）缩成一颗小按钮，画布留给内容
  if (collapsed) {
    return (
      <button
        className="toolbar toolbar-fab"
        title={t("toolbar.fab.title")}
        onClick={() => useBoardStore.getState().setToolboxCollapsed(false)}
      >
        <UI.blocks {...ICON_SM} /> {t("toolbar.fab")}
        {filterActive ? <span className="tb-fab-dot" title={t("toolbar.fab.filter")} /> : null}
        {focusMode ? <span className="tb-fab-dot focus" title={t("toolbar.fab.focus")} /> : null}
      </button>
    );
  }

  /**
   * 按钮上的字与 tooltip 都在**渲染期**解析：TOOLBAR_ENTRIES 是模块加载时算的，
   * 把文案定死在那儿就跟不上语言切换。内置包的译文按约定停在 `cards.<type>.toolbar`
   * （包自己覆盖过 label 的两个另有 `.toolbarLabel`）；第三方包没有对应键，
   * 就照它自己写的那句显示。
   */
  const entryLabel = (entry: ToolbarEntry) => {
    const key = `cards.${entry.type}.toolbarLabel`;
    if (hasDictKey(key)) return t(key);
    // 没覆盖过的用卡片类型名本身，跟画布上、列表里的叫法保持一致
    return entry.spec.label ? entry.label : cardLabel(entry.type);
  };
  const entryTitle = (entry: ToolbarEntry) => {
    const key = `cards.${entry.type}.toolbar`;
    return hasDictKey(key) ? t(key) : entry.spec.title;
  };

  const renderEntry = (entry: ToolbarEntry) => {
    const Icon = typeIcon(entry.type);
    return (
      <button key={entry.type} data-add={entry.type} title={entryTitle(entry)} onClick={() => entry.spec.onClick(ctx)}>
        <Icon {...ICON_SM} /> {entryLabel(entry)}
      </button>
    );
  };

  return (
    <div className="toolbar">
      {group1.map(renderEntry)}
      {group1.length && group2.length ? <span className="tb-sep" /> : null}
      {group2.map(renderEntry)}
      {overflow.length ? (
        <div className="tb-more" ref={moreRef}>
          <button
            className={`tb-toggle${moreOpen ? " on" : ""}`}
            data-act="toolbar-more"
            title={t("toolbar.more.title")}
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
          >
            <UI.more {...ICON_SM} /> {t("toolbar.more")}
          </button>
          {moreOpen ? (
            <div className="tb-more-panel" role="menu">
              {[3, 4].map((group) => {
                const items = overflow.filter((entry) => entry.spec.group === group);
                if (!items.length) return null;
                return (
                  <div key={group} className="tb-more-group">
                    <div className="tb-more-cap">{group === 3 ? t("toolbar.more.structure") : t("toolbar.more.external")}</div>
                    {items.map((entry) => {
                      const Icon = typeIcon(entry.type);
                      return (
                        <button
                          key={entry.type}
                          data-add={entry.type}
                          title={entryTitle(entry)}
                          onClick={() => {
                            entry.spec.onClick(ctx);
                            setMoreOpen(false);
                          }}
                        >
                          <Icon {...ICON_SM} /> {entryLabel(entry)}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {!features.browserStorage ? <>
        <span className="tb-sep" />
        <button title={t("toolbar.upload.title")} onClick={() => inputRef.current?.click()}>
          <UI.upload {...ICON_SM} /> {t("toolbar.upload")}
        </button>
      </> : null}
      <span className="tb-sep" />
      {/* 大纲跟「聚焦」摆在一起：两者都是「换个方式看同一块板」，不是建卡工具 */}
      <button
        className={`tb-toggle${outline ? " on" : ""}`}
        data-act="view-outline"
        {...helpProps("outline")}
        aria-pressed={outline}
        onClick={() => useBoardStore.getState().setViewMode(outline ? "canvas" : "outline")}
      >
        <UI.outlineView {...ICON_SM} /> {t("toolbar.outline")}
      </button>
      <button
        className={`tb-toggle${focusMode ? " on" : ""}`}
        data-act="toggle-focus"
        {...helpProps("focus")}
        aria-pressed={focusMode}
        onClick={() => useBoardStore.getState().toggleFocusMode()}
      >
        <UI.target {...ICON_SM} /> {t("toolbar.focus")}
      </button>
      <button
        className={`tb-toggle${alignSnap ? " on" : ""}`}
        data-act="toggle-alignsnap"
        {...helpProps("align")}
        aria-pressed={alignSnap}
        onClick={() => useBoardStore.getState().toggleAlignSnap()}
      >
        <UI.align {...ICON_SM} /> {t("toolbar.align")}
      </button>
      <button
        className={`tb-toggle${snapGrid ? " on" : ""}`}
        data-act="toggle-snapgrid"
        {...helpProps("grid")}
        aria-pressed={snapGrid}
        onClick={() => useBoardStore.getState().toggleSnapGrid()}
      >
        <UI.grid {...ICON_SM} /> {t("toolbar.grid")}
      </button>
      <button
        className={`tb-toggle${nodeBar ? " on" : ""}`}
        data-act="toggle-nodebar"
        {...helpProps("nodebar")}
        aria-pressed={nodeBar}
        onClick={() => useBoardStore.getState().toggleNodeToolbar()}
      >
        <UI.more {...ICON_SM} /> {t("toolbar.nodebar")}
      </button>
      <button
        className="tb-collapse"
        title={t("toolbar.collapse.title")}
        aria-label={t("toolbar.collapse.aria")}
        onClick={() => {
          hideHelp();
          useBoardStore.getState().setToolboxCollapsed(true);
        }}
      >
        <UI.chevron size={14} strokeWidth={2} />
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={UPLOAD_ACCEPT}
        multiple
        style={{ display: "none" }}
        onChange={async (event) => {
          const files = [...(event.target.files || [])];
          event.target.value = "";
          if (files.length) await onUploadFiles(files);
        }}
      />
      {help && typeof document !== "undefined"
        ? createPortal(
            <div
              id="toolbar-help-card"
              className="toolbar-help-card"
              role="tooltip"
              data-help-for={help.key}
              style={
                {
                  left: help.left,
                  top: help.top,
                  width: help.width,
                  "--toolbar-help-arrow-x": `${help.arrowX}px`,
                } as CSSProperties
              }
            >
              <div className="toolbar-help-head">
                <strong>{t(TOOLBAR_HELP[help.key].titleKey)}</strong>
                <span className={helpStates[help.key] ? "on" : ""}>
                  {helpStates[help.key] ? t("toolbar.help.on") : t("toolbar.help.off")}
                </span>
              </div>
              <p>{t(TOOLBAR_HELP[help.key].bodyKey, { size: SNAP_GRID })}</p>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** 新卡片落在当前视口中心附近（略随机避免完全重叠），与旧版一致。 */
function centerPosition(flow: ReturnType<typeof useReactFlow>, type: CardType): Record<string, number> {
  const wrap = document.querySelector(".canvas-wrap");
  if (!wrap) return {};
  const rect = wrap.getBoundingClientRect();
  const center = flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  const [w, h] = TYPE_META[type].size;
  return {
    x: Math.round(center.x - w / 2 + Math.random() * 36),
    y: Math.round(center.y - h / 2 + Math.random() * 30),
  };
}

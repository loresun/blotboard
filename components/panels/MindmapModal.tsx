"use client";

/**
 * 思维导图编辑：全屏弹窗。
 *
 * 为什么不跟别的卡片一样用右侧抽屉——导图不是一段文字，是一张要看全局的图：
 * 抽屉只有 520px 宽，稍微展开两层就横向溢出，节点之间的关系反而看不见了。
 * 这里给整屏画布，1:1 渲染，跟卡面用的是同一个 MindmapView。
 */
import { useEffect, useState } from "react";
import { MindmapView } from "../mindmap/MindmapView";
import { COLORS } from "@/lib/constants";
import { useT } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";
import { ICON_MD, ICON_SM, UI } from "@/lib/icons";
import {
  addChild,
  addSibling,
  countNodes,
  emptyMindmap,
  mindmapToOutline,
  moveNode,
  outlineToMindmap,
  removeNode,
  updateNode,
} from "@/lib/mindmap";
import { useBoardStore } from "@/lib/store";
import { MIND_LAYOUTS, MIND_THEMES, type CardColor, type MindLayout, type MindNode, type MindTheme } from "@/lib/types";

const LAYOUT_LABEL: Record<MindLayout, DictKey> = {
  right: "panels.mindmap.layout.right",
  both: "panels.mindmap.layout.both",
};
const THEME_LABEL: Record<MindTheme, DictKey> = {
  classic: "panels.mindmap.theme.classic",
  pill: "panels.mindmap.theme.pill",
  plain: "panels.mindmap.theme.plain",
  card: "panels.mindmap.theme.card",
};

export function MindmapModal() {
  const open = useBoardStore((state) => state.drawer === "mindmap");
  const editingCardId = useBoardStore((state) => state.editingCardId);
  const card = useBoardStore((state) =>
    editingCardId ? state.board?.cards.find((item) => item.id === editingCardId) || null : null,
  );

  const t = useT();
  const [title, setTitle] = useState("");
  const [color, setColor] = useState<CardColor>("green");
  const [root, setRoot] = useState<MindNode>(() => emptyMindmap().root);
  const [layout, setLayout] = useState<MindLayout>("right");
  const [theme, setTheme] = useState<MindTheme>("classic");
  const [focusId, setFocusId] = useState<string | null>(null);
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [outline, setOutline] = useState<string | null>(null);
  // 大图默认铺满看全局；要仔细改字再切回 1:1（缩小后的输入框不好点）
  const [fitView, setFitView] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!card) return;
    setTitle(card.title || "");
    setColor(card.color);
    setRoot(card.mindmap?.root || emptyMindmap().root);
    setLayout(card.mindmap?.layout || "right");
    setTheme(card.mindmap?.theme || "classic");
    setOutline(null);
    setFocusId(null);
  }, [card?.id]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") void close(true);
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void close(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  async function close(save: boolean) {
    const state = useBoardStore.getState();
    if (save && card) {
      setBusy(true);
      try {
        await state.patchCard(card.id, { title: title.trim(), color, mindmap: { root, layout, theme } });
      } catch (err) {
        state.showToast((err as Error).message);
      } finally {
        setBusy(false);
      }
    }
    state.setEditing(null);
  }

  function onNodeKeyDown(event: React.KeyboardEvent<HTMLInputElement>, node: MindNode) {
    if (event.key === "Tab") {
      event.preventDefault();
      const { root: next, created } = addChild(root, node.id);
      setRoot(next);
      setPendingFocus(created.id);
      return;
    }
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      const sibling = addSibling(root, node.id);
      // 根节点没有兄弟，这时 Enter 当「加一个分支」用
      const result = sibling.created ? sibling : { ...addChild(root, node.id) };
      setRoot(result.root);
      setPendingFocus(result.created!.id);
      return;
    }
    if (event.key === "Backspace" && !node.text && node.id !== root.id) {
      event.preventDefault();
      setRoot(removeNode(root, node.id));
      setPendingFocus(null);
    }
  }

  if (!open || !card) return null;

  const focusNode = focusId ? findNode(root, focusId) : null;

  return (
    <div className="modal-backdrop" onPointerDown={(event) => event.target === event.currentTarget && void close(true)}>
      <div className="modal mind-modal" role="dialog" aria-modal="true" aria-label={t("panels.mindmap.title")}>
        <div className="modal-head">
          <h2>
            <UI.rows size={17} strokeWidth={1.8} /> {t("panels.mindmap.title")}
          </h2>
          <input
            className="mind-title"
            placeholder={t("panels.cardTitle.placeholder")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <div className="scope-switch">
            {MIND_LAYOUTS.map((value) => (
              <button key={value} className={layout === value ? "on" : ""} onClick={() => setLayout(value)}>
                {t(LAYOUT_LABEL[value])}
              </button>
            ))}
          </div>
          <div className="scope-switch">
            {MIND_THEMES.map((value) => (
              <button key={value} className={theme === value ? "on" : ""} onClick={() => setTheme(value)}>
                {t(THEME_LABEL[value])}
              </button>
            ))}
          </div>
          <span className="colors">
            {(Object.entries(COLORS) as [CardColor, string][]).map(([key, hex]) => (
              <button
                key={key}
                type="button"
                className={`swatch${color === key ? " active" : ""}`}
                style={{ background: hex }}
                title={key}
                onClick={() => setColor(key)}
              />
            ))}
          </span>
          <span className="foot-spacer" />
          <span className="hint mono">{t("panels.mindmap.nodes", { count: countNodes(root) })}</span>
          <button
            className={`mini-btn${fitView ? " primary" : ""}`}
            title={t("panels.mindmap.fit.title")}
            onClick={() => setFitView((value) => !value)}
          >
            <UI.fit {...ICON_SM} /> {t("panels.mindmap.fit")}
          </button>
          <button
            className="mini-btn"
            title={t("panels.mindmap.outline.title")}
            onClick={() => setOutline(outline === null ? mindmapToOutline(root) : null)}
          >
            <UI.rows {...ICON_SM} /> {t("panels.mindmap.outline")}
          </button>
          <button className="mini-btn primary" disabled={busy} onClick={() => void close(true)}>
            <UI.check {...ICON_SM} /> {t("panels.saveAndClose")}
          </button>
          <button className="drawer-close" title={t("panels.closeNoSave")} onClick={() => void close(false)}>
            <UI.close {...ICON_MD} />
          </button>
        </div>

        <div className="mind-modal-body" style={{ ["--card-accent" as string]: COLORS[color] }}>
          {outline !== null ? (
            <div className="mind-outline-pane">
              <div className="hint">{t("panels.mindmap.outline.hint")}</div>
              <textarea className="mind-outline" value={outline} onChange={(event) => setOutline(event.target.value)} />
              <div className="config-actions">
                <button
                  className="mini-btn primary"
                  onClick={() => {
                    const parsed = outlineToMindmap(outline);
                    if (parsed) setRoot(parsed.root);
                    setOutline(null);
                  }}
                >
                  <UI.check {...ICON_SM} /> {t("panels.mindmap.outline.apply")}
                </button>
                <button className="mini-btn" onClick={() => setOutline(null)}>
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <MindmapView
              root={root}
              layout={layout}
              theme={theme}
              fit={fitView}
              editable
              autoFocusId={pendingFocus}
              onFocusNode={(id) => {
                setFocusId(id);
                if (pendingFocus === id) setPendingFocus(null);
              }}
              onChangeText={(id, text) => setRoot(updateNode(root, id, (node) => ({ ...node, text })))}
              onToggleCollapse={(id) => setRoot(updateNode(root, id, (node) => ({ ...node, collapsed: !node.collapsed })))}
              onNodeKeyDown={onNodeKeyDown}
            />
          )}
        </div>

        <div className="mind-modal-foot">
          <span className="hint">{t("panels.mindmap.hint")}</span>
          <span className="foot-spacer" />
          {focusNode && focusNode.id !== root.id ? (
            <>
              <span className="hint">
                {t("panels.mindmap.selected", { text: focusNode.text || t("panels.mindmap.emptyNode") })}
              </span>
              <button className="mini-btn" onClick={() => setRoot(moveNode(root, focusNode.id, -1))}>
                {t("panels.mindmap.moveUp")}
              </button>
              <button className="mini-btn" onClick={() => setRoot(moveNode(root, focusNode.id, 1))}>
                {t("panels.mindmap.moveDown")}
              </button>
              <button
                className="mini-btn"
                onClick={() => {
                  setRoot(removeNode(root, focusNode.id));
                  setFocusId(null);
                }}
              >
                <UI.remove {...ICON_SM} /> {t("panels.mindmap.removeBranch")}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function findNode(node: MindNode, id: string): MindNode | null {
  if (node.id === id) return node;
  for (const child of node.children || []) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

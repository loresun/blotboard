"use client";

/**
 * Excalidraw 全屏编辑弹窗。
 *
 * 为什么不跟其它卡片一样用右侧抽屉——Excalidraw 自己就是一张画布，
 * 塞进 520px 抽屉几乎画不开。这里给整屏。
 *
 * 为什么不再 iframe 嵌本地 Excalidraw 站点（8567 → localhost:3001）：
 * 跨源 iframe 只能靠 postMessage 交换数据，而官方站点根本不实现那套桥，
 * 于是「画完的东西回不到卡片」——之前只能退化成「手工粘 .excalidraw JSON」。
 * 现在直接用官方的 @excalidraw/excalidraw React 组件，画布就在本进程里，
 * 保存时同步拿到场景 + 缩略图，卡面立刻能显示。JSON 面板留着，
 * 依旧可以把外面画的 .excalidraw 粘进来 / 把这张画拷出去。
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { COLORS, MAX_EXCALIDRAW_SOURCE, MAX_EXCALIDRAW_THUMBNAIL } from "@/lib/constants";
import {
  loadExcalidraw,
  parseScene,
  restoreScene,
  sceneToThumbnail,
  serializeScene,
  type ExcalidrawScene,
} from "@/lib/excalidraw-scene";
import { useT, tr } from "@/lib/i18n/client";
import { ICON_MD, ICON_SM, UI } from "@/lib/icons";
import { useBoardStore } from "@/lib/store";
import type { CardColor } from "@/lib/types";

/** 编辑器整包（含 CSS）只在双击卡片时才下载 */
const ExcalidrawCanvas = dynamic(() => import("./ExcalidrawCanvas").then((module) => module.ExcalidrawCanvas), {
  ssr: false,
  loading: () => <div className="excalidraw-loading">{tr("panels.excalidraw.loading")}</div>,
});

export function ExcalidrawModal() {
  const open = useBoardStore((state) => state.drawer === "excalidraw");
  const editingCardId = useBoardStore((state) => state.editingCardId);
  const card = useBoardStore((state) =>
    editingCardId ? state.board?.cards.find((item) => item.id === editingCardId) || null : null,
  );

  const t = useT();
  const [title, setTitle] = useState("");
  const [color, setColor] = useState<CardColor>("amber");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jsonDraft, setJsonDraft] = useState<string | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const dirtyRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const cardId = card?.id || null;
  const source = card?.excalidraw?.source || "";
  // 只在换卡时解析一次：Excalidraw 也只在挂载时读 initialData
  const initialScene = useMemo<ExcalidrawScene | null>(() => parseScene(source), [cardId]); // eslint-disable-line react-hooks/exhaustive-deps
  const brokenSource = Boolean(source.trim()) && !initialScene;

  useEffect(() => {
    if (!card) return;
    setTitle(card.title || "");
    setColor(card.color);
    setBusy(false);
    setError(brokenSource ? tr("panels.excalidraw.brokenSource") : null);
    setJsonDraft(null);
    apiRef.current = null;
    dirtyRef.current = false;
  }, [cardId]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 把画布 + 标题/颜色一起落库；画布没动过就只写元数据。 */
  const saveAll = useCallback(async () => {
    const state = useBoardStore.getState();
    if (!card) return;
    const patch: Record<string, unknown> = {};
    const nextTitle = title.trim();
    if (nextTitle !== (card.title || "")) patch.title = nextTitle;
    if (color !== card.color) patch.color = color;

    const api = apiRef.current;
    if (api && dirtyRef.current) {
      const scene: ExcalidrawScene = {
        elements: [...api.getSceneElements()],
        appState: api.getAppState(),
        files: api.getFiles(),
      };
      const nextSource = await serializeScene(scene);
      if (nextSource.length > MAX_EXCALIDRAW_SOURCE) {
        throw new Error(
          tr("panels.excalidraw.tooBig", {
            size: Math.round(nextSource.length / 1024),
            max: Math.round(MAX_EXCALIDRAW_SOURCE / 1024),
          }),
        );
      }
      // 缩略图失败不该拦住保存——卡面还能拿 source 实时渲染
      let thumbnail = "";
      try {
        thumbnail = await sceneToThumbnail(scene, MAX_EXCALIDRAW_THUMBNAIL);
      } catch {
        thumbnail = "";
      }
      patch.excalidraw = { source: nextSource, thumbnail: thumbnail || undefined, updatedAt: Date.now() };
    }
    if (Object.keys(patch).length) await state.patchCard(card.id, patch);
    dirtyRef.current = false;
  }, [card, title, color]);

  const close = useCallback(
    async (save: boolean) => {
      const state = useBoardStore.getState();
      if (save && card) {
        setBusy(true);
        try {
          await saveAll();
        } catch (err) {
          // 保存失败就别关窗：关了这张画就真没了
          const message = (err as Error).message;
          setBusy(false);
          setError(message);
          state.showToast(message);
          return;
        }
        setBusy(false);
      }
      state.setEditing(null);
    },
    [card, saveAll],
  );

  // Esc / ⌘+Enter：保存并关闭。
  // Esc 在画布里另有含义（取消当前工具 / 取消选中），所以焦点在画布内时不接管。
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        if (bodyRef.current?.contains(event.target as Node)) return;
        void close(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void close(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  /** JSON 面板：把 textarea 里的 .excalidraw JSON 灌进当前画布 */
  async function applyJson() {
    const api = apiRef.current;
    const draft = jsonDraft ?? "";
    if (!api) return;
    const scene = parseScene(draft);
    if (!scene) {
      setError(tr("panels.excalidraw.badJson"));
      return;
    }
    try {
      const lib = await loadExcalidraw();
      const restored = await restoreScene(scene);
      api.updateScene({
        elements: restored.elements,
        appState: restored.appState,
        captureUpdate: lib.CaptureUpdateAction.IMMEDIATELY,
      });
      api.addFiles(Object.values(restored.files || {}));
      api.scrollToContent(restored.elements, { fitToContent: true });
      dirtyRef.current = true;
      setError(null);
      setJsonDraft(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /** 打开 JSON 面板：优先导出画布上的现状，画布还没就绪就退回卡里存的 source */
  async function openJson() {
    const api = apiRef.current;
    if (!api) {
      setJsonDraft(source);
      return;
    }
    try {
      setJsonDraft(
        await serializeScene({
          elements: [...api.getSceneElements()],
          appState: api.getAppState(),
          files: api.getFiles(),
        }),
      );
    } catch {
      setJsonDraft(source);
    }
  }

  if (!open || !card) return null;

  const savedAt = card.excalidraw?.updatedAt;

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(event) => event.target === event.currentTarget && void close(true)}
    >
      <div className="modal excalidraw-modal" role="dialog" aria-modal="true" aria-label={t("panels.excalidraw.title")}>
        <div className="modal-head">
          <h2>
            <UI.edit {...ICON_SM} /> Excalidraw
          </h2>
          <input
            className="mind-title"
            placeholder={t("panels.cardTitle.placeholder")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
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
          {savedAt ? (
            <span className="meta-chip dim" title={t("panels.excalidraw.savedAt")}>
              {new Date(savedAt).toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </span>
          ) : null}
          <button
            className={`mini-btn${jsonDraft !== null ? " primary" : ""}`}
            title={t("panels.excalidraw.json.title")}
            onClick={() => (jsonDraft === null ? void openJson() : setJsonDraft(null))}
          >
            <UI.detail {...ICON_SM} /> JSON
          </button>
          <button className="mini-btn primary" disabled={busy} onClick={() => void close(true)}>
            <UI.check {...ICON_SM} /> {busy ? t("panels.excalidraw.saving") : t("panels.saveAndClose")}
          </button>
          <button className="drawer-close" title={t("panels.closeNoSave")} onClick={() => void close(false)}>
            <UI.close {...ICON_MD} />
          </button>
        </div>
        <div className="excalidraw-modal-body" ref={bodyRef} style={{ ["--card-accent" as string]: COLORS[color] }}>
          <div className="excalidraw-stage">
            <ExcalidrawCanvas
              key={card.id}
              scene={initialScene}
              onApi={(api) => {
                apiRef.current = api;
              }}
              onChange={() => {
                dirtyRef.current = true;
              }}
            />
          </div>
          {jsonDraft !== null ? (
            <div className="excalidraw-json-pane">
              <div className="hint">{t("panels.excalidraw.json.hint")}</div>
              <textarea
                className="excalidraw-source-input"
                placeholder={t("panels.excalidraw.json.placeholder")}
                value={jsonDraft}
                onChange={(event) => setJsonDraft(event.target.value)}
                spellCheck={false}
              />
              <div className="excalidraw-source-meta">
                <span className="meta-chip mono" title={t("panels.excalidraw.json.length")}>
                  {jsonDraft.length} chars
                </span>
                <span className="foot-spacer" />
                <button className="mini-btn" onClick={() => setJsonDraft(null)}>
                  {t("panels.excalidraw.json.collapse")}
                </button>
                <button className="mini-btn primary" onClick={() => void applyJson()} disabled={!jsonDraft.trim()}>
                  <UI.check {...ICON_SM} /> {t("panels.excalidraw.json.load")}
                </button>
              </div>
            </div>
          ) : null}
          {error ? <div className="excalidraw-error">{error}</div> : null}
        </div>
        <div className="mind-modal-foot">
          <span className="hint">{t("panels.excalidraw.hint")}</span>
        </div>
      </div>
    </div>
  );
}

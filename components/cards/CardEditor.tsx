"use client";

/**
 * 卡片编辑器（双击卡片 → 右侧抽屉）——外壳。
 *
 * 公共部分（标题 / 颜色 / agent 指令 / 自动保存 / 提交快捷键）在这里；
 * 各类型的专属字段区在 cards/&lt;type&gt;/ui.tsx 的 editor 槽位
 * （draftFrom / buildPatch / Fields 三件套），经 lib/card-registry-client.ts 分派。
 * 没有 editor 的类型（image / pdf / mindmap，以及未知类型）只有公共字段。
 *
 * **自动保存**：给了 onAutoSave 就停手 800ms 存一次，卸载时把还没到点的那次补上。
 * 以前抽屉开着时点一下画布空白就 setEditing(null)，写了半天的正文当场没了——
 * 一个「关掉就丢」的编辑器，用户每次点击都得先想一下点在哪，这个成本比省下的一次请求贵得多。
 * 「存什么」由 draftFrom / buildPatch 一对函数决定：草稿与卡片走同一条构造路径，
 * 两边算出来的 patch 一模一样就说明没改过，自动保存直接跳过（省掉开一张卡就白写一次盘）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { COLORS } from "@/lib/constants";
import { UI, ICON_SM } from "@/lib/icons";
import { clientPack } from "@/lib/card-registry-client";
import type { CardPatch } from "@/lib/card-pack-client";
import { useBoardStore } from "@/lib/store";
import { useT } from "@/lib/i18n/client";
import type { BoardCard, CardColor } from "@/lib/types";

export type { CardPatch };

/** 停手多久落一次盘：短到丢不了东西，长到一句话打完只写一次 */
const AUTOSAVE_MS = 800;

export function CardEditor({
  card,
  variant = "inline",
  onCommit,
  onAutoSave,
  onCancel,
}: {
  card: BoardCard;
  variant?: "inline" | "drawer";
  onCommit: (patch: CardPatch) => void;
  /** 给了就开自动保存（停手 800ms 一次 + 卸载补一次）；不给就是老的「提交才存」 */
  onAutoSave?: (cardId: string, patch: CardPatch) => void;
  onCancel: () => void;
}) {
  void onCancel; // 提交语义与老版一致：Esc 也是保存（onCancel 由外层备用）
  const t = useT();
  const roomy = variant === "drawer";
  const editorPack = clientPack(card.type)?.ui?.editor;
  const isUnknownType = !clientPack(card.type);

  const [title, setTitle] = useState(card.title || "");
  const [color, setColor] = useState<CardColor>(card.color);
  const [agentPrompt, setAgentPrompt] = useState(card.agentPrompt || "");
  /** 阅读例外（跳过 / 显式序号）——公共字段，跟颜色一样不归卡片包管 */
  const [readSkip, setReadSkip] = useState(card.reading?.skip === true);
  const [readOrder, setReadOrder] = useState(
    typeof card.reading?.order === "number" ? String(card.reading.order) : "",
  );
  const [packDraft, setPackDraft] = useState<Record<string, any>>(() => editorPack?.draftFrom(card) || {});
  const [showPrompt, setShowPrompt] = useState(Boolean(card.agentPrompt));
  /** 包报上来的「先别自动保存」原因（如 html 卡地址不在白名单） */
  const [blocked, setBlockedState] = useState<string | null>(null);
  const setBlocked = useCallback((reason: string | null) => setBlockedState(reason), []);
  const firstRef = useRef<HTMLInputElement | null>(null);

  // 换一张卡时把草稿全部重置——抽屉是常驻的，不换 key 就会把上一张的内容带过来。
  // Fields 用 key=card.id 整体重挂，包内的临时状态（预览开关 / 待敲的一条待办）随之清零。
  useEffect(() => {
    setTitle(card.title || "");
    setColor(card.color);
    setAgentPrompt(card.agentPrompt || "");
    setReadSkip(card.reading?.skip === true);
    setReadOrder(typeof card.reading?.order === "number" ? String(card.reading.order) : "");
    setPackDraft(editorPack?.draftFrom(card) || {});
    setShowPrompt(Boolean(card.agentPrompt));
    setBlockedState(null);
    firstRef.current?.focus();
    firstRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card.id]);

  const patchDraft = useCallback((partial: Record<string, any>) => {
    setPackDraft((prev) => ({ ...prev, ...partial }));
  }, []);

  interface ShellDraft {
    title: string;
    color: CardColor;
    agentPrompt: string;
    readSkip: boolean;
    readOrder: string;
    pack: Record<string, any>;
  }

  /**
   * 阅读例外的补丁形状：两项都空 = 传 `null`，服务端把整个字段删掉，
   * 板文件里不会留一层空壳（见 lib/board-schema.ts 的 normalizeCardReading）。
   */
  function readingPatch(d: ShellDraft): { skip?: boolean; order?: number } | null {
    const order = d.readOrder.trim() === "" ? null : Number(d.readOrder);
    const next: { skip?: boolean; order?: number } = {};
    if (d.readSkip) next.skip = true;
    if (order !== null && Number.isFinite(order)) next.order = Math.round(order);
    return next.skip || next.order !== undefined ? next : null;
  }

  function buildFrom(d: ShellDraft): CardPatch {
    const patch: CardPatch = { title: d.title.trim(), ...(editorPack ? editorPack.buildPatch(card, d.pack) : {}) };
    if (d.color !== card.color) patch.color = d.color;
    if (d.agentPrompt.trim() !== (card.agentPrompt || "")) patch.agentPrompt = d.agentPrompt.trim();
    const reading = readingPatch(d);
    // 只在跟卡片现状不同时才进补丁：一样的话自动保存那条「改过没有」的比较会被它顶成脏
    if (JSON.stringify(reading) !== JSON.stringify(readingPatch({ ...d, readSkip: card.reading?.skip === true, readOrder: typeof card.reading?.order === "number" ? String(card.reading.order) : "" }))) {
      patch.reading = reading;
    }
    return patch;
  }

  const draft: ShellDraft = { title, color, agentPrompt, readSkip, readOrder, pack: packDraft };

  function build(): CardPatch {
    return buildFrom(draft);
  }

  /* ── 自动保存 ────────────────────────────────
     「改过没有」用同一条构造路径的两份 patch 对比：草稿一份、卡片现状一份。
     一模一样就什么都不做——否则每开一张卡都会白写一次盘，还把画板的 updatedAt 顶上去。 */
  const pending = useRef<CardPatch | null>(null);
  const autoRef = useRef(onAutoSave);
  autoRef.current = onAutoSave;
  const draftPatch = build();
  const dirty =
    JSON.stringify(draftPatch) !==
    JSON.stringify(buildFrom({
      title: card.title || "",
      color: card.color,
      agentPrompt: card.agentPrompt || "",
      readSkip: card.reading?.skip === true,
      readOrder: typeof card.reading?.order === "number" ? String(card.reading.order) : "",
      pack: editorPack?.draftFrom(card) || {},
    }));

  useEffect(() => {
    if (!onAutoSave || !dirty || blocked) {
      pending.current = null;
      return;
    }
    pending.current = draftPatch;
    const timer = setTimeout(() => {
      const patch = pending.current;
      pending.current = null;
      if (patch) autoRef.current?.(card.id, patch);
    }, AUTOSAVE_MS);
    return () => clearTimeout(timer);
    // draftPatch 每次渲染都是新对象，用它的签名当依赖；内容没变就不该重排一次防抖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(draftPatch), dirty, onAutoSave, card.id, blocked]);

  // 卸载（点画布空白 / 关抽屉 / 换卡）时把还没到点的那次补上——这一步才是「点一下就丢」的解药。
  // 注意声明顺序：上面那个 effect 的清理会先跑（clearTimeout），这里再补发。
  useEffect(
    () => () => {
      const patch = pending.current;
      pending.current = null;
      if (patch) autoRef.current?.(card.id, patch);
    },
    [card.id],
  );

  /** 显式提交（Esc / ⌘Enter / 保存按钮）：把待落盘的那份作废，免得关闭后再补发一次同样的内容 */
  function submit() {
    pending.current = null;
    onCommit(build());
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      submit();
    }
    // ⌘/Ctrl + Enter 快速保存（多行输入里 Enter 仍是换行）
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  }

  const Fields = editorPack?.Fields;

  return (
    <div
      className={`editor nodrag nowheel${roomy ? " roomy" : ""}`}
      onKeyDown={onKeyDown}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <input
        ref={firstRef}
        type="text"
        data-field="title"
        placeholder={t("cards.editor.titlePlaceholder")}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />
      {Fields ? (
        <Fields key={card.id} card={card} draft={packDraft} patch={patchDraft} roomy={roomy} setBlocked={setBlocked} />
      ) : null}
      {isUnknownType ? (
        <span className="hint">
          {t("cards.editor.unknownBefore")} <code>{card.type}</code> {t("cards.editor.unknownAfter")}
        </span>
      ) : null}

      {showPrompt ? (
        <>
          <span className="hint">{t("cards.editor.agentPromptHint")}</span>
          <textarea
            data-field="agentPrompt"
            rows={roomy ? 5 : 3}
            placeholder={t("cards.editor.agentPromptPlaceholder")}
            value={agentPrompt}
            onChange={(event) => setAgentPrompt(event.target.value)}
          />
        </>
      ) : (
        <button type="button" className="link-btn" onClick={() => setShowPrompt(true)}>
          {t("cards.editor.addAgentPrompt")}
        </button>
      )}
      {/* 阅读例外：默认两项都空 = 完全按摆放位置读，跟从前逐张一致。
          摆在颜色上面一行，跟「这张卡长什么样」分开——它管的是「什么时候读到它」 */}
      <div className="row reading-row">
        <label className="reading-skip" title={t("cards.editor.reading.skip.title")}>
          <input type="checkbox" data-field="readingSkip" checked={readSkip} onChange={(event) => setReadSkip(event.target.checked)} />
          {t("cards.editor.reading.skip")}
        </label>
        <span className="hint">{t("cards.editor.reading.order")}</span>
        <input
          type="number"
          className="reading-order"
          data-field="readingOrder"
          placeholder={t("cards.editor.reading.order.placeholder")}
          title={t("cards.editor.reading.order.title")}
          value={readOrder}
          onChange={(event) => setReadOrder(event.target.value)}
        />
      </div>
      <div className="row">
        <span className="hint">{t("cards.editor.color")}</span>
        <span className="colors">
          {(Object.entries(COLORS) as [CardColor, string][]).map(([key, hex]) => (
            <button
              key={key}
              type="button"
              className={`swatch${color === key ? " active" : ""}`}
              data-color={key}
              style={{ background: hex }}
              title={key}
              onClick={() => setColor(key)}
            />
          ))}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="mini-btn primary"
          data-act="save"
          title={onAutoSave ? t("cards.editor.saveAutoTitle") : t("cards.editor.saveTitle")}
          onClick={submit}
        >
          {t("cards.editor.save")}
        </button>
      </div>
      <div className="hint">
        {/* 来源标识从卡面降权到这里：查得到，平时不打扰 */}
        {card.createdBy === "agent" ? t("cards.editor.byAgent") : ""}
        {onAutoSave ? t("cards.editor.autosave") : ""}
        {roomy ? t("cards.editor.footRoomy") : t("cards.editor.footInline")}
      </div>
    </div>
  );
}

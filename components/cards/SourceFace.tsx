"use client";

/**
 * 卡面上的「编辑文本」——源码型卡片（mermaid / SVG / 代码 / 表格）不必进抽屉，
 * 在卡面上直接改源码、直接保存。位置与 HTML 卡的「交互」同一处：卡片底部那行页脚。
 *
 * 四条边界：
 * · **真源仍是 store 里的那张卡**：点开才把源码拷成草稿，保存走 `patchCard`——
 *   与抽屉编辑器同一条写入路径（同样进历史、同样能撤销），没保存就退出的草稿一律丢掉。
 * · **不抢画布的手势**：整块编辑区 `nodrag` + `nowheel`，否则在卡面上拖着选一段文字
 *   会变成拖卡片、滚动会变成缩放画布。双击也在这里截住，不再冒泡去开抽屉。
 * · **不抢键盘**：全局快捷键的门禁本来就把 textarea 排除在外（lib/keyboard-shortcuts.ts），
 *   所以这里的 Delete / ⌘A / v / h 都是打字，不会误删卡片。⌘/Ctrl+Enter 保存、Esc 放弃。
 * · **别人改了这张卡就跟着走**：编辑期间外面来了新源码（agent 写的 / 另一个窗口改的），
 *   草稿没动过就顶替掉，动过了不碰——正在打的字比什么都金贵。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ICON_SM, UI } from "@/lib/icons";
import { useBoardStore } from "@/lib/store";
import { useT } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";

export interface SourceFaceProps {
  cardId: string;
  /** 卡上现在的源码（真源在 store，这里只当草稿初值与「外面改没改过」的基准） */
  source: string;
  /** 草稿文本 → patchCard 的补丁；写哪个字段由各卡片包自己说了算 */
  toPatch: (text: string) => Record<string, unknown>;
  /** 编辑态输入框上方的一行提示（字典键，由这里解析——各卡片包不必各自拿 hook） */
  hint?: DictKey;
  placeholder?: DictKey;
  /**
   * 卡面。给节点 = 自动配一行只放按钮的页脚（图表卡这类卡面本来没有页脚）；
   * 给函数 = 卡面自己安置那个按钮（代码卡 / 表格卡已经有页脚，不该再多出一行）。
   */
  children: ReactNode | ((editButton: ReactNode) => ReactNode);
}

export function SourceFace({ cardId, source, toPatch, hint, placeholder, children }: SourceFaceProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(source);
  const [saving, setSaving] = useState(false);
  /** 这次编辑是从哪份源码开始的：既用来判断「改没改过」，也用来接住外面的改动 */
  const seed = useRef(source);

  useEffect(() => {
    if (!editing) return;
    setDraft((current) => (current === seed.current ? source : current));
    seed.current = source;
  }, [source, editing]);

  const open = useCallback(() => {
    seed.current = source;
    setDraft(source);
    setEditing(true);
  }, [source]);

  const cancel = useCallback(() => {
    setEditing(false);
    setSaving(false);
  }, []);

  const save = useCallback(async () => {
    // 一个字没动就当没编辑过：不写一次空补丁进历史
    if (draft === seed.current) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await useBoardStore.getState().patchCard(cardId, toPatch(draft));
      setEditing(false);
    } catch (err) {
      // 保存失败**不关编辑器**：草稿还在框里，改完能再存一次
      useBoardStore.getState().showToast((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [cardId, draft, toPatch]);

  if (editing) {
    return (
      <div
        className="card-stack source-edit nodrag nowheel"
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {hint ? <span className="source-hint">{t(hint)}</span> : null}
        <textarea
          className="grow source-area"
          data-field="source-inline"
          autoFocus
          spellCheck={false}
          placeholder={placeholder ? t(placeholder) : undefined}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              cancel();
              return;
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
        />
        <div className="source-foot">
          <span className="source-tip">{t("cards.source.tip")}</span>
          <span className="foot-spacer" />
          <button type="button" className="mini-btn" onClick={cancel} disabled={saving}>
            {t("cards.source.cancel")}
          </button>
          <button type="button" className="mini-btn primary" data-act="save-source" onClick={() => void save()} disabled={saving}>
            {saving ? t("cards.source.saving") : t("cards.source.save")}
          </button>
        </div>
      </div>
    );
  }

  const iconButton = (
    <button
      type="button"
      className="ac-icon-btn nodrag"
      data-act="edit-source"
      title={t("cards.source.edit.title")}
      aria-label={t("cards.source.edit")}
      onClick={(event) => {
        event.stopPropagation();
        open();
      }}
    >
      <UI.edit {...ICON_SM} />
    </button>
  );

  if (typeof children === "function") return <>{children(iconButton)}</>;

  return (
    <div className="card-stack source-face">
      <div className="grow">{children}</div>
      <div className="source-foot nodrag">
        <span className="foot-spacer" />
        <button
          type="button"
          className="card-action"
          data-act="edit-source"
          title={t("cards.source.edit.titleSave")}
          onClick={(event) => {
            event.stopPropagation();
            open();
          }}
        >
          <UI.edit {...ICON_SM} />
          {t("cards.source.edit")}
        </button>
      </div>
    </div>
  );
}

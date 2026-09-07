"use client";

/**
 * PDF 排版设置 + 真实分页预览。
 *
 * 这个弹窗左边是设置、右边是**排好页的预览**——预览里那一页页纸不是示意图，
 * 是与打印产物**同一份文档**（同一份 CSS、同一次分页），只多了灰底和投影。
 * 所以「预览里第 3 页开头是这张卡」印出来就是第 3 页开头是这张卡。
 *
 * 改任何一项设置都会重新排一遍版（防抖），页数当场变——纸张、页边距、字号、
 * 分栏这几项到底省不省纸，看数字就知道，不用先印一份出来试。
 *
 * 排版与打印的实现见 lib/export-pdf.ts；设置项本身见 lib/pdf-settings.ts。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";
import { ICON_MD, ICON_SM, UI } from "@/lib/icons";
import { buildPdfDocument, fetchPrintDoc, printHtml, type PrintDoc } from "@/lib/export-pdf";
import {
  FONT_PT,
  MARGIN_MM,
  PAPER_MM,
  loadPdfSettings,
  pageSizeMm,
  savePdfSettings,
  type PdfSettings,
} from "@/lib/pdf-settings";
import { useBoardStore } from "@/lib/store";

/** 预览里一张纸的自然宽度（px）：mm → CSS px 是 96dpi 换算 */
const MM_PX = 96 / 25.4;

/**
 * 页边距 / 字号档位的显示名。真源（尺寸数值）仍在 lib/pdf-settings.ts，
 * 那份是前后端共用的排版常量，不该为了界面语言把 React 的字典塞进去——
 * 这里只补一层「档位 → 文案键」的映射。
 */
const MARGIN_LABEL: Record<string, DictKey> = {
  narrow: "panels.pdf.margin.narrow",
  normal: "panels.pdf.margin.normal",
  wide: "panels.pdf.margin.wide",
};
const FONT_LABEL: Record<string, DictKey> = {
  small: "panels.pdf.font.small",
  normal: "panels.pdf.font.normal",
  large: "panels.pdf.font.large",
};

interface OptionRow<T extends string | number | boolean> {
  value: T;
  label: string;
  hint?: string;
}

function Segmented<T extends string | number | boolean>({
  label,
  hint,
  value,
  options,
  onPick,
}: {
  label: string;
  hint?: string;
  value: T;
  options: OptionRow<T>[];
  onPick: (value: T) => void;
}) {
  return (
    <div className="pdf-row">
      <div className="pdf-row-label">
        {label}
        {hint ? <span className="pdf-row-hint">{hint}</span> : null}
      </div>
      <div className="pdf-seg" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={String(option.value)}
            className={option.value === value ? "on" : ""}
            title={option.hint}
            onClick={() => onPick(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string;
  hint?: string;
  on: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <button className={`pdf-toggle${on ? " on" : ""}`} role="switch" aria-checked={on} onClick={() => onToggle(!on)}>
      <span className="pdf-toggle-box">{on ? <UI.check size={12} strokeWidth={2.6} /> : null}</span>
      <span className="pdf-toggle-text">
        {label}
        {hint ? <span className="pdf-toggle-hint">{hint}</span> : null}
      </span>
    </button>
  );
}

export function PdfModal() {
  const open = useBoardStore((state) => state.drawer === "pdf");
  const boardId = useBoardStore((state) => state.boardId);
  const boardName = useBoardStore((state) => state.board?.name || "");
  const search = useBoardStore((state) => state.search);
  const typeFilter = useBoardStore((state) => state.typeFilter);
  const selectedIds = useBoardStore((state) => state.selectedCardIds);
  const updatedAt = useBoardStore((state) => state.board?.updatedAt);
  const t = useT();

  const [settings, setSettings] = useState<PdfSettings>(() => loadPdfSettings());
  const [doc, setDoc] = useState<PrintDoc | null>(null);
  const [html, setHtml] = useState("");
  const [pageCount, setPageCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [scale, setScale] = useState(0.5);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const filtering = Boolean(search.trim() || typeFilter.length);
  const size = pageSizeMm(settings);
  const sheetPx = Math.round(size.w * MM_PX);
  /**
   * 预览 iframe 按**内容的真高度**渲染（页数 × 一页 + 页间空隙），再整体缩放；
   * 外层面板照常出滚动条。给 iframe 固定一个视口高度会让全部页只能在框子内部滚，
   * 外面既没有滚动条也不知道还有多少页。
   */
  const docPx = Math.max(1, Math.round(Math.max(pageCount, 1) * ((size.h - 0.4) * MM_PX + 14) + 28));

  /* 打开时按当前画布状态挑一个合理的默认范围：正开着筛选就默认只导命中的那批 */
  useEffect(() => {
    if (!open) return;
    setSettings((current) => {
      const next = loadPdfSettings();
      if (next.scope === "selected" && selectedIds.length < 1) next.scope = filtering ? "filtered" : "all";
      if (next.scope === "filtered" && !filtering) next.scope = "all";
      return { ...next };
    });
    // 打开这一下要的是「进来时的画布状态」，之后改筛选不该把用户刚选的范围顶掉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const patch = useCallback((part: Partial<PdfSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...part };
      savePdfSettings(next);
      return next;
    });
  }, []);

  /* 内容：范围 / 评论变了才重新去服务端取（纸张字号这些只影响版面，不用再拉一次） */
  useEffect(() => {
    if (!open || !boardId) return;
    let alive = true;
    setError("");
    fetchPrintDoc(settings, { boardId, q: search, types: typeFilter, selectedIds })
      .then((next) => {
        if (alive) setDoc(next);
      })
      .catch((err: Error) => {
        if (alive) {
          setDoc(null);
          setError(err.message);
        }
      });
    return () => {
      alive = false;
    };
    // 只认这几项：其余设置不改内容，只改版面
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, boardId, settings.scope, settings.comments, updatedAt, search, typeFilter.join(","), selectedIds.join(",")]);

  /* 版面：设置一变就重排一遍（防抖，别在拖动开关时排十遍） */
  useEffect(() => {
    if (!open || !doc) return;
    let alive = true;
    setBusy(true);
    const timer = window.setTimeout(() => {
      buildPdfDocument(doc, settings, undefined, { preview: true })
        .then((built) => {
          if (!alive) return;
          setHtml(built.html);
          setPageCount(built.pageCount);
        })
        .catch((err: Error) => {
          if (alive) setError(err.message);
        })
        .finally(() => {
          if (alive) setBusy(false);
        });
    }, 160);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [open, doc, settings]);

  /* 预览缩放：一张纸的自然宽度按面板宽度等比缩到能看全 */
  useEffect(() => {
    const stage = stageRef.current;
    if (!open || !stage) return;
    const fit = () => setScale(Math.min(1, Math.max(0.2, (stage.clientWidth - 24) / sheetPx)));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [open, sheetPx]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") useBoardStore.getState().setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const scopeOptions = useMemo(
    () => [
      { value: "all" as const, label: t("panels.pdf.scope.all"), hint: t("panels.pdf.scope.all.hint") },
      {
        value: "filtered" as const,
        label: t("panels.pdf.scope.filtered"),
        hint: filtering ? t("panels.pdf.scope.filtered.hint") : t("panels.pdf.scope.filtered.none"),
      },
      {
        value: "selected" as const,
        label: `${t("panels.pdf.scope.selected")}${selectedIds.length ? ` ${selectedIds.length}` : ""}`,
        hint: selectedIds.length ? t("panels.pdf.scope.selected.hint") : t("panels.pdf.scope.selected.none"),
      },
    ],
    [filtering, selectedIds.length, t],
  );

  if (!open) return null;

  const close = () => useBoardStore.getState().setDrawer(null);

  const doPrint = async () => {
    if (!html) return;
    try {
      await printHtml(html);
    } catch (err) {
      useBoardStore.getState().showToast((err as Error).message);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="modal pdf-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h2>
            <UI.page {...ICON_MD} /> {t("panels.pdf.title")}
          </h2>
          <span className="pdf-head-name">{boardName}</span>
          <div className="spacer" />
          <span className="pdf-head-count">
            {busy
              ? t("panels.pdf.laying")
              : pageCount
                ? t("panels.pdf.count", { pages: pageCount, cards: doc?.stats.cards ?? 0 })
                : ""}
          </span>
          <button className="top-btn accent" disabled={!html || busy} onClick={doPrint}>
            <UI.download {...ICON_SM} /> {t("panels.pdf.title")}
          </button>
          <button className="drawer-close" title={t("panels.closeEsc")} aria-label={t("common.close")} onClick={close}>
            <UI.close {...ICON_MD} />
          </button>
        </div>

        <div className="pdf-wrap">
          <aside className="pdf-side">
            <div className="pdf-group-cap">{t("panels.pdf.group.paper")}</div>
            <Segmented
              label={t("panels.pdf.size")}
              value={settings.paper}
              options={(Object.keys(PAPER_MM) as (keyof typeof PAPER_MM)[]).map((key) => ({
                value: key,
                label: PAPER_MM[key].label,
                hint: `${PAPER_MM[key].w} × ${PAPER_MM[key].h} mm`,
              }))}
              onPick={(paper) => patch({ paper })}
            />
            <Segmented
              label={t("panels.pdf.orientation")}
              value={settings.orientation}
              options={[
                { value: "portrait" as const, label: t("panels.pdf.orientation.portrait") },
                { value: "landscape" as const, label: t("panels.pdf.orientation.landscape") },
              ]}
              onPick={(orientation) => patch({ orientation })}
            />
            <Segmented
              label={t("panels.pdf.margin")}
              hint={`${MARGIN_MM[settings.margin].value}mm`}
              value={settings.margin}
              options={(Object.keys(MARGIN_MM) as (keyof typeof MARGIN_MM)[]).map((key) => ({
                value: key,
                label: t(MARGIN_LABEL[key]),
                hint: `${MARGIN_MM[key].value}mm`,
              }))}
              onPick={(margin) => patch({ margin })}
            />

            <div className="pdf-group-cap">{t("panels.pdf.group.layout")}</div>
            <Segmented
              label={t("panels.pdf.font")}
              hint={`${FONT_PT[settings.fontScale].value}pt`}
              value={settings.fontScale}
              options={(Object.keys(FONT_PT) as (keyof typeof FONT_PT)[]).map((key) => ({
                value: key,
                label: t(FONT_LABEL[key]),
                hint: `${FONT_PT[key].value}pt`,
              }))}
              onPick={(fontScale) => patch({ fontScale })}
            />
            <Segmented
              label={t("panels.pdf.columns")}
              hint={t("panels.pdf.columns.hint")}
              value={settings.columns}
              options={[
                { value: 1 as const, label: t("panels.pdf.columns.one") },
                { value: 2 as const, label: t("panels.pdf.columns.two"), hint: t("panels.pdf.columns.two.hint") },
              ]}
              onPick={(columns) => patch({ columns })}
            />
            <div className="pdf-checks">
              <Toggle
                label={t("panels.pdf.cover")}
                hint={t("panels.pdf.cover.hint")}
                on={settings.cover}
                onToggle={(cover) => patch({ cover })}
              />
              <Toggle
                label={t("panels.pdf.toc")}
                hint={t("panels.pdf.toc.hint")}
                on={settings.toc}
                onToggle={(toc) => patch({ toc })}
              />
              <Toggle
                label={t("panels.pdf.pageNumbers")}
                hint={t("panels.pdf.pageNumbers.hint")}
                on={settings.pageNumbers}
                onToggle={(pageNumbers) => patch({ pageNumbers })}
              />
              <Toggle
                label={t("panels.pdf.cardPerPage")}
                hint={t("panels.pdf.cardPerPage.hint")}
                on={settings.cardPerPage}
                onToggle={(cardPerPage) => patch({ cardPerPage })}
              />
            </div>

            <div className="pdf-group-cap">{t("panels.pdf.group.content")}</div>
            <Segmented
              label={t("panels.pdf.scope")}
              value={settings.scope}
              options={scopeOptions}
              onPick={(scope) => patch({ scope })}
            />
            <div className="pdf-checks">
              <Toggle
                label={t("panels.pdf.comments")}
                hint={t("panels.pdf.comments.hint")}
                on={settings.comments}
                onToggle={(comments) => patch({ comments })}
              />
              <Toggle
                label={t("panels.pdf.images")}
                hint={t("panels.pdf.images.hint")}
                on={settings.images}
                onToggle={(images) => patch({ images })}
              />
              <Toggle
                label={t("panels.pdf.linkUrls")}
                hint={t("panels.pdf.linkUrls.hint")}
                on={settings.linkUrls}
                onToggle={(linkUrls) => patch({ linkUrls })}
              />
            </div>

            <p className="pdf-note">
              {t("panels.pdf.note.a")}<b>{t("panels.pdf.note.saveAsPdf")}</b>{t("panels.pdf.note.b")}
              <b>{t("panels.pdf.note.same")}</b>{t("panels.pdf.note.c")}
              <b>{t("panels.pdf.note.vector")}</b>{t("panels.pdf.note.d")}
            </p>
          </aside>

          <div className="pdf-stage" ref={stageRef}>
            {error ? (
              <div className="pdf-empty">{t("panels.pdf.error", { message: error })}</div>
            ) : !html ? (
              <div className="pdf-empty">{t("panels.pdf.laying2")}</div>
            ) : (
              <div className="pdf-paper" style={{ height: `${Math.round(docPx * scale)}px` }}>
                <iframe
                  title={t("panels.pdf.previewTitle")}
                  className="pdf-frame"
                  srcDoc={html}
                  style={{ width: `${sheetPx + 24}px`, height: `${docPx}px`, transform: `scale(${scale})` }}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

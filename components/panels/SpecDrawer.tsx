"use client";

/**
 * 卡片中心（原「规格中心」扩展而来）。
 *
 * 上段「**卡片包**」：20 个原生卡片包（cards/&lt;type&gt;/）的开关——停用 = 工具条入口消失 +
 * 新建 400；画板上已有的这类卡照常渲染（代码编译在内，停用只挡新建）。
 * 下段维持原三件事，对应「插件 + 开关 + 传输」：
 *  · **规格库**——本机装了哪些卡片规格，每份能单独开 / 关；点开看字段定义，
 *    一键复制它的 JSON Schema 或 agent 说明块（这就是「注入 schema」给外部用的那份）；
 *  · **收卡片**——把别人（飞书机器人 / 脚本 / 另一台画板）给的信封 JSON 贴进来，
 *    先校验成人话表格看清楚，再决定要不要落到当前画板；
 *  · **导出**——把当前画板导成同一套信封格式，别人拿去照样能看能收。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { api, type FullSpec, type SpecCategoryItem } from "@/lib/api-client";
import { SPEC_CATEGORY_KEY, SPEC_FIELD_TYPE_KEY, type SpecCategory } from "@/lib/card-spec-schema";
import type { ValidateReport } from "@/lib/card-ingest";
import { CARD_METAS } from "@/lib/card-metas";
import { useCardLabel, useT, tr } from "@/lib/i18n/client";
import { ICON_MD, ICON_SM, UI, specIcon, typeIcon } from "@/lib/icons";
import { useBoardStore } from "@/lib/store";

type Tab = "library" | "ingest";

async function copy(text: string, hint: string) {
  await navigator.clipboard.writeText(text);
  useBoardStore.getState().showToast(hint);
}

/** 新卡片落在视口中心附近（跟工具条建卡一个手感） */
function centerPosition(flow: ReturnType<typeof useReactFlow>, w: number, h: number): Record<string, number> {
  const wrap = document.querySelector(".canvas-wrap");
  if (!wrap) return {};
  const rect = wrap.getBoundingClientRect();
  const center = flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  return { x: Math.round(center.x - w / 2 + Math.random() * 36), y: Math.round(center.y - h / 2 + Math.random() * 30) };
}

export function SpecDrawer() {
  const open = useBoardStore((state) => state.drawer === "specs");
  const boardId = useBoardStore((state) => state.boardId);
  const boardName = useBoardStore((state) => state.board?.name || "");
  const specs = useBoardStore((state) => state.specs);
  const t = useT();
  const cardLabelOf = useCardLabel();

  const [tab, setTab] = useState<Tab>("library");
  const [categories, setCategories] = useState<SpecCategoryItem[]>([]);
  const [category, setCategory] = useState<SpecCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flow = useReactFlow();

  /* 导入用 */
  const [draft, setDraft] = useState("");
  const [report, setReport] = useState<ValidateReport | null>(null);
  const [reportError, setReportError] = useState("");
  const [lenient, setLenient] = useState(false);

  const list = useMemo(() => Object.values(specs), [specs]);
  const cardPacks = useBoardStore((state) => state.cardPacks);

  useEffect(() => {
    if (!open) return;
    void useBoardStore.getState().loadSpecs();
    void useBoardStore.getState().loadCardPacks({ force: true });
    if (!categories.length) api.listSpecs().then((data) => setCategories(data.categories || [])).catch(() => undefined);
  }, [open, categories.length]);

  useEffect(() => {
    if (!open) setDetailId(null);
  }, [open]);

  const visible = useMemo(() => {
    const text = query.trim().toLowerCase();
    return list.filter((spec) => {
      if (category !== "all" && spec.category !== category) return false;
      if (!text) return true;
      return (
        spec.name.toLowerCase().includes(text) ||
        spec.id.includes(text) ||
        spec.description.toLowerCase().includes(text) ||
        spec.tags.some((tag) => tag.toLowerCase().includes(text))
      );
    });
  }, [list, category, query]);

  const detail = detailId ? specs[detailId] : null;

  const toggle = useCallback(async (spec: FullSpec, next: boolean) => {
    const state = useBoardStore.getState();
    try {
      await api.setSpecEnabled(spec.id, next);
      await state.loadSpecs({ force: true });
      state.showToast(
        tr(next ? "panels.spec.enabled" : "panels.spec.disabled", { name: spec.name }),
      );
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }, []);

  /** 卡片包开关：写 card-packs.json 的 API；store 就地更新，工具条即时响应，无需刷新 */
  const togglePack = useCallback(async (type: string, label: string, next: boolean) => {
    const state = useBoardStore.getState();
    try {
      await state.setCardPackEnabled(type, next);
      state.showToast(
        tr(next ? "panels.spec.pack.enabled" : "panels.spec.pack.disabled", { name: label }),
      );
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }, []);

  /** 用规格建一张卡：空卡或示例卡 */
  const createCard = useCallback(
    async (spec: FullSpec, withExample: boolean) => {
      const state = useBoardStore.getState();
      if (!state.boardId) {
        state.showToast(tr("panels.spec.needBoardCreate"));
        return;
      }
      try {
        const card = await state.createCard({
          type: "data",
          w: spec.card.w,
          h: spec.card.h,
          color: spec.card.color,
          data: { specId: spec.id, fields: withExample ? spec.example || {} : {} },
          ...centerPosition(flow, spec.card.w, spec.card.h),
        });
        state.setEditing(card.id);
        state.setDrawer("card");
      } catch (err) {
        state.showToast((err as Error).message);
      }
    },
    [flow],
  );

  async function runValidate() {
    setReportError("");
    setReport(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft || "{}");
    } catch (err) {
      setReportError(tr("panels.spec.badJson", { message: (err as Error).message }));
      return;
    }
    setBusy(true);
    try {
      setReport(await api.validateEnvelope(parsed));
    } catch (err) {
      setReportError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function runIngest() {
    const state = useBoardStore.getState();
    if (!boardId) {
      state.showToast(tr("panels.spec.needBoard"));
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draft || "{}");
    } catch (err) {
      setReportError(tr("panels.spec.badJson", { message: (err as Error).message }));
      return;
    }
    setBusy(true);
    try {
      const result = await api.ingestEnvelope(boardId, { ...parsed, mode: lenient ? "lenient" : "strict" });
      await state.refreshBoard();
      const parts = [tr("panels.spec.ingest.created", { count: result.created.length })];
      if (result.updated.length) parts.push(tr("panels.spec.ingest.updated", { count: result.updated.length }));
      if (result.skipped.length) parts.push(tr("panels.spec.ingest.skipped", { count: result.skipped.length }));
      if (result.rejected.length) parts.push(tr("panels.spec.ingest.rejected", { count: result.rejected.length }));
      state.showToast(tr("panels.spec.ingest.done", { parts: parts.join(" · ") }));
      setReport(null);
      setDraft("");
    } catch (err) {
      setReportError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exportEnvelope(onlyData: boolean) {
    const state = useBoardStore.getState();
    if (!boardId) return;
    try {
      const envelope = await api.exportEnvelope(boardId, onlyData);
      await copy(JSON.stringify(envelope, null, 2), tr("panels.spec.envelopeCopied", { name: boardName }));
    } catch (err) {
      state.showToast((err as Error).message);
    }
  }

  return (
    <div className={`drawer specs${open ? " open" : ""}`}>
      <div className="drawer-head">
        <h2>{t("panels.spec.title")}</h2>
        <span className="count">{t("panels.spec.count", { count: list.length })}</span>
        <span className="foot-spacer" />
        <button className="drawer-close" title={t("common.close")} onClick={() => useBoardStore.getState().setDrawer(null)}>
          <UI.close {...ICON_MD} />
        </button>
      </div>

      <div className="drawer-body">
        <div className="ad-modes sp-tabs">
          <button className={`et-chip${tab === "library" ? " on" : ""}`} onClick={() => setTab("library")}>
            {t("panels.spec.tab.library")}
          </button>
          <button className={`et-chip${tab === "ingest" ? " on" : ""}`} onClick={() => setTab("ingest")}>
            {t("panels.spec.tab.ingest")}
          </button>
        </div>

        {tab === "library" && !detail ? (
          <>
            {/* ── 上段：20 个原生卡片包 ─────────────────── */}
            <div className="sp-section-head">{t("panels.spec.section.packs")}</div>
            <div className="config-hint">{t("panels.spec.packs.note", { count: CARD_METAS.length })}</div>
            <div className="pack-grid">
              {CARD_METAS.map((meta) => {
                const Icon = typeIcon(meta.type);
                const enabled = cardPacks ? cardPacks[meta.type] !== false : true;
                return (
                  <div className={`pack-item${enabled ? "" : " off"}`} key={meta.type} data-pack={meta.type}>
                    <Icon {...ICON_SM} />
                    <span className="pack-label">{cardLabelOf(meta.type)}</span>
                    <code className="pack-type">{meta.type}</code>
                    <button
                      className={`sp-switch${enabled ? " on" : ""}`}
                      role="switch"
                      aria-checked={enabled}
                      title={t(enabled ? "panels.spec.pack.disable.title" : "panels.spec.pack.enable.title", {
                        name: cardLabelOf(meta.type),
                      })}
                      onClick={() => void togglePack(meta.type, cardLabelOf(meta.type), !enabled)}
                    >
                      <span className="sp-knob" />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* ── 下段：数据规格（维持原样） ───────────── */}
            <div className="sp-section-head">{t("panels.spec.section.specs")}</div>
            <div className="config-hint">{t("panels.spec.specs.note")}</div>
            <div className="ad-search">
              <input
                type="text"
                placeholder={t("panels.spec.search.placeholder")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="ad-modes">
              <button className={`et-chip${category === "all" ? " on" : ""}`} onClick={() => setCategory("all")}>
                {t("panels.spec.all")} {list.length}
              </button>
              {categories.map((entry) => (
                <button
                  key={entry.id}
                  className={`et-chip${category === entry.id ? " on" : ""}`}
                  // 分类名与解释由接口带回（服务端那边没有「当前语言」），界面这一份按 id 查字典
                  title={SPEC_CATEGORY_KEY[entry.id] ? t(SPEC_CATEGORY_KEY[entry.id].hint) : entry.hint}
                  onClick={() => setCategory(entry.id)}
                >
                  {SPEC_CATEGORY_KEY[entry.id] ? t(SPEC_CATEGORY_KEY[entry.id].label) : entry.label} {entry.count}
                </button>
              ))}
            </div>

            {!list.length ? <div className="config-hint">{t("panels.spec.none")}</div> : null}
            {visible.map((spec) => {
              const Icon = specIcon(spec.icon);
              return (
                <div className={`sp-item${spec.enabled ? "" : " off"}`} key={spec.id}>
                  <button className="sp-main" onClick={() => setDetailId(spec.id)}>
                    <span className="sp-name">
                      <Icon {...ICON_SM} />
                      {spec.name}
                      <span className="tpl-cat">{t(SPEC_CATEGORY_KEY[spec.category].label)}</span>
                      {spec.origin === "user" ? <span className="sp-origin">{t("panels.spec.custom")}</span> : null}
                    </span>
                    <span className="tpl-desc">{spec.description}</span>
                    <span className="tpl-meta">
                      <code className="sp-id">{spec.id}</code>
                      <span className="meta-chip mono">{t("panels.spec.fields", { count: spec.fields.length })}</span>
                      <span className="meta-chip mono">v{spec.version}</span>
                      {spec.tags.map((tag) => (
                        <span key={tag} className="tpl-tag">
                          {tag}
                        </span>
                      ))}
                    </span>
                  </button>
                  <button
                    className={`sp-switch${spec.enabled ? " on" : ""}`}
                    role="switch"
                    aria-checked={spec.enabled}
                    title={t(spec.enabled ? "panels.spec.toggleOff" : "panels.spec.toggleOn")}
                    onClick={() => void toggle(spec, !spec.enabled)}
                  >
                    <span className="sp-knob" />
                  </button>
                </div>
              );
            })}

            <div className="config-hint sp-note">
              {t("panels.spec.note.a")}<code>data/card-specs/</code>{t("panels.spec.note.b")}<code>card-specs/</code>
              {t("panels.spec.note.c")}<code>POST /api/card-specs</code>{t("panels.spec.note.d")}
            </div>
          </>
        ) : null}

        {tab === "library" && detail ? (
          <SpecDetail
            spec={detail}
            onBack={() => setDetailId(null)}
            onToggle={(next) => void toggle(detail, next)}
            onCreate={(withExample) => void createCard(detail, withExample)}
          />
        ) : null}

        {tab === "ingest" ? (
          <>
            <div className="config-hint">{t("panels.spec.ingest.note")}</div>
            <div className="sp-actions">
              <button
                className="mini-btn"
                onClick={() =>
                  void api.specSchemaText(null, "schema").then((text) => copy(text, tr("panels.spec.copied.schema")))
                }
              >
                <UI.code {...ICON_SM} /> {t("panels.spec.copySchema")}
              </button>
              <button
                className="mini-btn"
                onClick={() =>
                  void api.specSchemaText(null, "prompt").then((text) => copy(text, tr("panels.spec.copied.prompt")))
                }
              >
                <UI.agent {...ICON_SM} /> {t("panels.spec.copyPrompt")}
              </button>
              <button className="mini-btn" disabled={!boardId} onClick={() => void exportEnvelope(false)}>
                <UI.download {...ICON_SM} /> {t("panels.spec.exportBoard")}
              </button>
              <button className="mini-btn" disabled={!boardId} onClick={() => void exportEnvelope(true)}>
                <UI.download {...ICON_SM} /> {t("panels.spec.exportSpecsOnly")}
              </button>
            </div>

            <textarea
              className="mono-area sp-draft"
              rows={12}
              placeholder={t("panels.spec.draft.placeholder")}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setReport(null);
                setReportError("");
              }}
            />
            <div className="sp-actions">
              <button className="mini-btn" disabled={busy || !draft.trim()} onClick={() => void runValidate()}>
                <UI.check {...ICON_SM} /> {t("panels.spec.validate")}
              </button>
              <label className="sp-check" title={t("panels.spec.lenient.title")}>
                <input type="checkbox" checked={lenient} onChange={(event) => setLenient(event.target.checked)} />
                {t("panels.spec.lenient")}
              </label>
            </div>

            {reportError ? <div className="ad-warn">{reportError}</div> : null}
            {report ? <IngestReport report={report} /> : null}
          </>
        ) : null}
      </div>

      {tab === "ingest" && report ? (
        <div className="ad-foot">
          <button
            className="mini-btn primary"
            disabled={busy || !boardId || (!lenient && report.counts.rejected > 0) || !report.counts.ready}
            title={boardId ? t("panels.spec.ingestInto.title", { name: boardName }) : t("panels.spec.needBoard")}
            onClick={() => void runIngest()}
          >
            <UI.add {...ICON_SM} /> {t("panels.spec.ingestHere", { count: report.counts.ready })}
          </button>
        </div>
      ) : null}

      {tab === "library" && detail ? (
        <div className="ad-foot">
          <button className="mini-btn primary" disabled={!detail.enabled} onClick={() => void createCard(detail, false)}>
            <UI.add {...ICON_SM} /> {t("panels.spec.newEmpty")}
          </button>
          {detail.example ? (
            <button className="mini-btn" disabled={!detail.enabled} onClick={() => void createCard(detail, true)}>
              {t("panels.spec.newExample")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SpecDetail({
  spec,
  onBack,
  onToggle,
  onCreate,
}: {
  spec: FullSpec;
  onBack: () => void;
  onToggle: (next: boolean) => void;
  onCreate: (withExample: boolean) => void;
}) {
  const Icon = specIcon(spec.icon);
  const [removing, setRemoving] = useState(false);
  const t = useT();

  return (
    <div className="tpl-detail">
      <button className="mini-btn tpl-back" onClick={onBack}>
        <UI.back {...ICON_SM} /> {t("panels.spec.allSpecs")}
      </button>
      <h3>
        <Icon {...ICON_MD} />
        {spec.name}
        <span className="tpl-cat">{t(SPEC_CATEGORY_KEY[spec.category].label)}</span>
      </h3>
      <div className="tpl-desc">{spec.description}</div>
      <div className="tpl-meta">
        <code className="sp-id">{spec.id}</code>
        <span className="meta-chip mono">v{spec.version}</span>
        <span className="meta-chip">{t(spec.origin === "user" ? "panels.spec.custom" : "panels.spec.builtin")}</span>
        {spec.source?.app ? <span className="meta-chip">{t("panels.spec.source", { app: spec.source.app })}</span> : null}
        <span className="foot-spacer" />
        <button
          className={`sp-switch${spec.enabled ? " on" : ""}`}
          role="switch"
          aria-checked={spec.enabled}
          title={t(spec.enabled ? "panels.spec.toggleOff" : "panels.spec.toggleOn")}
          onClick={() => onToggle(!spec.enabled)}
        >
          <span className="sp-knob" />
        </button>
      </div>
      {spec.source?.hint ? <div className="config-hint">{spec.source.hint}</div> : null}

      <div className="sp-fields">
        {spec.fields.map((field) => (
          <div className="sp-field" key={field.key}>
            <span className="sp-field-key">
              <code>{field.key}</code>
              {field.required ? <em className="df-req" title={t("panels.spec.required")}>*</em> : null}
            </span>
            <span className="sp-field-label">{field.label}</span>
            <span className="sp-field-type">
              {field.type === "enum"
                ? (field.options || []).map((option) => option.value).join(" / ")
                : field.type === "list"
                  ? t("panels.spec.listType", { fields: (field.item || []).map((sub) => sub.key).join(" / ") })
                  : t(SPEC_FIELD_TYPE_KEY[field.type])}
            </span>
            {field.hint ? <span className="sp-field-hint">{field.hint}</span> : null}
          </div>
        ))}
      </div>

      <div className="sp-actions">
        <button
          className="mini-btn"
          onClick={() =>
            void api.specSchemaText(spec.id, "schema").then((text) => copy(text, tr("panels.spec.copied.schemaOne")))
          }
        >
          <UI.code {...ICON_SM} /> {t("panels.spec.copySchemaOne")}
        </button>
        <button
          className="mini-btn"
          onClick={() =>
            void api.specSchemaText(spec.id, "prompt").then((text) => copy(text, tr("panels.spec.copied.promptOne")))
          }
        >
          <UI.agent {...ICON_SM} /> {t("panels.spec.copyPromptOne")}
        </button>
        {spec.example ? (
          <button
            className="mini-btn"
            onClick={() =>
              void copy(
                JSON.stringify(
                  { format: "blotboard.cards", version: 1, cards: [{ spec: spec.id, fields: spec.example }] },
                  null,
                  2,
                ),
                tr("panels.spec.copied.example"),
              )
            }
          >
            <UI.copy {...ICON_SM} /> {t("panels.spec.copyExample")}
          </button>
        ) : null}
        {spec.origin === "user" ? (
          <button
            className="mini-btn danger"
            disabled={removing}
            onClick={async () => {
              setRemoving(true);
              const state = useBoardStore.getState();
              try {
                await api.deleteSpec(spec.id);
                await state.loadSpecs({ force: true });
                state.showToast(tr("panels.spec.removed", { name: spec.name }));
                onBack();
              } catch (err) {
                state.showToast((err as Error).message);
              } finally {
                setRemoving(false);
              }
            }}
          >
            <UI.remove {...ICON_SM} /> {t("common.delete")}
          </button>
        ) : null}
      </div>

      {spec.example ? (
        <>
          <span className="hint">{t("panels.spec.example")}</span>
          <pre className="sp-example">{JSON.stringify(spec.example, null, 2)}</pre>
        </>
      ) : null}
    </div>
  );
}

/** 校验结果：一张卡一段，字段摊成人话，问题红着显示 */
function IngestReport({ report }: { report: ValidateReport }) {
  const t = useT();
  return (
    <div className="sp-report">
      <div className="sp-summary">
        <span className="meta-chip mono">{t("panels.spec.report.cards", { count: report.counts.cards })}</span>
        <span className="meta-chip mono ok">{t("panels.spec.report.ready", { count: report.counts.ready })}</span>
        {report.counts.rejected ? (
          <span className="meta-chip mono bad">{t("panels.spec.report.rejected", { count: report.counts.rejected })}</span>
        ) : null}
        {report.counts.edges ? (
          <span className="meta-chip mono">{t("panels.spec.report.edges", { count: report.counts.edges })}</span>
        ) : null}
        {report.generator ? (
          <span className="meta-chip">{t("panels.spec.report.from", { name: report.generator })}</span>
        ) : null}
      </div>
      {report.problems.length ? <div className="ad-warn">{report.problems.join("；")}</div> : null}
      {report.specs.map((spec) => (
        <div className="sp-used" key={spec.id}>
          <code>{spec.id}</code> × {spec.count}
          {!spec.installed ? <span className="sp-bad">{t("panels.spec.report.notInstalled")}</span> : null}
          {spec.installed && !spec.enabled ? <span className="sp-bad">{t("panels.spec.report.disabled")}</span> : null}
        </div>
      ))}
      {report.cards.map((card) => (
        <div className={`sp-card${card.problems.length ? " bad" : ""}`} key={card.index}>
          <div className="sp-card-head">
            <span className="sp-card-title">{card.title || t("panels.spec.report.untitled")}</span>
            <span className="meta-chip">{card.specName}</span>
          </div>
          {card.fields.map((field) => (
            <div className="dc-row" key={field.key}>
              <span className="dc-label">{field.label}</span>
              <span className="dc-value">{field.text}</span>
            </div>
          ))}
          {card.problems.map((problem, index) => (
            <div className="sp-bad" key={index}>
              {problem}
            </div>
          ))}
          {card.warnings.map((warning, index) => (
            <div className="sp-warn" key={index}>
              {warning}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

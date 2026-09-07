"use client";

/**
 * 模板中心抽屉。
 *
 * 解决的是「起点成本」：空白画板面前最贵的一步是排版与想结构，
 * 模板把结构先摆好，用户只补内容——补内容这一步还能整批交给 agent（fillPrompt）。
 *
 * 两种落法：
 *  · 应用到新画板 —— 建一块新板，视口跟模板走，落完直接跳过去
 *  · 插入到当前画板 —— 追加到现有板的右侧，不动用户已有的卡片
 * 两次插同一个模板不会撞 id：落板 id 里带一段本次实例的随机码（见 lib/template-store.ts）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type TemplateApplied, type TemplateCategoryItem } from "@/lib/api-client";
import { COLORS } from "@/lib/constants";
import { taskBackendKind, useFeatures } from "@/lib/features-client";
import { useT, tr } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";
import { ICON_MD, ICON_SM, UI, templateIcon } from "@/lib/icons";
import { boardOrigin } from "@/lib/origins";
import { useBoardStore } from "@/lib/store";
import { buildFillGoal, pendingFillCards } from "@/lib/template-fill";
import { CATEGORY_KEY, isFillable, type Template, type TemplateCategory, type TemplateListItem } from "@/lib/template-schema";

const PAD = 60;

/** 模板缩略：跟子画板卡的缩略图同一套画法（几何 + 颜色，不渲染正文）。 */
function TemplateShape({ shape, links }: Pick<TemplateListItem, "shape" | "links">) {
  if (!shape.length) return null;
  const minX = Math.min(...shape.map((card) => card.x)) - PAD;
  const minY = Math.min(...shape.map((card) => card.y)) - PAD;
  const maxX = Math.max(...shape.map((card) => card.x + card.w)) + PAD;
  const maxY = Math.max(...shape.map((card) => card.y + card.h)) + PAD;
  return (
    <svg
      className="tpl-shape"
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {links.map((link, index) => (
        <line key={index} x1={link.x1} y1={link.y1} x2={link.x2} y2={link.y2} className="bp-edge" />
      ))}
      {shape.map((card, index) => (
        <rect
          key={index}
          x={card.x}
          y={card.y}
          width={card.w}
          height={card.h}
          rx={16}
          className="bp-card"
          style={{ fill: COLORS[card.color] || COLORS.slate }}
        />
      ))}
    </svg>
  );
}

export function TemplateDrawer() {
  const open = useBoardStore((state) => state.drawer === "templates");
  const boardId = useBoardStore((state) => state.boardId);
  const boardName = useBoardStore((state) => state.board?.name || "");
  const cards = useBoardStore((state) => state.board?.cards);
  const features = useFeatures();
  const t = useT();

  const [items, setItems] = useState<TemplateListItem[] | null>(null);
  const [categories, setCategories] = useState<TemplateCategoryItem[]>([]);
  const [category, setCategory] = useState<TemplateCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<Template | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* 列表只在第一次打开时拉：模板是仓库资产，一个会话里不会变 */
  useEffect(() => {
    if (!open || items) return;
    (async () => {
      try {
        const [templates, cats] = await Promise.all([api.listTemplates(), api.templateCategories()]);
        setItems(templates);
        setCategories(cats);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
        setItems([]);
      }
    })();
  }, [open, items]);

  /* 关抽屉时退回列表，下次打开不会卡在上次那个模板的详情里 */
  useEffect(() => {
    if (!open) {
      setDetail(null);
      setDetailId(null);
    }
  }, [open]);

  const openDetail = useCallback(async (id: string) => {
    setDetailId(id);
    setDetail(null);
    try {
      setDetail(await api.getTemplate(id));
    } catch (err) {
      useBoardStore.getState().showToast((err as Error).message);
      setDetailId(null);
    }
  }, []);

  const visible = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (items || []).filter((item) => {
      if (category !== "all" && item.category !== category) return false;
      if (!text) return true;
      return (
        item.name.toLowerCase().includes(text) ||
        item.description.toLowerCase().includes(text) ||
        item.tags.some((tag) => tag.toLowerCase().includes(text))
      );
    });
  }, [items, category, query]);

  const pending = useMemo(() => pendingFillCards(cards || []), [cards]);

  /** 派一条填充任务给 Goal Agent（8567 自己不调模型，只负责把提示词拼好交出去）。 */
  const dispatchFill = useCallback(
    async (targetBoardId: string, targetName: string, templateName?: string, templateAgentPrompt?: string) => {
      const state = useBoardStore.getState();
      try {
        // 以服务端为准取一次最新，别拿本地快照里过期的卡片清单去派任务
        const board = await api.getBoard(targetBoardId);
        const todo = pendingFillCards(board.cards);
        if (!todo.length) {
          state.showToast(tr("panels.template.noPending"));
          return;
        }
        const goal = buildFillGoal({
          boardId: targetBoardId,
          boardName: targetName || board.name,
          boardBase: document.body.dataset.boardBase || boardOrigin(),
          boardLink: boardOrigin(),
          cards: todo,
          templateName,
          templateAgentPrompt,
        });
        const payload = await api.dispatchAgentTask(goal);
        const taskId = payload?.task?.id || payload?.sessionId || payload?.id;
        if (taskId) {
          state.startAgentRun(String(taskId), tr("panels.template.fillRun", { name: templateName || targetName }));
          state.showToast(tr("panels.template.dispatched", { count: todo.length }));
        } else {
          state.showToast(tr("panels.template.dispatchedNoTask"));
        }
      } catch (err) {
        state.showToast((err as Error).message);
      }
    },
    [],
  );

  /** 应用后的统一收尾：提示 + 有待填卡就顺手给一个「AI 填充」入口
      （AI 填充走 Runner 自由派单，local 后端给不了，不给入口） */
  function afterApply(result: TemplateApplied, verbKey: DictKey, template: Template) {
    const state = useBoardStore.getState();
    const text = tr(verbKey, { cards: result.cardIds.length, edges: result.edgeIds.length });
    if (result.fillableIds.length && taskBackendKind() !== "local") {
      state.showToast(tr("panels.template.withPending", { text, count: result.fillableIds.length }), {
        label: tr("panels.template.fill"),
        run: () => void dispatchFill(result.boardId, result.board.name, template.name, template.agentPrompt),
      });
    } else {
      state.showToast(text);
    }
  }

  async function applyToNew(template: Template) {
    const state = useBoardStore.getState();
    setBusy(true);
    try {
      const result = await api.applyTemplate(template.id);
      await state.loadBoards();
      await state.openBoard(result.boardId);
      state.requestFit();
      state.setDrawer(null);
      afterApply(result, "panels.template.applied", template);
    } catch (err) {
      state.showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function insertHere(template: Template) {
    const state = useBoardStore.getState();
    if (!state.boardId) return;
    setBusy(true);
    try {
      const result = await api.insertTemplate(template.id, state.boardId);
      await state.refreshBoard();
      await state.loadBoards();
      state.requestFit();
      state.setDrawer(null);
      afterApply(result, "panels.template.inserted", template);
    } catch (err) {
      state.showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`drawer templates${open ? " open" : ""}`}>
      <div className="drawer-head">
        <h2>{t("panels.template.title")}</h2>
        {items ? <span className="count">{t("panels.template.count", { count: items.length })}</span> : null}
        <span className="foot-spacer" />
        <button className="drawer-close" title={t("common.close")} onClick={() => useBoardStore.getState().setDrawer(null)}>
          <UI.close {...ICON_MD} />
        </button>
      </div>

      <div className="drawer-body">
        {error ? <div className="ad-warn">{t("panels.template.loadFailed", { message: error })}</div> : null}

        {detailId ? (
          <TemplateDetail template={detail} onBack={() => { setDetailId(null); setDetail(null); }} />
        ) : (
          <>
            {pending.length ? (
              <div className="tpl-pending">
                <UI.fill {...ICON_SM} />
                {t("panels.template.pending", { count: pending.length })}
                <span className="foot-spacer" />
                {/* 派给 agent 走 Runner 自由派单；local 后端给不了，手动填照常 */}
                {features.taskBackend !== "local" ? (
                  <button
                    className="mini-btn primary"
                    disabled={!boardId}
                    onClick={() => void dispatchFill(boardId!, boardName)}
                  >
                    {t("panels.template.fill")}
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className="config-hint">{t("panels.template.note")}</div>

            <div className="ad-search">
              <input
                type="text"
                placeholder={t("panels.template.search.placeholder")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>

            <div className="ad-modes">
              <button className={`et-chip${category === "all" ? " on" : ""}`} onClick={() => setCategory("all")}>
                {t("panels.template.all")} {items ? items.length : ""}
              </button>
              {categories.map((entry) => (
                <button
                  key={entry.id}
                  className={`et-chip${category === entry.id ? " on" : ""}`}
                  // 分类名与解释由接口带回（服务端那边没有「当前语言」），界面这一份按 id 查字典
                  title={CATEGORY_KEY[entry.id] ? t(CATEGORY_KEY[entry.id].hint) : entry.hint}
                  onClick={() => setCategory(entry.id)}
                >
                  {CATEGORY_KEY[entry.id] ? t(CATEGORY_KEY[entry.id].label) : entry.label} {entry.count}
                </button>
              ))}
            </div>

            {items === null ? <div className="config-hint">{t("panels.template.loading")}</div> : null}
            {items && !visible.length ? <div className="config-hint">{t("panels.template.noMatch")}</div> : null}

            {visible.map((item) => {
              const Icon = templateIcon(item.icon);
              return (
                <button key={item.id} className="tpl-item" onClick={() => void openDetail(item.id)}>
                  <span className="tpl-thumb">
                    <TemplateShape shape={item.shape} links={item.links} />
                  </span>
                  <span className="tpl-main">
                    <span className="tpl-name">
                      <Icon {...ICON_SM} />
                      {item.name}
                      <span className="tpl-cat">{t(CATEGORY_KEY[item.category].label)}</span>
                    </span>
                    <span className="tpl-desc">{item.description}</span>
                    <span className="tpl-meta">
                      <span className="meta-chip">{t("panels.template.cards", { count: item.counts.cards })}</span>
                      <span className="meta-chip">{t("panels.template.edges", { count: item.counts.edges })}</span>
                      {item.counts.fillable ? (
                        <span className="meta-chip fillable">
                          <UI.fill size={11} strokeWidth={2.2} />
                          {t("panels.template.fillable", { count: item.counts.fillable })}
                        </span>
                      ) : null}
                      {item.tags.map((tag) => (
                        <span key={tag} className="tpl-tag">
                          {tag}
                        </span>
                      ))}
                    </span>
                  </span>
                </button>
              );
            })}
          </>
        )}
      </div>

      {detail ? (
        <div className="ad-foot">
          <button className="mini-btn primary" disabled={busy} onClick={() => void applyToNew(detail)}>
            <UI.add {...ICON_SM} /> {t("panels.template.applyNew")}
          </button>
          <button
            className="mini-btn"
            disabled={busy || !boardId}
            title={boardId ? t("panels.template.insertHere.title", { name: boardName }) : t("panels.template.needBoard")}
            onClick={() => void insertHere(detail)}
          >
            {t("panels.template.insertHere")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TemplateDetail({ template, onBack }: { template: Template | null; onBack: () => void }) {
  const t = useT();
  if (!template) return <div className="config-hint">{t("panels.template.loading")}</div>;
  const Icon = templateIcon(template.icon);
  const fillable = template.cards.filter(isFillable);
  return (
    <div className="tpl-detail">
      <button className="mini-btn tpl-back" onClick={onBack}>
        <UI.back {...ICON_SM} /> {t("panels.template.allTemplates")}
      </button>
      <h3>
        <Icon {...ICON_MD} />
        {template.name}
        <span className="tpl-cat">{t(CATEGORY_KEY[template.category].label)}</span>
      </h3>
      <div className="tpl-desc">{template.description}</div>
      <div className="tpl-meta">
        <span className="meta-chip">{t("panels.template.cards", { count: template.cards.length })}</span>
        <span className="meta-chip">{t("panels.template.edges", { count: template.edges.length })}</span>
        {fillable.length ? (
          <span className="meta-chip fillable">
            <UI.fill size={11} strokeWidth={2.2} />
            {t("panels.template.fillableCount", { count: fillable.length })}
          </span>
        ) : null}
        {template.tags.map((tag) => (
          <span key={tag} className="tpl-tag">
            {tag}
          </span>
        ))}
      </div>

      <div className="tpl-preview">
        <TemplateShape
          shape={template.cards.map((card) => ({ x: card.x, y: card.y, w: card.w, h: card.h, color: card.color || "slate" }))}
          links={template.edges.flatMap((edge) => {
            const from = template.cards.find((card) => card.id === edge.from);
            const to = template.cards.find((card) => card.id === edge.to);
            if (!from || !to) return [];
            return [{ x1: from.x + from.w / 2, y1: from.y + from.h / 2, x2: to.x + to.w / 2, y2: to.y + to.h / 2 }];
          })}
        />
      </div>

      <div className="tpl-cards">
        {template.cards.map((card) => (
          <div key={card.id} className="tpl-card-row">
            <span className="tpl-dot" style={{ background: COLORS[card.color || "slate"] }} />
            <span className="tpl-card-title">{card.title}</span>
            {isFillable(card) ? (
              <span className="meta-chip fillable" title={card.fillPrompt}>
                <UI.fill size={11} strokeWidth={2.2} />
                {t("panels.template.pendingTag")}
              </span>
            ) : null}
          </div>
        ))}
      </div>

      <div className="config-hint tpl-note">{t("panels.template.detailNote")}</div>
    </div>
  );
}

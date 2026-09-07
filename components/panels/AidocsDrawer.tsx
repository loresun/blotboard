"use client";

/**
 * 知识库检索抽屉（后端由 `AIDOCS_URL` 指定）。
 *
 * 用途：把内部知识库里已有的东西，按需摘成画板上的「资料卡」，
 * 让想法 / 任务 / 引用能跟真实素材连线——画板只存 resource_id 与摘要，正文永远回知识库取。
 *
 * 默认走向量检索（~0.6s）；混合检索质量更好但要 20-30s，所以放在后面并写明代价。
 */
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { useT, tr } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";
import { ICON_MD, ICON_SM, UI } from "@/lib/icons";
import { refPrimaryUrl } from "@/lib/aidocs-link";
import { useBoardStore } from "@/lib/store";
import type { RefItem, RefMode } from "@/lib/types";

const MODES: { value: RefMode; label: DictKey; hint: DictKey }[] = [
  { value: "vector", label: "panels.aidocs.mode.vector", hint: "panels.aidocs.mode.vector.hint" },
  { value: "hybrid", label: "panels.aidocs.mode.hybrid", hint: "panels.aidocs.mode.hybrid.hint" },
];

export function AidocsDrawer() {
  const open = useBoardStore((state) => state.drawer === "aidocs");
  const boardId = useBoardStore((state) => state.boardId);
  const refTargetId = useBoardStore((state) => state.refTarget);
  const targetCard = useBoardStore((state) =>
    refTargetId ? state.board?.cards.find((card) => card.id === refTargetId && card.type === "ref") || null : null,
  );
  const t = useT();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<RefMode>("vector");
  const [limit, setLimit] = useState(10);
  const [items, setItems] = useState<RefItem[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [lastQuery, setLastQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 120);
  }, [open]);

  async function search() {
    const text = query.trim();
    if (!text) return;
    setBusy(true);
    try {
      const data = await api.searchAidocs({ query: text, mode, limit });
      setItems(data.items);
      setLastQuery(data.query || text);
      setPicked(new Set());
      if (!data.items.length) useBoardStore.getState().showToast(tr("panels.aidocs.noResults"));
    } catch (err) {
      useBoardStore.getState().showToast((err as Error).message);
      setItems([]);
    } finally {
      setBusy(false);
    }
  }

  function toggle(resourceId: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(resourceId)) next.delete(resourceId);
      else next.add(resourceId);
      return next;
    });
  }

  const chosen = (items || []).filter((item) => picked.has(item.resourceId));

  /** 追加进已有的那张资料卡——同一个主题反复检索时，不该每次都散出一张新卡 */
  async function appendToTarget() {
    const state = useBoardStore.getState();
    if (!targetCard || !chosen.length) return;
    setBusy(true);
    try {
      const existing = targetCard.ref?.items || [];
      const seen = new Set(existing.map((item) => item.resourceId));
      const fresh = chosen.filter((item) => !seen.has(item.resourceId));
      if (!fresh.length) {
        state.showToast(tr("panels.aidocs.allPresent"));
        return;
      }
      await state.patchCard(targetCard.id, {
        ref: { ...(targetCard.ref || { source: "aidocs", mode }), query: targetCard.ref?.query || lastQuery, items: [...existing, ...fresh] },
      });
      state.showToast(
        tr("panels.aidocs.appended", { name: targetCard.title || tr("panels.aidocs.refCard"), count: fresh.length }),
      );
      state.setRefTarget(null);
      state.setDrawer(null);
    } catch (err) {
      state.showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** grouped=true：一张卡装一组资料；false：勾中的每条各建一张，方便分别连线 */
  async function createCards(grouped: boolean) {
    const state = useBoardStore.getState();
    if (!state.boardId || !chosen.length) return;
    setBusy(true);
    try {
      if (grouped) {
        await state.createCard({
          type: "ref",
          title: `资料：${lastQuery}`.slice(0, 60),
          color: "blue",
          ref: { source: "aidocs", query: lastQuery, mode, items: chosen, fetchedAt: Date.now() },
        });
      } else {
        // 横排铺开，别叠在一起（列距跟「一键整理」的默认值一致）
        for (let index = 0; index < chosen.length; index += 1) {
          const item = chosen[index];
          await state.createCard({
            type: "ref",
            title: item.title.slice(0, 60),
            color: "blue",
            x: 120 + (index % 4) * 380,
            y: 120 + Math.floor(index / 4) * 300,
            ref: { source: "aidocs", query: lastQuery, mode, items: [item], fetchedAt: Date.now() },
          });
        }
      }
      state.showToast(
        grouped
          ? tr("panels.aidocs.createdGrouped", { count: chosen.length })
          : tr("panels.aidocs.createdEach", { count: chosen.length }),
      );
      state.setRefTarget(null);
      state.setDrawer(null);
    } catch (err) {
      state.showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`drawer aidocs${open ? " open" : ""}`}>
      <div className="drawer-head">
        <h2>{t("panels.aidocs.title")}</h2>
        <span className="foot-spacer" />
        <button className="drawer-close" title={t("common.close")} onClick={() => useBoardStore.getState().setDrawer(null)}>
          <UI.close {...ICON_MD} />
        </button>
      </div>
      <div className="drawer-body">
        {targetCard ? (
          <div className="ad-target">
            <UI.library {...ICON_SM} />
            {t("panels.aidocs.target", {
              name: targetCard.title || t("panels.aidocs.refCard"),
              count: targetCard.ref?.items.length || 0,
            })}
            <span className="foot-spacer" />
            <button className="mini-btn" onClick={() => useBoardStore.getState().setRefTarget(null)}>
              {t("panels.aidocs.switchToNew")}
            </button>
          </div>
        ) : null}
        <div className="config-hint">{t("panels.aidocs.note")}</div>

        <div className="ad-search">
          <input
            ref={inputRef}
            type="text"
            placeholder={t("panels.aidocs.search.placeholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void search();
            }}
          />
          <button className="mini-btn primary" disabled={busy || !query.trim()} onClick={() => void search()}>
            {busy ? <UI.refresh {...ICON_SM} className="spin" /> : <UI.search {...ICON_SM} />}
            {t("panels.aidocs.search")}
          </button>
        </div>

        <div className="ad-modes">
          {MODES.map((entry) => (
            <button
              key={entry.value}
              className={`et-chip${mode === entry.value ? " on" : ""}`}
              title={t(entry.hint)}
              onClick={() => setMode(entry.value)}
            >
              {t(entry.label)}
            </button>
          ))}
          <span className="foot-spacer" />
          <span className="ad-limit">
            {t("panels.aidocs.limit")}
            <select value={limit} onChange={(event) => setLimit(Number(event.target.value))}>
              {[5, 10, 20, 30].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </span>
        </div>
        {mode === "hybrid" ? <div className="ad-warn">{t("panels.aidocs.hybrid.warn")}</div> : null}

        {busy && !items ? <div className="config-hint">{t("panels.aidocs.searching")}</div> : null}

        {items?.length ? (
          <>
            <div className="ad-count">
              {t("panels.aidocs.hits", { query: lastQuery, count: items.length })} ·{" "}
              {t("panels.picked", { count: picked.size })}
            </div>
            {items.map((item) => {
              const on = picked.has(item.resourceId);
              return (
                <div key={item.resourceId} className={`ad-item${on ? " on" : ""}`} onClick={() => toggle(item.resourceId)}>
                  <div className="ad-item-head">
                    <span className={`ad-check${on ? " on" : ""}`}>{on ? <UI.check size={11} strokeWidth={2.6} /> : null}</span>
                    <span className="ad-item-title">{item.title}</span>
                  </div>
                  <div className="ad-item-meta">
                    {item.platform ? <span className="meta-chip">{item.platform}</span> : null}
                    {item.score != null ? <span className="meta-chip mono">{item.score.toFixed(3)}</span> : null}
                    <span className="mono ad-rid">{item.resourceId}</span>
                    {refPrimaryUrl(item) ? (
                      <a
                        href={refPrimaryUrl(item)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(event) => event.stopPropagation()}
                        title={t("panels.aidocs.openInLibrary")}
                      >
                        <UI.library {...ICON_SM} />
                      </a>
                    ) : null}
                    {item.url ? (
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(event) => event.stopPropagation()}
                        title={t("panels.aidocs.openSource")}
                      >
                        <UI.external {...ICON_SM} />
                      </a>
                    ) : null}
                  </div>
                  {item.snippet ? <div className="ad-item-snippet">{item.snippet}</div> : null}
                </div>
              );
            })}
          </>
        ) : items ? (
          <div className="config-hint">{t("panels.aidocs.empty")}</div>
        ) : null}
      </div>
      {chosen.length ? (
        <div className="ad-foot">
          {targetCard ? (
            <button className="mini-btn primary" disabled={busy} onClick={() => void appendToTarget()}>
              <UI.add {...ICON_SM} />{" "}
              {t("panels.aidocs.appendTo", {
                name: targetCard.title || t("panels.aidocs.currentRefCard"),
                count: chosen.length,
              })}
            </button>
          ) : null}
          <button
            className={`mini-btn${targetCard ? "" : " primary"}`}
            disabled={busy || !boardId}
            onClick={() => void createCards(true)}
          >
            <UI.add {...ICON_SM} /> {t("panels.aidocs.createOne", { count: chosen.length })}
          </button>
          <button className="mini-btn" disabled={busy || !boardId} onClick={() => void createCards(false)}>
            {t("panels.aidocs.createEach")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

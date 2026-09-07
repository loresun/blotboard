"use client";

/**
 * 图表卡的前端槽位。
 *
 * 渲染**复用 mermaid 卡那条路**：字段先翻成源码（cards/chart/source.ts），
 * 再交给 components/cards/DiagramCard 的 MermaidCard——按需 import、
 * 按源码缓存、语法出错时把错误摆在卡面上，那三件事都已经在那里了，
 * 这张卡不该有第二份。图表卡自己只负责「数据 → 源码」这一步。
 */
import { useEffect } from "react";
import { MermaidCard } from "@/components/cards/DiagramCard";
import { CHART_KINDS, type ChartKind } from "@/lib/types";
import { chartToMermaid } from "./source";
import { chartToText, textToChartData } from "./text";
import { useT } from "@/lib/i18n/client";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";

function Fields({ draft, patch, roomy, setBlocked }: EditorFieldsProps) {
  const t = useT();
  const kind = draft.chartKind as ChartKind;
  const parsed = textToChartData(kind, draft.chartText as string);
  const error = parsed.ok ? null : parsed.error;
  /**
   * 数据写错就挡住自动保存并说清哪一行错了——存进去一张画不出来的图，
   * 用户要等到关掉抽屉才看得见问题。
   * 放 effect 里而不是渲染时直接调：setBlocked 改的是父组件（CardEditor）的 state，
   * 渲染期间去动别人的 state 是 React 明令禁止的（与 html 卡的白名单校验同一写法）。
   */
  useEffect(() => {
    setBlocked(error ? t("cards.chart.blocked", { error }) : null);
    return () => setBlocked(null);
  }, [error, setBlocked, t]);

  return (
    <>
      <div className="row">
        <select
          data-field="chart.kind"
          value={kind}
          onChange={(event) => patch({ chartKind: event.target.value })}
        >
          {CHART_KINDS.map((one) => (
            <option key={one} value={one}>
              {t(`cards.chart.kind.${one}` as const)}
            </option>
          ))}
        </select>
        <input
          type="text"
          data-field="chart.title"
          placeholder={t("cards.chart.titlePlaceholder")}
          maxLength={120}
          value={draft.chartTitle}
          onChange={(event) => patch({ chartTitle: event.target.value })}
        />
      </div>
      {kind === "bar" || kind === "line" ? (
        <div className="row">
          <input
            type="text"
            data-field="chart.xLabel"
            placeholder={t("cards.chart.xPlaceholder")}
            maxLength={60}
            value={draft.chartX}
            onChange={(event) => patch({ chartX: event.target.value })}
          />
          <input
            type="text"
            data-field="chart.yLabel"
            placeholder={t("cards.chart.yPlaceholder")}
            maxLength={60}
            value={draft.chartY}
            onChange={(event) => patch({ chartY: event.target.value })}
          />
        </div>
      ) : null}
      <span className="hint">
        {kind === "pie"
          ? t("cards.chart.dataHint.pie")
          : kind === "quadrant"
            ? t("cards.chart.dataHint.quadrant")
            : t("cards.chart.dataHint.series")}
      </span>
      <textarea
        data-field="chart.data"
        className={roomy ? "fill mono-area" : "mono-area"}
        rows={roomy ? 14 : 6}
        placeholder={t(`cards.chart.placeholder.${kind}` as const)}
        value={draft.chartText}
        onChange={(event) => patch({ chartText: event.target.value })}
      />
      {error ? <span className="hint danger">{error}</span> : null}
    </>
  );
}

function ChartFace({ source, cardId }: { source: string; cardId: string }) {
  const t = useT();
  if (!source) return <span className="placeholder">{t("cards.chart.empty")}</span>;
  return <MermaidCard source={source} cardId={cardId} />;
}

export const ui: CardPackUi = {
  CardFace({ card }) {
    return <ChartFace source={chartToMermaid(card.chart)} cardId={card.id} />;
  },
  FullView({ card, idPrefix }) {
    return <ChartFace source={chartToMermaid(card.chart)} cardId={`${idPrefix}-${card.id}`} />;
  },
  editor: {
    draftFrom(card) {
      return {
        chartKind: card.chart?.kind || "bar",
        chartTitle: card.chart?.title || "",
        chartX: card.chart?.xLabel || "",
        chartY: card.chart?.yLabel || "",
        chartText: chartToText(card.chart),
      };
    },
    buildPatch(_card, draft) {
      const kind = draft.chartKind as ChartKind;
      const text = String(draft.chartText || "").trim();
      const parsed = textToChartData(kind, text);
      // 解析不过时保底只改标题（Fields 已经挡住保存，这里是双保险，绝不写坏数据）
      let data: Record<string, unknown> = parsed.ok ? parsed.data : {};
      // 文本框清空 = 把数据清掉。显式给 null 而不是「不传」，否则合并语义会把上一版数据留住，
      // 用户会发现自己删不掉（与表格卡清空是同一个道理）
      if (!text) {
        data =
          kind === "pie" ? { slices: null } : kind === "quadrant" ? { points: null } : { labels: [], series: null };
      }
      return {
        chart: {
          kind,
          title: String(draft.chartTitle || "").trim(),
          ...(kind === "bar" || kind === "line"
            ? { xLabel: String(draft.chartX || "").trim(), yLabel: String(draft.chartY || "").trim() }
            : {}),
          ...data,
        },
      };
    },
    Fields,
  },
  toolbar: {
    label: "数据图",
    title: "数据图表卡（填数据即出图：柱状 / 折线 / 饼图 / 四象限）",
    group: 2,
    order: 30,
    onClick: (ctx) => ctx.add("chart"),
  },
};

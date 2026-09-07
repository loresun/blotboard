/** 规格卡在单文件 HTML 导出里的版式（自 lib/export-html.ts 机械拆入，行为不变）。 */
import { body, chip, escapeHtml, link, type ExportHtmlCtx } from "@/lib/export-helpers";
import { formatFieldValue, type CardSpec, type SpecField } from "@/lib/card-spec-schema";
import type { CardPackExport } from "@/lib/card-pack-types";
import type { BoardCard, DataScalar, DataValue } from "@/lib/types";

function specTable(spec: CardSpec | null, fields: Record<string, DataValue>, skip: Set<string>): string {
  const rows: string[] = [];

  const cell = (field: SpecField | null, value: DataValue): string => {
    if (field?.type === "list" && Array.isArray(value) && value.length && typeof value[0] === "object") {
      const columns = field.item || [];
      const list = value as Record<string, DataScalar>[];
      const heads = columns.length ? columns : Object.keys(list[0] || {}).map((key) => ({ key, label: key, type: "text" as const }));
      return (
        `<table class="sub"><thead><tr>${heads.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead><tbody>` +
        list
          .map(
            (row) =>
              `<tr>${heads.map((column) => `<td>${escapeHtml(row[column.key] === undefined || row[column.key] === null ? "" : String(row[column.key]))}</td>`).join("")}</tr>`,
          )
          .join("") +
        `</tbody></table>`
      );
    }
    if (field?.type === "tags" && Array.isArray(value)) {
      return (value as DataScalar[]).map((tag) => chip(String(tag))).join("");
    }
    if (field?.type === "url") return link(String(value));
    const text = formatFieldValue(field, value);
    // 长文本里的换行是内容的一部分（步骤、prompt 骨架），不能被折成一段
    return text.includes("\n") ? `<div class="pre">${escapeHtml(text)}</div>` : escapeHtml(text);
  };

  if (spec) {
    for (const field of spec.fields) {
      if (skip.has(field.key)) continue;
      const value = fields[field.key];
      if (value === undefined || value === null || value === "") continue;
      rows.push(`<tr><th>${escapeHtml(field.label)}</th><td>${cell(field, value)}</td></tr>`);
    }
  } else {
    // 规格不在本机：按字段名原样摊开，内容一个字不丢
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === "") continue;
      rows.push(`<tr><th>${escapeHtml(key)}</th><td>${cell(null, value)}</td></tr>`);
    }
  }
  return rows.length ? `<table class="fields">${rows.join("")}</table>` : "";
}

function renderDataCard(card: BoardCard, specs: Map<string, CardSpec>): string {
  const data = card.data;
  if (!data) return `<p class="empty">空的规格卡</p>`;
  const spec = specs.get(data.specId) || null;
  const fields = data.fields || {};

  if (!spec) {
    return (
      `<div class="dc"><div class="dc-kicker"><span class="dc-spec off">规格 ${escapeHtml(data.specId)} 未安装</span></div>` +
      (specTable(null, fields, new Set()) || `<p class="empty">这张卡还没有字段</p>`) +
      `</div>`
    );
  }

  const byKey = new Map(spec.fields.map((field) => [field.key, field]));
  const display = spec.display;
  const value = (key?: string): DataValue | undefined => (key ? fields[key] : undefined);
  const text = (key?: string): string => formatFieldValue(key ? byKey.get(key) || null : null, value(key));

  const skip = new Set(
    [display.title, display.subtitle, display.body, display.link, display.time, ...display.badges].filter(Boolean) as string[],
  );

  const subtitle = text(display.subtitle);
  const bodyText = text(display.body);
  const time = text(display.time);
  const url = display.link ? String(value(display.link) || "") : "";
  const badges = display.badges
    .map((key) => {
      const field = byKey.get(key);
      // bool 字段裸一个「是」没人看得懂，显示字段名本身
      if (field?.type === "bool") return value(key) === true ? field.label : "";
      return text(key);
    })
    .filter(Boolean);

  const table = specTable(spec, fields, skip);
  const foot = [data.source?.app || spec.source?.app || "", time].filter(Boolean).join(" · ");

  return (
    `<div class="dc">` +
    `<div class="dc-kicker">` +
    `<span class="dc-spec">${escapeHtml(spec.name)}</span>` +
    (subtitle ? `<span class="dc-sub">${escapeHtml(subtitle)}</span>` : "") +
    badges.map((badge) => chip(badge, "badge")).join("") +
    `</div>` +
    (bodyText ? `<div class="dc-body">${body(bodyText)}</div>` : "") +
    table +
    (foot || url
      ? `<div class="dc-foot">${escapeHtml(foot)}${url ? ` ${link(url, "打开原文")}` : ""}</div>`
      : "") +
    `</div>`
  );
}

export const exporter: CardPackExport = {
  html(card, ctx: ExportHtmlCtx) {
    return renderDataCard(card, ctx.specs);
  },
};

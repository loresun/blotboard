/** 规格卡（data）的服务端归一化（自 lib/board-schema.ts 机械拆入，行为不变）。 */
import type { DataField, DataValue } from "@/lib/types";
import { clampNumber, cleanText, URL_RE } from "@/lib/normalize-base";
import { badRequest } from "@/lib/http";
import { findSpec } from "@/lib/card-spec-store";
import { SPEC_ID_RE, formatFieldValue, normalizeLooseValues, normalizeSpecValues, specCardTitle } from "@/lib/card-spec-schema";
import type { CardPackSchema } from "@/lib/card-pack-types";

/**
 * 规格卡（data）。
 *
 * 认得的规格 → 按规格清洗（未知字段丢掉、类型转换、超长截断）；
 * **不认得的规格 → 原样收下**，只做通用清洗——别人给的卡片里引用了我这台机器上没装的规格，
 * 收下并降级成 key-value 表显示，比 400 拒收有用得多（这是「看别人的卡片」能成立的前提）。
 *
 * 必填字段缺失在这里**不报错**：单卡 PATCH 本来就是一次改一点。
 * 「必填必须齐」是信封导入那条路的规矩（见 lib/card-ingest.ts）。
 */
export function normalizeDataField(input: Partial<DataField> = {}, { required = false } = {}): DataField {
  const specId = cleanText(input.specId, 40);
  if (!specId) {
    if (required) throw badRequest("规格卡必须提供 data.specId（GET /api/card-specs 看有哪些）");
    return { specId: "", specVersion: 1, fields: {} };
  }
  if (!SPEC_ID_RE.test(specId)) throw badRequest("data.specId 必须是 kebab-case");

  const spec = findSpec(specId);
  const rawFields = (input.fields && typeof input.fields === "object" ? input.fields : {}) as Record<string, unknown>;
  const fields: Record<string, DataValue> = spec ? normalizeSpecValues(spec, rawFields).fields : normalizeLooseValues(rawFields);

  const data: DataField = {
    specId,
    specVersion: spec ? spec.version : clampNumber(input.specVersion, 1, 9999, 1),
    fields,
  };

  const rawSource = (input.source || {}) as Record<string, unknown>;
  const url = cleanText(rawSource.url, 2048);
  const source: DataField["source"] = {};
  const app = cleanText(rawSource.app, 40);
  if (app) source.app = app;
  if (url && URL_RE.test(url)) source.url = url;
  const externalId = cleanText(rawSource.externalId, 200);
  if (externalId) source.externalId = externalId;
  if (Number.isFinite(Number(rawSource.fetchedAt))) source.fetchedAt = Number(rawSource.fetchedAt);
  if (Object.keys(source).length) data.source = source;

  return data;
}

/** 规格卡的兜底标题：规格里指定了 display.title 就用那个字段的值。 */
export function dataCardTitle(data: DataField): string {
  const spec = findSpec(data.specId);
  return spec ? specCardTitle(spec, data.fields) : "";
}

export const schema: CardPackSchema = {
  onCreate(card, input) {
    card.data = normalizeDataField(input.data, { required: true });
    // 规格说了「哪个字段是标题」，就不必让调用方再重复写一遍 title
    if (!card.title) card.title = dataCardTitle(card.data);
  },
  onConvert(card, patch) {
    card.data = normalizeDataField(patch.data || card.data || {}, { required: true });
  },
  onPatch(card, patch) {
    if (patch.data === undefined) return;
    // fields 合并而不是整体替换：agent 常常只改一个字段，整体替换会把没提到的字段清空。
    // 想清掉某个字段就显式传 null。
    const merged = {
      specId: patch.data?.specId || card.data?.specId,
      specVersion: patch.data?.specVersion ?? card.data?.specVersion,
      fields: { ...(card.data?.fields || {}), ...(patch.data?.fields || {}) },
      source: { ...(card.data?.source || {}), ...(patch.data?.source || {}) },
    };
    card.data = normalizeDataField(merged, { required: true });
  },
  markdownLines(card) {
    if (!card.data) return [];
    const spec = findSpec(card.data.specId);
    const lines = [`- 规格：\`${card.data.specId}\`${spec ? ` （${spec.name} v${card.data.specVersion}）` : "（本机未安装）"}`];
    if (card.data.source?.url) lines.push(`- 出处：${card.data.source.url}`);
    lines.push("");
    // 字段按规格顺序摊成表；没装规格就按 key 原样列，至少内容不丢
    const fields = spec
      ? spec.fields
          .filter((field) => card.data!.fields[field.key] !== undefined)
          .map((field) => [field.label, formatFieldValue(field, card.data!.fields[field.key])])
      : Object.entries(card.data.fields).map(([key, value]) => [key, formatFieldValue(null, value)]);
    for (const [label, value] of fields) {
      lines.push(`- **${label}**：${String(value).replace(/\n/g, " / ")}`);
    }
    return lines;
  },
};

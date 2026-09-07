"use client";

/**
 * 规格卡的字段表单：**按规格现生成**，不为任何一种规格写死界面。
 *
 * 清空一个字段时写的是 `null` 而不是删掉这个 key——
 * 服务端的 PATCH 是「合并 fields」（agent 常常只改一个字段），
 * 只有显式的 null 才表示「把这个字段清掉」。
 */
import type { CardSpec, SpecField } from "@/lib/card-spec-schema";
import { ICON_SM, UI } from "@/lib/icons";
import { useT } from "@/lib/i18n/client";
import type { DataScalar, DataValue } from "@/lib/types";

export type FieldValues = Record<string, DataValue>;

/** 毫秒时间戳 → datetime-local 需要的本地时间串 */
function toLocalInput(value: DataValue | undefined): string {
  const stamp = Number(value);
  if (!Number.isFinite(stamp) || !stamp) return "";
  const date = new Date(stamp - new Date().getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function fromLocalInput(text: string): number | null {
  if (!text) return null;
  const stamp = Date.parse(text);
  return Number.isFinite(stamp) ? stamp : null;
}

function Row({ field, children }: { field: SpecField; children: React.ReactNode }) {
  const t = useT();
  return (
    <label className="df-row">
      <span className="df-label">
        {field.label}
        {field.required ? <em className="df-req" title={t("cards.data.required")}>*</em> : null}
        <code className="df-key">{field.key}</code>
      </span>
      {children}
      {field.hint ? <span className="df-hint">{field.hint}</span> : null}
    </label>
  );
}

function ListEditor({
  field,
  rows,
  onChange,
}: {
  field: SpecField;
  rows: Record<string, DataScalar>[];
  onChange: (rows: Record<string, DataScalar>[]) => void;
}) {
  const t = useT();
  const columns = field.item || [];
  return (
    <div className="df-list">
      {rows.map((row, index) => (
        <div className="df-list-row" key={index}>
          {columns.map((column) => (
            <input
              key={column.key}
              type={column.type === "number" ? "number" : "text"}
              placeholder={column.label}
              value={row[column.key] === undefined || row[column.key] === null ? "" : String(row[column.key])}
              onChange={(event) => {
                const raw = event.target.value;
                const next = [...rows];
                next[index] = {
                  ...row,
                  [column.key]: column.type === "number" ? (raw === "" ? "" : Number(raw)) : raw,
                };
                onChange(next);
              }}
            />
          ))}
          <button
            type="button"
            className="ac-icon-btn danger"
            title={t("cards.data.deleteRow")}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            <UI.remove {...ICON_SM} />
          </button>
        </div>
      ))}
      <button type="button" className="link-btn" onClick={() => onChange([...rows, {}])}>
        {t("cards.data.addRow")}
      </button>
    </div>
  );
}

export function DataFields({
  spec,
  values,
  onChange,
  roomy = false,
}: {
  spec: CardSpec;
  values: FieldValues;
  onChange: (values: FieldValues) => void;
  roomy?: boolean;
}) {
  const t = useT();
  const set = (key: string, value: DataValue) => onChange({ ...values, [key]: value });

  return (
    <div className="df">
      {spec.fields.map((field) => {
        const value = values[field.key];
        switch (field.type) {
          case "longtext":
            return (
              <Row field={field} key={field.key}>
                <textarea
                  rows={roomy ? 6 : 3}
                  maxLength={field.max || 4000}
                  value={value === null || value === undefined ? "" : String(value)}
                  onChange={(event) => set(field.key, event.target.value || null)}
                />
              </Row>
            );
          case "number":
            return (
              <Row field={field} key={field.key}>
                <input
                  type="number"
                  value={value === null || value === undefined ? "" : String(value)}
                  onChange={(event) => set(field.key, event.target.value === "" ? null : Number(event.target.value))}
                />
              </Row>
            );
          case "bool":
            return (
              <label className="df-row df-bool" key={field.key}>
                <input
                  type="checkbox"
                  checked={value === true}
                  onChange={(event) => set(field.key, event.target.checked)}
                />
                <span className="df-label">
                  {field.label}
                  <code className="df-key">{field.key}</code>
                </span>
              </label>
            );
          case "date":
            return (
              <Row field={field} key={field.key}>
                <input
                  type="datetime-local"
                  value={toLocalInput(value)}
                  onChange={(event) => set(field.key, fromLocalInput(event.target.value))}
                />
              </Row>
            );
          case "enum":
            return (
              <Row field={field} key={field.key}>
                <select
                  value={value === null || value === undefined ? "" : String(value)}
                  onChange={(event) => set(field.key, event.target.value || null)}
                >
                  <option value="">{t("cards.data.unset")}</option>
                  {(field.options || []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Row>
            );
          case "tags":
            return (
              <Row field={field} key={field.key}>
                <input
                  type="text"
                  placeholder={t("cards.data.tagsPlaceholder")}
                  value={Array.isArray(value) ? (value as DataScalar[]).join(t("cards.data.tagJoiner")) : ""}
                  onChange={(event) => {
                    const tags = event.target.value
                      .split(/[,，;；]/)
                      .map((tag) => tag.trim())
                      .filter(Boolean);
                    set(field.key, tags.length ? tags : null);
                  }}
                />
              </Row>
            );
          case "list":
            return (
              <Row field={field} key={field.key}>
                <ListEditor
                  field={field}
                  rows={Array.isArray(value) ? (value as Record<string, DataScalar>[]) : []}
                  onChange={(rows) => set(field.key, rows.length ? rows : null)}
                />
              </Row>
            );
          default:
            return (
              <Row field={field} key={field.key}>
                <input
                  type="text"
                  maxLength={field.max || 300}
                  placeholder={field.type === "url" ? "https://…" : ""}
                  value={value === null || value === undefined ? "" : String(value)}
                  onChange={(event) => set(field.key, event.target.value || null)}
                />
              </Row>
            );
        }
      })}
    </div>
  );
}

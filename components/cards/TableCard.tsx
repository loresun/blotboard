"use client";

/**
 * 表格卡的渲染（卡面 / 阅读模式共用一份表体）。
 *
 * 卡面上的取舍：**横向可滚、纵向渐隐**。
 * 表格天生比卡片宽，横向缩放会把字挤成看不清的一团，所以宁可让它横着滚；
 * 纵向则跟正文卡一致——装得下就都显示，装不下在底部化开一道白，暗示「下面还有」。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "@/lib/i18n/client";
import type { TableField } from "@/lib/types";

function TableBody({ table }: { table: TableField }) {
  const columns = table.columns || [];
  return (
    <table className="mini-table">
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.key} style={column.align ? { textAlign: column.align } : undefined}>
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(table.rows || []).map((row, index) => (
          // 行没有稳定 id（表格就是一堆值），用下标当 key：整表是一次性替换的，不会出现「插一行」的重排
          <tr key={index}>
            {columns.map((column) => (
              <td key={column.key} style={column.align ? { textAlign: column.align } : undefined}>
                {row[column.key] ?? ""}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TableCardFace({ table, action }: { table?: TableField | null; /** 页脚上多挂一个动作（「编辑文本」，见 SourceFace） */ action?: ReactNode }) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const [clipped, setClipped] = useState(false);
  const columns = table?.columns || [];
  const rows = table?.rows || [];

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setClipped(el.scrollHeight - el.clientHeight > 4);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [table]);

  if (!columns.length) return <span className="placeholder">{t("cards.table.empty")}</span>;

  return (
    <div className="card-stack table-card">
      <div ref={ref} className={`grow table-scroll nowheel${clipped ? " clipped" : ""}`}>
        <TableBody table={table as TableField} />
      </div>
      <div className="table-foot nodrag">
        {table?.caption ? (
          <span className="table-caption" title={table.caption}>
            {table.caption}
          </span>
        ) : null}
        <span className="foot-spacer" />
        <span className="meta-chip mono" title={t("cards.table.sizeTitle")}>
          {columns.length}×{rows.length}
        </span>
        {action}
      </div>
    </div>
  );
}

export function TableFullView({ table }: { table?: TableField | null }) {
  const t = useT();
  if (!table?.columns?.length) return <span className="placeholder">{t("cards.table.readerEmpty")}</span>;
  return (
    <div className="reader-table">
      <div className="reader-table-scroll">
        <TableBody table={table} />
      </div>
      {table.caption ? <div className="reader-table-caption">{table.caption}</div> : null}
    </div>
  );
}

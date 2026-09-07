"use client";

/**
 * 规格卡（data）的卡面。
 *
 * 全部规格共用**这一个**渲染器——显示什么由规格里的 `display` 决定
 * （哪个字段当副标题、哪个当正文、哪几个做徽标、哪个是链接与时间）。
 * 这是「加一种卡片形式 = 加一个 json」的关键：新规格不需要新组件。
 *
 * 版式借的是飞书消息卡片那一套（标题带 → 正文 → 分隔线 → 字段区 → 脚注 + 动作），
 * 但配色与圆角走画板自己的纸感体系：不用饱和色块，只用 accent 的淡色与一条细分隔线。
 * 之所以照搬那个结构：外部卡片天然是「一句话主题 + 一段正文 + 若干属性 + 一个出处」，
 * 平铺成 key-value 表会让人一眼找不到重点。
 *
 * 规格不在本机时不留白卡：降级成朴素的属性表 + 一个「规格未安装」提示——
 * 别人给的卡片照样看得见内容，这是这套体系能互相传阅的前提。
 */
import { formatFieldValue, type CardSpec, type SpecField } from "@/lib/card-spec-schema";
import { ICON_SM, UI, specIcon } from "@/lib/icons";
import { useBoardStore } from "@/lib/store";
import { useT } from "@/lib/i18n/client";
import type { BoardCard, DataValue } from "@/lib/types";

/** 已经被 display 用掉的字段不再重复出现在属性区里 */
function usedKeys(spec: CardSpec): Set<string> {
  const { title, subtitle, body, badges, link, time } = spec.display;
  return new Set([title, subtitle, body, link, time, ...badges].filter(Boolean) as string[]);
}

interface Row {
  key: string;
  label: string;
  text: string;
}

/**
 * 属性区。值允许折两行再省略——单行截断会把「谁 · 什么时候 · 什么结论」这类
 * 复合值砍得只剩前半句，看了等于没看。
 * list 类型字段本来就是多行（formatFieldValue 用 \n 连），这里按行拆开显示。
 */
function FieldRows({ rows }: { rows: Row[] }) {
  const t = useT();
  if (!rows.length) return null;
  return (
    <div className="dc-fields">
      {rows.map((row) => {
        const lines = row.text.split("\n").filter(Boolean);
        return (
          <div className="dc-row" key={row.key} title={t("cards.data.rowTitle", { label: row.label, value: row.text })}>
            <span className="dc-label">{row.label}</span>
            <span className="dc-value">
              {lines.length > 1 ? lines.map((line, index) => <span key={index}>{line}</span>) : row.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * `full` = 摊开看（阅读模式）：同一套结构，只是不再截断。
 * 卡面与阅读视图共用这一份的理由：规格卡的「长什么样」由规格的 display 决定，
 * 写两份必然有一天对不上——那正是当年导出只印出一堆空标题的成因。
 */
export function DataCard({ card, full = false }: { card: BoardCard; full?: boolean }) {
  const t = useT();
  const specs = useBoardStore((state) => state.specs);
  const specsLoaded = useBoardStore((state) => state.specsLoaded);
  const data = card.data;
  if (!data) return <span className="placeholder">{t("cards.data.empty")}</span>;

  const spec = specs[data.specId];
  const fields = data.fields || {};

  /* 规格没装（或还没拉到）：降级成属性表，内容一个字不丢 */
  if (!spec) {
    const rows = Object.entries(fields).map(([key, value]) => ({
      key,
      label: key,
      text: formatFieldValue(null, value as DataValue),
    }));
    return (
      <div className={full ? "dc full" : "dc"}>
        <div className="dc-kicker">
          <span className="dc-spec off" title={specsLoaded ? t("cards.data.specMissing") : t("cards.data.specLoading")}>
            <UI.ban size={11} strokeWidth={2} />
            {data.specId}
          </span>
        </div>
        <div className="dc-body nowheel">
          <FieldRows rows={rows} />
          {!rows.length ? <span className="placeholder">{t("cards.data.noFields")}</span> : null}
        </div>
      </div>
    );
  }

  const skip = usedKeys(spec);
  const byKey = new Map(spec.fields.map((field) => [field.key, field]));
  const value = (key?: string): DataValue | undefined => (key ? fields[key] : undefined);
  const text = (key?: string): string => formatFieldValue(key ? byKey.get(key) || null : null, value(key));

  const subtitle = text(spec.display.subtitle);
  const body = text(spec.display.body);
  const link = spec.display.link ? (value(spec.display.link) as string | undefined) : undefined;
  const time = text(spec.display.time);
  /**
   * 徽标。bool 字段特殊处理：裸一个「是」放在卡面上没人看得懂在说什么，
   * 所以显示字段标签本身（「追更中」「已 push」），真假用颜色区分。
   */
  const badges = spec.display.badges
    .map((key) => {
      const field = byKey.get(key) as SpecField | undefined;
      if (field?.type === "bool") {
        const on = value(key) === true;
        return { key, field, text: field.label, tone: on ? "on" : "off" };
      }
      return { key, field, text: text(key), tone: "" };
    })
    .filter((badge) => badge.text);

  const rows = spec.fields
    .filter((field) => !skip.has(field.key) && fields[field.key] !== undefined)
    .map((field) => ({ key: field.key, label: field.label, text: formatFieldValue(field, fields[field.key]) }));

  const SpecIcon = specIcon(spec.icon);
  const origin = data.source?.app || spec.source?.app || "";
  const empty = !subtitle && !body && !rows.length && !badges.length;

  return (
    <div className={full ? "dc full" : "dc"}>
      {/* 标题带：这张卡是什么规格 + 一句话次要信息 + 状态徽标 */}
      <div className="dc-kicker">
        <span className="dc-spec" title={t("cards.data.specTitle", { name: spec.name, version: spec.version })}>
          <SpecIcon size={11} strokeWidth={2.1} />
          {spec.name}
        </span>
        {subtitle ? <span className="dc-sub">{subtitle}</span> : null}
        {badges.map((badge) => (
          <span
            className={`dc-badge${badge.tone ? ` ${badge.tone}` : ""}`}
            key={badge.key}
            title={badge.field ? t("cards.data.rowTitle", { label: badge.field.label, value: text(badge.key) || "—" }) : undefined}
          >
            {badge.text}
          </span>
        ))}
      </div>

      <div className="dc-body nowheel">
        {body ? <div className="dc-text">{body}</div> : null}
        {body && rows.length ? <div className="dc-sep" /> : null}
        <FieldRows rows={rows} />
        {empty ? <span className="placeholder">{t("cards.data.noValues")}</span> : null}
      </div>

      {origin || time || link ? (
        <div className="dc-foot nodrag">
          <span className="dc-note">
            {[origin, time].filter(Boolean).join(" · ")}
          </span>
          <span className="foot-spacer" />
          {link ? (
            <a className="dc-open" href={link} target="_blank" rel="noopener noreferrer" title={link}>
              {t("cards.data.open")}
              <UI.external size={12} strokeWidth={2} />
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

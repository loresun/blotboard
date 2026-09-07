"use client";

/**
 * 资源库页（`/resources`）：把散在各块画板上的「引用资源」规格卡摊成一页。
 *
 * 要解决的是「好东西登记在板上，谁来都用不上」——skill / MCP / CLI 这类能被 agent
 * 直接装上用的资源，散在画板里就只有登记那块板的人知道。这一页把它们按类型 / 状态
 * 摊平、配上安装方式与触发词，人来了能翻能搜能复制安装命令；agent 走
 * `GET /api/resources` 拿**同一份数据**（连过滤参数都一致），两边的清单永不漂移。
 *
 * 这一页**只读不改数据**：登记与修订都在画板上做（规格卡 + 评论即交活），这里只负责看得清楚。
 * 数据全走 `/api/resources`；类型 / 状态的筛选在本地做——单机数据量下全量拉回更跟手。
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { SiteNav } from "./SiteNav";
import { api, type ResourceEntryInfo, type ResourceIndexInfo } from "@/lib/api-client";
import { formatTime } from "@/lib/constants";
import { ICON_MD, ICON_SM, UI } from "@/lib/icons";
import { useT } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";

/** 类型 → 文案键；没登记过的值原样显示（规格加新选项不用改这里也能看） */
const KIND_LABEL: Record<string, DictKey> = {
  skill: "pages.resources.kind.skill",
  mcp: "pages.resources.kind.mcp",
  cli: "pages.resources.kind.cli",
  library: "pages.resources.kind.library",
  template: "pages.resources.kind.template",
  service: "pages.resources.kind.service",
  dataset: "pages.resources.kind.dataset",
  other: "pages.resources.kind.other",
};

/** 状态 → 文案键与色调；verified 是唯一值得骄傲的档位，所以给它绿色 */
const STATUS_META: Record<string, { label: DictKey; tone: string }> = {
  verified: { label: "pages.resources.status.verified", tone: "ok" },
  trying: { label: "pages.resources.status.trying", tone: "try" },
  todo: { label: "pages.resources.status.todo", tone: "todo" },
  broken: { label: "pages.resources.status.broken", tone: "bad" },
  archived: { label: "pages.resources.status.archived", tone: "arch" },
};

const KIND_ORDER = ["skill", "mcp", "cli", "library", "template", "service", "dataset", "other"];
const STATUS_ORDER = ["verified", "trying", "todo", "broken", "archived"];

function fieldText(entry: ResourceEntryInfo, key: string): string {
  const value = entry.fields[key];
  return typeof value === "string" ? value : "";
}

function fieldTags(entry: ResourceEntryInfo, key: string): string[] {
  const value = entry.fields[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** 一条资源卡。安装块是一等公民——资源页的第一诉求是「怎么装上用」 */
function ResourceCard({ entry }: { entry: ResourceEntryInfo }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const kind = String(entry.fields.kind || "other");
  const status = String(entry.fields.status || "");
  const statusMeta = STATUS_META[status];
  const url = fieldText(entry, "url");
  const name = fieldText(entry, "name") || entry.title;
  const purpose = fieldText(entry, "purpose");
  const install = fieldText(entry, "install");
  const usage = fieldText(entry, "usage");
  const foundFrom = fieldText(entry, "foundFrom");
  const agents = fieldTags(entry, "agents");
  const triggers = fieldTags(entry, "triggers");

  const copyInstall = async () => {
    try {
      await navigator.clipboard.writeText(install);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 剪贴板被拒（无权限 / 非安全上下文）就静默——文本本来就显示在卡上，手动选也行 */
    }
  };

  return (
    <article className="res-card">
      <header className="res-card-head">
        <span className="res-icon" aria-hidden>
          <UI.library {...ICON_MD} />
        </span>
        <div className="res-titles">
          {url ? (
            <a className="res-name res-link" href={url} target="_blank" rel="noopener noreferrer" title={t("pages.resources.openHome")}>
              {name}
              <UI.external {...ICON_SM} />
            </a>
          ) : (
            <span className="res-name">{name}</span>
          )}
          {purpose ? <p className="res-purpose">{purpose}</p> : null}
        </div>
        <div className="res-pills">
          <span className="res-pill res-kind">{KIND_LABEL[kind] ? t(KIND_LABEL[kind]) : kind}</span>
          {statusMeta ? <span className={`res-pill res-status ${statusMeta.tone}`}>{t(statusMeta.label)}</span> : null}
        </div>
      </header>

      {install ? (
        <div className="res-install">
          <div className="res-install-head">
            <span>{t("pages.resources.install")}</span>
            <button className="res-copy" onClick={copyInstall} title={t("pages.resources.install.copy")}>
              {copied ? <UI.check {...ICON_SM} /> : <UI.copy {...ICON_SM} />}
              {copied ? t("common.copied") : t("common.copy")}
            </button>
          </div>
          <pre>{install}</pre>
        </div>
      ) : null}

      {usage ? <p className="res-usage">{usage}</p> : null}

      {agents.length || triggers.length ? (
        <div className="res-tags">
          {agents.map((agent) => (
            <span className="res-tag res-tag-agent" key={`a-${agent}`} title={t("pages.resources.tag.agent")}>
              <UI.agent {...ICON_SM} />
              {agent}
            </span>
          ))}
          {triggers.map((trigger) => (
            <span className="res-tag" key={`t-${trigger}`} title={t("pages.resources.tag.trigger")}>
              {trigger}
            </span>
          ))}
        </div>
      ) : null}

      <footer className="res-card-foot">
        <span className="res-meta" title={t("pages.resources.addedAt", { time: formatTime(entry.createdAt) })}>
          {formatTime(entry.createdAt)} · {entry.boardGroup ? `${entry.boardGroup} / ` : ""}
          {entry.boardName}
        </span>
        <span className="res-foot-links">
          {foundFrom ? (
            <a href={foundFrom} target="_blank" rel="noopener noreferrer" title={t("pages.resources.source.title")}>
              {t("pages.resources.source")}
            </a>
          ) : null}
          <a href={entry.link} target="_blank" rel="noopener noreferrer" title={t("pages.resources.openCard.title")}>
            <UI.detail {...ICON_SM} />
            {t("pages.resources.openCard")}
          </a>
        </span>
      </footer>
    </article>
  );
}

/** 一个筛选组：一排 chip，「全部」+ 按出现次数排的类型 / 状态 */
function FilterRow({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string;
  options: { key: string; label: string; count: number }[];
  onPick: (key: string) => void;
}) {
  const t = useT();
  if (!options.length) return null;
  return (
    <div className="res-filter">
      <span className="res-filter-label">{label}</span>
      <button className={`res-chip${value === "" ? " active" : ""}`} onClick={() => onPick("")}>
        {t("pages.resources.filter.all")}
      </button>
      {options.map((option) => (
        <button
          key={option.key}
          className={`res-chip${value === option.key ? " active" : ""}`}
          onClick={() => onPick(option.key)}
          title={t("pages.resources.filter.pick", { label: option.label, count: option.count })}
        >
          {option.label}
          <span className="res-chip-count">{option.count}</span>
        </button>
      ))}
    </div>
  );
}

export function ResourcesApp() {
  const t = useT();
  const [index, setIndex] = useState<ResourceIndexInfo | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    let alive = true;
    api
      .listResources()
      .then((data) => {
        if (alive) setIndex(data);
      })
      .catch((err: Error) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  /** 本地筛选：关键词命中 名称 / 用途 / 安装 / 用法 / 触发词 / 适配（与服务端 ?q= 同一文本口径） */
  const shown = useMemo(() => {
    const all = index?.resources || [];
    const keyword = query.trim().toLowerCase();
    return all.filter((entry) => {
      if (kind && String(entry.fields.kind || "other") !== kind) return false;
      if (status && String(entry.fields.status || "") !== status) return false;
      if (!keyword) return true;
      const tags = [...fieldTags(entry, "triggers"), ...fieldTags(entry, "agents")].join(" ");
      const haystack = [
        entry.title,
        fieldText(entry, "name"),
        fieldText(entry, "purpose"),
        fieldText(entry, "install"),
        fieldText(entry, "usage"),
        fieldText(entry, "notes"),
        fieldText(entry, "url"),
        tags,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }, [index, query, kind, status]);

  const kindOptions = useMemo(() => {
    const counts = index?.counts.kinds || {};
    return KIND_ORDER.filter((key) => counts[key])
      .map((key) => ({ key, label: KIND_LABEL[key] ? t(KIND_LABEL[key]) : key, count: counts[key] }))
      .concat(
        Object.keys(counts)
          .filter((key) => !KIND_ORDER.includes(key))
          .map((key) => ({ key, label: key, count: counts[key] })),
      );
  }, [index, t]);

  const statusOptions = useMemo(() => {
    const counts = index?.counts.statuses || {};
    return STATUS_ORDER.filter((key) => counts[key]).map((key) => ({
      key,
      label: STATUS_META[key] ? t(STATUS_META[key].label) : key,
      count: counts[key],
    }));
  }, [index, t]);

  const verifiedCount = (index?.counts.statuses || {}).verified || 0;

  return (
    <div className="app nav-app">
      <header className="topbar">
        <Link className="top-btn icon-only" href="/" title={t("pages.nav.back")} aria-label={t("pages.nav.back")}>
          <UI.back {...ICON_MD} />
        </Link>
        <div className="brand">{t("pages.resources.brand")}</div>
        {/* 五个页面同一副导航（真源 components/SiteNav.tsx）：子页面之间同标签切换 */}
        <SiteNav current="resources" />
      </header>

      <div className="res-wrap">
        <section className="res-hero">
          <h1>{t("pages.resources.heroTitle")}</h1>
          <p>
            {t("pages.resources.heroText")}<code>GET /api/resources</code>{t("pages.resources.heroText2")}
          </p>
          {index ? (
            <div className="res-stats">
              <span className="res-stat">
                {t("pages.resources.total.before")}<b>{index.total}</b>{t("pages.resources.total.after")}
              </span>
              <span className="res-stat">
                {t("pages.resources.verified.before")}<b>{verifiedCount}</b>{t("pages.resources.verified.after")}
              </span>
              <span className="res-stat res-stat-api" title={t("pages.resources.api.title")}>
                <UI.code {...ICON_SM} />
                <code>/api/resources</code>
              </span>
            </div>
          ) : null}
        </section>

        <div className="res-toolbar">
          <label className={`nav-search${query ? " active" : ""}`}>
            <UI.search size={14} strokeWidth={1.9} />
            <input
              value={query}
              placeholder={t("pages.resources.search")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  (event.target as HTMLInputElement).blur();
                }
              }}
            />
            {query ? (
              <button className="nav-search-clear" title={t("pages.resources.search.clear")} onClick={() => setQuery("")}>
                <UI.close size={14} strokeWidth={1.9} />
              </button>
            ) : null}
          </label>
          <FilterRow label={t("pages.resources.filter.kind")} value={kind} options={kindOptions} onPick={setKind} />
          <FilterRow label={t("pages.resources.filter.status")} value={status} options={statusOptions} onPick={setStatus} />
        </div>

        {error ? (
          <div className="res-empty">{t("pages.resources.error", { message: error })}</div>
        ) : !index ? (
          <div className="res-empty">{t("pages.resources.loading")}</div>
        ) : shown.length ? (
          <div className="res-grid">
            {shown.map((entry) => (
              <ResourceCard key={entry.cardId} entry={entry} />
            ))}
          </div>
        ) : (
          <div className="res-empty">
            {index.total ? t("pages.resources.noMatch") : t("pages.resources.empty")}
          </div>
        )}
      </div>

      <footer className="res-foot">
        <span>{t("pages.resources.foot")}</span>
      </footer>
    </div>
  );
}

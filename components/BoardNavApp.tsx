"use client";

/**
 * 画板导航页（`/nav`）：左边分组，右边一块块画板，点开就是新标签页里的那块板。
 *
 * 要解决的是「板太多找不到」——将近两百块板挤在左栏树里，靠滚动认名字太慢。
 * 所以这一页把板本身摊成一格格卡片：分组、卡片数、建/改时间、24 小时内动过的标出来，
 * 再配上**按时间排**（哪些是新建的、哪些刚更新的一眼看得出）与搜索（板名 + 卡片内容）。
 *
 * 卡片导航是**下一层**：某块板上点「卡片」，右边换成这块板的卡片清单，
 * 点一张同样新标签页打开并定位到那张卡（`/?board=&card=`，与分享链接同一套深链）。
 *
 * 数据只走 `/api/boards`（分组与板）、`/api/boards/search`（内容命中）、
 * `/api/boards/cards`（下钻后的卡片索引）；排序与收窄都在服务端或本地算，不改任何数据。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { SiteNav } from "./SiteNav";
import { api } from "@/lib/api-client";
import { COLORS, LS_NAV, NAV_FRESH_MS, NAV_PAGE_SIZE, STATUS_DOT, STATUS_META, formatTime } from "@/lib/constants";
import { ICON_MD, TYPE_ICON, UI, typeIcon } from "@/lib/icons";
import { useCardLabel, useT } from "@/lib/i18n/client";
import type { DictKey } from "@/lib/i18n";
import { BOARD_CARD_TYPES, type BoardListItem, type BoardNavCard, type CardType, type NavOrder, type NavSort } from "@/lib/types";

/** 右边看哪一撮板：全部，还是某个分组 */
type Scope = { kind: "all" } | { kind: "group"; group: string };

/** 文案要跟着语言走，所以取文案的函数由组件把 `t` 传进来 */
type Translate = (key: DictKey, vars?: Record<string, string | number>) => string;

/**
 * 一个分组。两个时间都取组里**最近的那一次**：
 * createdAt = 最近一次在这个分组里建板，updatedAt = 最近一次改动。
 * 「这个分组有没有新东西」正是分组排序要回答的问题——取最早那块板反而看不出来。
 */
interface NavGroup {
  name: string;
  boards: BoardListItem[];
  cards: number;
  createdAt: number;
  updatedAt: number;
}

/** 相对时间：导航页要回答的是「多新」，不是「几点几分」 */
function relTime(ms: number, t: Translate): string {
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff) || diff < 0) return formatTime(ms);
  if (diff < 60_000) return t("pages.time.justNow");
  if (diff < 3_600_000) return t("pages.time.minutes", { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t("pages.time.hours", { n: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t("pages.time.days", { n: Math.floor(diff / 86_400_000) });
  return formatTime(ms);
}

/**
 * 新鲜度：24 小时内建的算「新建」，否则 24 小时内改过的算「更新」。
 * 只给一个标——刚建的当然也是刚改的，两个标一起挂等于没标。
 */
function freshness(createdAt: number, updatedAt: number): "new" | "updated" | null {
  const now = Date.now();
  if (now - createdAt < NAV_FRESH_MS) return "new";
  if (now - updatedAt < NAV_FRESH_MS) return "updated";
  return null;
}

function FreshBadge({ createdAt, updatedAt }: { createdAt: number; updatedAt: number }) {
  const t = useT();
  const fresh = freshness(createdAt, updatedAt);
  if (!fresh) return null;
  return <span className={`nav-badge ${fresh}`}>{fresh === "new" ? t("pages.nav.badge.new") : t("pages.nav.badge.updated")}</span>;
}

/** 两个时间都写进 title：卡面上只显示当前排序的那个，另一个鼠标一停就看得到 */
function timeTitle(createdAt: number, updatedAt: number, t: Translate): string {
  return t("pages.nav.timeTitle", { created: formatTime(createdAt), updated: formatTime(updatedAt) });
}

/** 板与卡都按同一套「字段 + 方向」排；空 updatedAt 退回 createdAt */
function timeOfBoard(board: BoardListItem, sort: NavSort): number {
  return sort === "created" ? board.createdAt : board.updatedAt || board.createdAt;
}

export function BoardNavApp() {
  const t = useT();
  const cardLabel = useCardLabel();
  const UNGROUPED = t("pages.nav.ungrouped");
  const [boards, setBoards] = useState<BoardListItem[]>([]);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [sort, setSort] = useState<NavSort>("updated");
  const [order, setOrder] = useState<NavOrder>("desc");
  const [query, setQuery] = useState("");
  const [keyword, setKeyword] = useState("");
  const [error, setError] = useState("");
  /** 偏好读完（localStorage）之前不拉数据，免得先按默认条件白拉一次 */
  const [ready, setReady] = useState(false);

  /** 下钻：不为 null 时右边换成这块板的卡片导航 */
  const [drill, setDrill] = useState<BoardListItem | null>(null);
  /** 关键词在卡片正文里命中的板 → 命中卡片数（板名没写关键词也能找回来） */
  const [contentHits, setContentHits] = useState<Map<string, number>>(new Map());

  /* ── 启动：偏好（排序）从 localStorage 来，范围（看哪一撮）从地址栏来 ── */
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(LS_NAV) || "{}");
      if (saved.sort === "created" || saved.sort === "updated") setSort(saved.sort);
      if (saved.order === "asc" || saved.order === "desc") setOrder(saved.order);
    } catch {
      /* 存坏了就用默认值，不值得为此报错 */
    }
    const params = new URLSearchParams(window.location.search);
    const wantGroup = params.get("group");
    if (wantGroup !== null) setScope({ kind: "group", group: wantGroup });
    const wantQuery = params.get("q") || "";
    if (wantQuery) {
      setQuery(wantQuery);
      setKeyword(wantQuery);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    if (!ready) return;
    window.localStorage.setItem(LS_NAV, JSON.stringify({ sort, order }));
  }, [ready, sort, order]);

  /* 范围与关键词写回地址栏：这一页也该分享得出去、后退回得来 */
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams();
    if (scope.kind === "group") params.set("group", scope.group);
    if (keyword) params.set("q", keyword);
    if (drill) params.set("cards", drill.id);
    const search = params.toString();
    window.history.replaceState(null, "", search ? `${window.location.pathname}?${search}` : window.location.pathname);
  }, [ready, scope, keyword, drill]);

  /* 搜索框防抖：每敲一个字都打一次全库扫描没必要 */
  useEffect(() => {
    const timer = setTimeout(() => setKeyword(query.trim()), 260);
    return () => clearTimeout(timer);
  }, [query]);

  const loadBoards = useCallback(async () => {
    try {
      const list = await api.listBoards();
      setBoards(list);
      setError("");
      return list;
    } catch (err) {
      setError((err as Error).message);
      return [];
    }
  }, []);

  useEffect(() => {
    void loadBoards();
  }, [loadBoards]);

  /* 地址栏带 ?cards=b_xxx 时直接进卡片导航（板列表拉回来之后才认得出是哪块） */
  useEffect(() => {
    if (!ready || drill) return;
    const want = new URLSearchParams(window.location.search).get("cards");
    if (!want) return;
    const target = boards.find((board) => board.id === want);
    if (target) setDrill(target);
  }, [ready, boards, drill]);

  /* ── 板名之外再搜一层卡片内容 ──────────────────────
     「找不到那块板」经常是因为只记得上面写了什么。命中数据来自
     /api/boards/search（板数有上限，够用来把板捞出来，不用于精确统计）。 */
  useEffect(() => {
    if (drill || !keyword) {
      setContentHits(new Map());
      return;
    }
    let alive = true;
    api
      .searchBoards(keyword)
      .then((result) => {
        if (alive) setContentHits(new Map(result.boards.map((hit) => [hit.id, hit.cardTotal])));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [keyword, drill]);

  /* ── 左栏：把画板按分组归拢，并记下这撮板最近一次的建 / 改时间 ── */
  const groups = useMemo(() => {
    const map = new Map<string, NavGroup>();
    for (const board of boards) {
      const name = board.group || "";
      const created = board.createdAt;
      const updated = board.updatedAt || board.createdAt;
      const entry = map.get(name) || { name, boards: [], cards: 0, createdAt: created, updatedAt: updated };
      entry.boards.push(board);
      entry.cards += board.counts?.cards || 0;
      entry.createdAt = Math.max(entry.createdAt, created);
      entry.updatedAt = Math.max(entry.updatedAt, updated);
      map.set(name, entry);
    }
    return [...map.values()];
  }, [boards]);

  /** 分组按「最近一次建板 / 最近一次改动」排；方向只是把这同一个键掉个头——
      排序键与卡面上显示的时间必须是同一个数，否则「明明写着 5 天前却排在最前」。 */
  const sortedGroups = useMemo(() => {
    const timeOf = (group: NavGroup) => (sort === "created" ? group.createdAt : group.updatedAt);
    return [...groups].sort((a, b) => (order === "asc" ? timeOf(a) - timeOf(b) : timeOf(b) - timeOf(a)));
  }, [groups, sort, order]);

  /**
   * 右栏的板：分组收窄 + 排序。
   * 搜索时**跨全部分组**——「找不到」的时候，还按当前分组过滤等于帮倒忙。
   */
  const visibleBoards = useMemo(() => {
    const key = keyword.toLowerCase();
    const pool = key
      ? boards.filter(
          (board) =>
            board.name.toLowerCase().includes(key) ||
            (board.group || "").toLowerCase().includes(key) ||
            contentHits.has(board.id),
        )
      : scope.kind === "group"
        ? boards.filter((board) => (board.group || "") === scope.group)
        : boards;
    return [...pool].sort((a, b) => {
      const left = timeOfBoard(a, sort);
      const right = timeOfBoard(b, sort);
      return order === "asc" ? left - right : right - left;
    });
  }, [boards, keyword, contentHits, scope, sort, order]);

  const allCards = useMemo(() => boards.reduce((sum, board) => sum + (board.counts?.cards || 0), 0), [boards]);

  /* ── 下钻后的卡片索引 ──────────────────────────── */
  const [cards, setCards] = useState<BoardNavCard[]>([]);
  const [cardTotal, setCardTotal] = useState(0);
  const [typeCounts, setTypeCounts] = useState<Partial<Record<CardType, number>>>({});
  const [types, setTypes] = useState<CardType[]>([]);
  const [cardQuery, setCardQuery] = useState("");
  const [cardKeyword, setCardKeyword] = useState("");
  const [cardLoading, setCardLoading] = useState(false);
  const seqRef = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setCardKeyword(cardQuery.trim()), 260);
    return () => clearTimeout(timer);
  }, [cardQuery]);

  /** 换一块板下钻就把上一块的筛选清掉，免得「这块板怎么是空的」 */
  useEffect(() => {
    setTypes([]);
    setCardQuery("");
    setCardKeyword("");
    setCards([]);
    setCardTotal(0);
  }, [drill?.id]);

  const loadCards = useCallback(
    async (offset: number) => {
      if (!drill) return;
      const seq = ++seqRef.current;
      setCardLoading(true);
      try {
        const result = await api.cardIndex({
          boardId: drill.id,
          query: cardKeyword,
          types,
          sort,
          order,
          limit: NAV_PAGE_SIZE,
          offset,
        });
        // 慢响应不许盖掉新条件的结果
        if (seq !== seqRef.current) return;
        setCards((prev) => (offset ? [...prev, ...result.cards] : result.cards));
        setCardTotal(result.total);
        setTypeCounts(result.typeCounts);
        setError("");
      } catch (err) {
        if (seq === seqRef.current) setError((err as Error).message);
      } finally {
        if (seq === seqRef.current) setCardLoading(false);
      }
    },
    [drill, cardKeyword, types, sort, order],
  );

  useEffect(() => {
    if (!drill) return;
    void loadCards(0);
  }, [drill, loadCards]);

  function openGroup(name: string) {
    setDrill(null);
    setScope({ kind: "group", group: name });
  }

  function toggleType(type: CardType) {
    setTypes((prev) => (prev.includes(type) ? prev.filter((item) => item !== type) : [...prev, type]));
  }

  const activeTypes = BOARD_CARD_TYPES.filter((type) => (typeCounts[type] || 0) > 0 || types.includes(type));
  const scopeLabel = keyword ? t("pages.nav.scope.search", { keyword }) : scope.kind === "group" ? scope.group || UNGROUPED : t("pages.nav.allBoards");

  return (
    <div className="app nav-app">
      <header className="topbar">
        <Link className="top-btn icon-only" href="/" title={t("pages.nav.back")} aria-label={t("pages.nav.back")}>
          <UI.back {...ICON_MD} />
        </Link>
        <div className="brand">{drill ? t("pages.nav.brand.cards") : t("pages.nav.brand.boards")}</div>
        {/* 五个页面同一副导航（真源 components/SiteNav.tsx） */}
        <SiteNav current="nav" />
        <div className={`nav-search${(drill ? cardQuery : query) ? " active" : ""}`}>
          <UI.search size={14} strokeWidth={1.9} />
          <input
            value={drill ? cardQuery : query}
            placeholder={drill ? t("pages.nav.search.cards") : t("pages.nav.search.boards")}
            onChange={(event) => (drill ? setCardQuery(event.target.value) : setQuery(event.target.value))}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                if (drill) setCardQuery("");
                else setQuery("");
                (event.target as HTMLInputElement).blur();
              }
            }}
          />
          {(drill ? cardQuery : query) ? (
            <button
              className="nav-search-clear"
              title={t("pages.nav.search.clear")}
              onClick={() => (drill ? setCardQuery("") : setQuery(""))}
            >
              <UI.close size={12} strokeWidth={2} />
            </button>
          ) : null}
        </div>
        <div className="spacer" />
        <div className="nav-seg" role="group" aria-label={t("pages.nav.sortFieldAria")}>
          <button className={sort === "updated" ? "on" : ""} title={t("pages.nav.sort.updated.title")} onClick={() => setSort("updated")}>
            {t("pages.nav.sort.updated")}
          </button>
          <button className={sort === "created" ? "on" : ""} title={t("pages.nav.sort.created.title")} onClick={() => setSort("created")}>
            {t("pages.nav.sort.created")}
          </button>
        </div>
        <div className="nav-seg" role="group" aria-label={t("pages.nav.sortOrderAria")}>
          <button className={order === "desc" ? "on" : ""} title={t("pages.nav.order.desc.title")} onClick={() => setOrder("desc")}>
            {t("pages.nav.order.desc")}
          </button>
          <button className={order === "asc" ? "on" : ""} title={t("pages.nav.order.asc.title")} onClick={() => setOrder("asc")}>
            {t("pages.nav.order.asc")}
          </button>
        </div>
        <button
          className="top-btn icon-only"
          title={t("pages.nav.refresh.title")}
          aria-label={t("pages.nav.refresh")}
          onClick={() => {
            void loadBoards();
            if (drill) void loadCards(0);
          }}
        >
          <UI.refresh {...ICON_MD} />
        </button>
      </header>

      <div className="main nav-main">
        <aside className="nav-side">
          <div className="nav-side-head">
            {t("pages.nav.groups")} <span className="aside-count">{groups.length}</span>
          </div>
          <div className="nav-side-list">
            <button
              className={`nav-scope all${scope.kind === "all" ? " active" : ""}`}
              onClick={() => {
                setDrill(null);
                setScope({ kind: "all" });
              }}
            >
              <span className="ns-line">
                <UI.library size={13} strokeWidth={1.9} />
                <span className="ns-name">{t("pages.nav.allBoards")}</span>
              </span>
              <span className="ns-line sub">
                {t("pages.nav.allSummary", { boards: boards.length, cards: allCards })}
              </span>
            </button>

            {!boards.length ? <div className="nav-empty">{t("pages.nav.noBoards")}</div> : null}

            {sortedGroups.map((group) => (
              <button
                key={group.name || "(ungrouped)"}
                className={`nav-scope${scope.kind === "group" && scope.group === group.name ? " active" : ""}`}
                title={t("pages.nav.groupTitle", { created: formatTime(group.createdAt), updated: formatTime(group.updatedAt) })}
                onClick={() => openGroup(group.name)}
              >
                <span className="ns-line">
                  <UI.blocks size={13} strokeWidth={1.9} />
                  <span className="ns-name">{group.name || UNGROUPED}</span>
                  <FreshBadge createdAt={group.createdAt} updatedAt={group.updatedAt} />
                </span>
                <span className="ns-line sub">
                  {t("pages.nav.groupSummary", {
                    time: relTime(sort === "created" ? group.createdAt : group.updatedAt, t),
                    boards: group.boards.length,
                    cards: group.cards,
                  })}
                </span>
              </button>
            ))}
          </div>
        </aside>

        {drill ? (
          /* ── 第二层：某一块板的卡片导航 ── */
          <section className="nav-body">
            <div className="nav-body-head">
              <button className="mini-btn" onClick={() => setDrill(null)}>
                <UI.back size={13} strokeWidth={1.9} /> {t("pages.nav.boardList")}
              </button>
              <h1 className="nav-title">{drill.name}</h1>
              <span className="nav-count">
                {cardLoading && !cards.length ? t("pages.nav.loading") : t("pages.nav.cardCount", { count: cardTotal })}
                {cardKeyword ? t("pages.nav.containing", { keyword: cardKeyword }) : ""}
              </span>
              <a className="mini-btn" href={`/?board=${encodeURIComponent(drill.id)}`} target="_blank" rel="noopener noreferrer">
                <UI.external size={13} strokeWidth={1.9} /> {t("pages.nav.openBoardTab")}
              </a>
            </div>

            {activeTypes.length > 1 ? (
              <div className="nav-types">
                <button className={types.length ? "" : "on"} onClick={() => setTypes([])}>
                  {t("pages.nav.allTypes")}
                </button>
                {activeTypes.map((type) => {
                  const Icon = TYPE_ICON[type];
                  return (
                    <button key={type} className={types.includes(type) ? "on" : ""} onClick={() => toggleType(type)}>
                      <Icon size={12} strokeWidth={1.9} />
                      {cardLabel(type)}
                      <span className="aside-count">{typeCounts[type] || 0}</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {error ? <div className="nav-error">{error}</div> : null}

            <div className="nav-grid">
              {cards.map((card) => {
                const Icon = typeIcon(card.type);
                return (
                  <a
                    key={card.id}
                    className="nav-card"
                    href={`/?board=${encodeURIComponent(card.boardId)}&card=${encodeURIComponent(card.id)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={timeTitle(card.createdAt, card.updatedAt, t)}
                    style={{ borderTopColor: COLORS[card.color] }}
                  >
                    <div className="nc-head">
                      <Icon size={13} strokeWidth={1.9} />
                      <span className="nc-type">{cardLabel(card.type)}</span>
                      {card.taskStatus ? (
                        <span className="nc-status">
                          <i style={{ background: STATUS_DOT[card.taskStatus] }} />
                          {t(STATUS_META[card.taskStatus])}
                        </span>
                      ) : null}
                      <FreshBadge createdAt={card.createdAt} updatedAt={card.updatedAt} />
                      <span className="nc-time">
                        {sort === "created" ? t("pages.nav.createdShort") : t("pages.nav.updatedShort")}{" "}
                        {relTime(sort === "created" ? card.createdAt : card.updatedAt, t)}
                      </span>
                    </div>
                    <div className="nc-title">{card.title || t("pages.nav.cardFallbackTitle", { label: cardLabel(card.type) })}</div>
                    {card.preview ? <div className="nc-preview">{card.preview}</div> : null}
                  </a>
                );
              })}
            </div>

            {!cardLoading && !cards.length && !error ? (
              <div className="nav-empty big">
                {cardKeyword || types.length ? t("pages.nav.noCardMatch") : t("pages.nav.emptyBoard")}
              </div>
            ) : null}

            {cards.length < cardTotal ? (
              <div className="nav-more">
                <button className="mini-btn" disabled={cardLoading} onClick={() => void loadCards(cards.length)}>
                  {cardLoading ? t("pages.nav.loading") : t("pages.nav.loadMore", { count: cardTotal - cards.length })}
                </button>
              </div>
            ) : null}
          </section>
        ) : (
          /* ── 第一层：画板导航 ── */
          <section className="nav-body">
            <div className="nav-body-head">
              <h1 className="nav-title">{scopeLabel}</h1>
              <span className="nav-count">
                {t("pages.nav.boardCount", { count: visibleBoards.length })}
                {keyword ? t("pages.nav.acrossGroups") : ""}
              </span>
            </div>

            {error ? <div className="nav-error">{error}</div> : null}

            <div className="nav-grid boards">
              {visibleBoards.map((board) => {
                const created = board.createdAt;
                const updated = board.updatedAt || board.createdAt;
                const hit = contentHits.get(board.id);
                const href = `/?board=${encodeURIComponent(board.id)}`;
                return (
                  <div className="nav-board" key={board.id}>
                    <a
                      className="nb-main"
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={t("pages.nav.boardTitle", { time: timeTitle(created, updated, t) })}
                    >
                      <div className="nb-head">
                        <UI.blocks size={12} strokeWidth={1.9} />
                        <span className="nb-group">{board.group || UNGROUPED}</span>
                        <FreshBadge createdAt={created} updatedAt={updated} />
                        <span className="nb-time">
                          {sort === "created" ? t("pages.nav.createdShort") : t("pages.nav.updatedShort")}{" "}
                          {relTime(sort === "created" ? created : updated, t)}
                        </span>
                      </div>
                      <div className="nb-name">{board.name}</div>
                      <div className="nb-counts">
                        <span>{t("pages.nav.counts.cards", { count: board.counts?.cards || 0 })}</span>
                        <span>{t("pages.nav.counts.edges", { count: board.counts?.edges || 0 })}</span>
                        {board.counts?.tasks ? <span>{t("pages.nav.counts.tasks", { count: board.counts.tasks })}</span> : null}
                        {board.counts?.openComments ? (
                          <span className="hot">{t("pages.nav.counts.comments", { count: board.counts.openComments })}</span>
                        ) : null}
                        {hit ? <span className="hit">{t("pages.nav.counts.hits", { count: hit })}</span> : null}
                      </div>
                    </a>
                    <div className="nb-foot">
                      <button
                        className="nb-act"
                        title={t("pages.nav.cardNav.title")}
                        onClick={() => {
                          setDrill(board);
                          setQuery("");
                        }}
                      >
                        <UI.grid size={12} strokeWidth={1.9} /> {t("pages.nav.cardNav")}
                      </button>
                      <a className="nb-act" href={href} target="_blank" rel="noopener noreferrer">
                        <UI.external size={12} strokeWidth={1.9} /> {t("pages.nav.openTab")}
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>

            {!visibleBoards.length ? (
              <div className="nav-empty big">
                {keyword ? t("pages.nav.noBoardMatch", { keyword }) : t("pages.nav.emptyGroup")}
              </div>
            ) : null}
          </section>
        )}
      </div>
    </div>
  );
}

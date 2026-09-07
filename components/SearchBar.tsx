"use client";

/** 画布搜索 + 类型筛选：命中的卡片高亮，其余变淡；回车逐个跳（Shift+回车往回）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { boardKeyBlocked } from "@/lib/keyboard-shortcuts";
import { ICON_SM, TYPE_ICON, UI } from "@/lib/icons";
import { useCardLabel, useT } from "@/lib/i18n/client";
import { cardMatches, useBoardStore } from "@/lib/store";
import { BOARD_CARD_TYPES, type BoardCard, type CardType } from "@/lib/types";

/**
 * 命中按画布上的位置排：上到下、同一横排再左到右。
 *
 * 不按 `cards` 的数据顺序（那是创建顺序）——「下一个」得跟着眼睛走，
 * 否则在大板上连按几次回车，视口会在画布两端来回横跳。
 * y 先归到 40px 的带里，免得同一排的卡差几像素就被判成上下两排。
 */
function orderHits(cards: BoardCard[] | undefined, search: string, typeFilter: CardType[]): BoardCard[] {
  if (!search.trim() && !typeFilter.length) return [];
  return (cards || [])
    .filter((card) => cardMatches(card, search, typeFilter))
    .sort((a, b) => Math.round(a.y / 40) - Math.round(b.y / 40) || a.x - b.x);
}

/**
 * 输入到生效之间的防抖。
 *
 * search 写进 store 会让画布把节点重新过一遍（命中/淡出要重算）、左栏分组重算、
 * 命中计数重算。不防抖的话大板上每敲一个字都要付一次这个代价。
 * 150 ms 短到打字时察觉不到，又足以把连续击键并成一次。
 */
const SEARCH_DEBOUNCE_MS = 150;

export function SearchBar() {
  const t = useT();
  const cardLabel = useCardLabel();
  const search = useBoardStore((state) => state.search);
  const typeFilter = useBoardStore((state) => state.typeFilter);
  const setSearch = useBoardStore((state) => state.setSearch);
  const toggleTypeFilter = useBoardStore((state) => state.toggleTypeFilter);
  const clearFilters = useBoardStore((state) => state.clearFilters);
  const board = useBoardStore((state) => state.board);
  const collapsed = useBoardStore((state) => state.toolboxCollapsed);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // ⌘F 在收起态按下：先展开工具箱，等输入框渲染出来再聚焦
  const wantFocus = useRef(false);
  // 输入框自己的即时值（打字要跟手），store 里的那份延迟写
  const [draft, setDraft] = useState(search);

  /**
   * 筛选条只列**这块板上真有的类型**（外加当前已选中的，免得筛到零命中时那颗芯片自己消失）。
   *
   * 以前是把全部原生类型一股脑摆出来：在一块只有文本卡的板上，「只看图书卡 / 只看 PDF」
   * 这些芯片按了也只会得到空板；而且每加一种卡片包这一行就长一截，
   * 涨到一定程度会盖住画布左上角那片本该能点的地方。
   */
  const chipTypes = useMemo(() => {
    const present = new Set<string>((board?.cards || []).map((card) => card.type));
    for (const type of typeFilter) present.add(type);
    return BOARD_CARD_TYPES.filter((type) => present.has(type));
  }, [board?.cards, typeFilter]);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const atIdRef = useRef<string | null>(null);
  const pushed = useRef(search);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // store 里的值被别处改掉时（Esc 清除筛选、点 ×）把输入框同步回来
  useEffect(() => {
    if (search === pushed.current) return;
    pushed.current = search;
    setDraft(search);
  }, [search]);

  const queueSearch = useCallback(
    (value: string) => {
      setDraft(value);
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => {
        pushed.current = value;
        setSearch(value);
      }, SEARCH_DEBOUNCE_MS);
    },
    [setSearch],
  );

  /** 回车 / Esc 这类要立刻生效，不能等防抖。 */
  const flushSearch = useCallback(
    (value: string) => {
      if (debounce.current) clearTimeout(debounce.current);
      pushed.current = value;
      setSearch(value);
    },
    [setSearch],
  );

  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  const hits = useMemo(() => orderHits(board?.cards, search, typeFilter), [board?.cards, search, typeFilter]);

  /**
   * 停在第几个命中——记的是**卡片 id** 不是下标：换关键词、卡片被删、板被改，
   * 下标都会指到别的卡上去；id 找不到就等于「还没开始跳」，从头再来。
   */
  const [atId, setAtId] = useState<string | null>(null);
  const position = atId ? hits.findIndex((card) => card.id === atId) + 1 : 0;

  /**
   * 跳到下一个 / 上一个命中，到头绕回去。
   *
   * 命中列表现算：防抖还没落地时 `hits` 还是上一轮关键词的结果，
   * 而回车恰恰是「刚打完字就按」的那一下。
   */
  const step = useCallback(
    (delta: number) => {
      const state = useBoardStore.getState();
      const list = orderHits(state.board?.cards, draftRef.current, state.typeFilter);
      if (!list.length) return;
      // 没跳过就看画布上选中的那张：手点了一张命中卡之后按回车，接着它往下走
      const selected = state.selection?.kind === "card" ? state.selection.id : null;
      const from = list.findIndex((card) => card.id === (atIdRef.current || selected));
      const next = from < 0 ? (delta > 0 ? 0 : list.length - 1) : (from + delta + list.length) % list.length;
      atIdRef.current = list[next].id;
      setAtId(list[next].id);
      state.requestFocus(list[next].id);
    },
    [],
  );

  // ⌘F / Ctrl+F 聚焦搜索框（浏览器自带查找对画布没用）；工具箱收着就先展开
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (boardKeyBlocked(event, useBoardStore.getState())) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        const state = useBoardStore.getState();
        if (state.toolboxCollapsed) {
          wantFocus.current = true;
          state.setToolboxCollapsed(false);
          return;
        }
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (collapsed || !wantFocus.current) return;
    wantFocus.current = false;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [collapsed]);

  const active = Boolean(search.trim() || typeFilter.length);
  // 收起时组件保持挂载（⌘F 监听还得活着），只是不画界面
  if (collapsed) return null;

  return (
    <div className={`search-bar${active ? " active" : ""}`}>
      <div className="search-input">
        <UI.search {...ICON_SM} />
        <input
          ref={inputRef}
          value={draft}
          placeholder={t("pages.search.placeholder")}
          onChange={(event) => queueSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Escape") {
              if (debounce.current) clearTimeout(debounce.current);
              pushed.current = "";
              setDraft("");
              atIdRef.current = null;
              setAtId(null);
              clearFilters();
              (event.target as HTMLInputElement).blur();
            }
            if (event.key === "Enter") {
              // 回车是「跳到下一个命中」，Shift+回车往回；两者都先把防抖里的关键词落地
              event.preventDefault();
              flushSearch(draft);
              step(event.shiftKey ? -1 : 1);
            }
          }}
        />
        {active ? (
          <>
            {/* 跳过之后显示「第几个/共几个」，还没跳就只报总数——0/12 看着像没命中 */}
            <span className="search-count">{position ? `${position}/${hits.length}` : hits.length}</span>
            {hits.length > 1 ? (
              <span className="search-step">
                {/* 按下不抢焦点：输入框还得留着，好接着敲回车 */}
                <button
                  title={t("pages.search.prev.title")}
                  aria-label={t("pages.search.prev")}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => step(-1)}
                >
                  <UI.chevron size={12} strokeWidth={2.2} />
                </button>
                <button
                  title={t("pages.search.next.title")}
                  aria-label={t("pages.search.next")}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => step(1)}
                >
                  <UI.chevron size={12} strokeWidth={2.2} />
                </button>
              </span>
            ) : null}
            <button
              className="search-clear"
              title={t("pages.search.clear")}
              onClick={() => {
                if (debounce.current) clearTimeout(debounce.current);
                pushed.current = "";
                setDraft("");
                atIdRef.current = null;
                setAtId(null);
                clearFilters();
              }}
            >
              <UI.close size={13} strokeWidth={2} />
            </button>
          </>
        ) : null}
      </div>
      {/* 空板上一个芯片都没有：整行不渲染，免得在搜索框下面留一道空隙 */}
      <div className="type-chips" hidden={!chipTypes.length}>
        {chipTypes.map((type: CardType) => {
          const Icon = TYPE_ICON[type];
          const on = typeFilter.includes(type);
          return (
            <button
              key={type}
              className={`type-chip${on ? " on" : ""}`}
              title={t("pages.search.onlyType", { label: cardLabel(type) })}
              onClick={() => toggleTypeFilter(type)}
            >
              <Icon size={13} strokeWidth={1.9} />
              {cardLabel(type)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

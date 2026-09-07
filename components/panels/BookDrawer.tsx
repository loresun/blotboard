"use client";

/**
 * 书库抽屉（后端由 `BOOK_LIBRARY_URL` 指定）。
 *
 * 用途：把本机写好的书摆到画板上——做书单、排产品矩阵、把「这本书」跟任务/想法连起来。
 * 跟资料卡同一条红线：画板只存 bookId 与一份元信息快照，封面与正文都回书库取。
 *
 * 全量拉回来在前端筛：书库统共几十本，没有分页也没有检索口，
 * 拉一次全量比给书库加一个只有画板会用的接口划算，顺手还换来了「输入即筛」的手感。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { useT, tr } from "@/lib/i18n/client";
import { ICON_MD, ICON_SM, TYPE_ICON, UI } from "@/lib/icons";
import { useBoardStore } from "@/lib/store";
import { BookCover } from "../cards/BookCover";
import type { BookSummary } from "@/lib/integrations/library-provider";

const BookIcon = TYPE_ICON.book;

export function BookDrawer() {
  const open = useBoardStore((state) => state.drawer === "books");
  const boardId = useBoardStore((state) => state.boardId);
  const t = useT();
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 每次打开都重拉：书库随时在写新书，抽屉里看到的该是此刻的书目
  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 120);
    let alive = true;
    setError("");
    (async () => {
      try {
        const data = await api.listBooks();
        if (alive) setBooks(data.books);
      } catch (err) {
        if (alive) {
          setBooks([]);
          setError((err as Error).message);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  const hits = useMemo(() => {
    const key = query.trim().toLowerCase();
    if (!key) return books || [];
    return (books || []).filter((book) =>
      [book.bookId, book.name, book.subtitle, book.author, book.desc].filter(Boolean).join(" ").toLowerCase().includes(key),
    );
  }, [books, query]);

  function toggle(bookId: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(bookId)) next.delete(bookId);
      else next.add(bookId);
      return next;
    });
  }

  const chosen = (books || []).filter((book) => picked.has(book.bookId));

  /** 勾中的每本各建一张卡：一本书就是一个对象，攒成一张卡反而没法分别连线 */
  async function createCards() {
    const state = useBoardStore.getState();
    if (!state.boardId || !chosen.length) return;
    setBusy(true);
    try {
      for (let index = 0; index < chosen.length; index += 1) {
        const book = chosen[index];
        const { cover: _cover, ...field } = book;
        await state.createCard({
          type: "book",
          title: book.name.slice(0, 60),
          color: "rose",
          // 横排铺开，别叠在一起（列距跟「一键整理」的默认值一致）
          x: 120 + (index % 4) * 400,
          y: 120 + Math.floor(index / 4) * 300,
          book: { ...field, fetchedAt: Date.now() },
        });
      }
      state.showToast(tr("panels.book.created", { count: chosen.length }));
      setPicked(new Set());
      state.setDrawer(null);
    } catch (err) {
      state.showToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`drawer books${open ? " open" : ""}`}>
      <div className="drawer-head">
        <h2>{t("panels.book.title")}</h2>
        {books ? <span className="count">{t("panels.book.count", { count: books.length })}</span> : null}
        <span className="foot-spacer" />
        <button className="drawer-close" title={t("common.close")} onClick={() => useBoardStore.getState().setDrawer(null)}>
          <UI.close {...ICON_MD} />
        </button>
      </div>
      <div className="drawer-body">
        <div className="config-hint">{t("panels.book.note")}</div>

        <div className="ad-search">
          <input
            ref={inputRef}
            type="text"
            placeholder={t("panels.book.search.placeholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button className="mini-btn" onClick={() => setQuery("")}>
              {t("panels.book.clear")}
            </button>
          ) : null}
        </div>

        {error ? <div className="ad-warn">{error}</div> : null}
        {!books && !error ? <div className="config-hint">{t("panels.book.loading")}</div> : null}

        {books?.length ? (
          <>
            <div className="ad-count">
              {query ? t("panels.book.filtered", { query, count: hits.length }) : t("panels.book.total", { count: books.length })} ·{" "}
              {t("panels.picked", { count: picked.size })}
            </div>
            <div className="bk-list">
              {hits.map((book) => {
                const on = picked.has(book.bookId);
                return (
                  <div key={book.bookId} className={`bk-item${on ? " on" : ""}`} onClick={() => toggle(book.bookId)}>
                    <BookCover bookId={book.bookId} name={book.name} className="bk-cover" size={13} />
                    <div className="bk-main">
                      <div className="bk-head">
                        <span className={`ad-check${on ? " on" : ""}`}>
                          {on ? <UI.check size={11} strokeWidth={2.6} /> : null}
                        </span>
                        <span className="bk-name">{book.name}</span>
                      </div>
                      {book.subtitle ? <div className="bk-sub">{book.subtitle}</div> : null}
                      <div className="bk-meta">
                        {book.author ? <span className="meta-chip">{book.author}</span> : null}
                        {book.updated ? <span className="meta-chip mono">{book.updated}</span> : null}
                        {book.files?.pdf ? <span className="meta-chip">PDF</span> : null}
                      </div>
                      {book.desc ? <div className="bk-desc">{book.desc}</div> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : books && !error ? (
          <div className="config-hint">{t("panels.book.emptyLibrary")}</div>
        ) : null}
      </div>
      {chosen.length ? (
        <div className="ad-foot">
          <button className="mini-btn primary" disabled={busy || !boardId} onClick={() => void createCards()}>
            <BookIcon {...ICON_SM} /> {t("panels.book.create", { count: chosen.length })}
          </button>
          <button className="mini-btn" disabled={busy} onClick={() => setPicked(new Set())}>
            {t("panels.book.clearSelection")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

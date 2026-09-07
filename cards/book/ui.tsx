"use client";

/** 图书卡的前端槽位（入口双闸：包启用 且 阶段 A 的 library feature 配置了）。 */
import { ICON_SM, UI } from "@/lib/icons";
import { useFeatures } from "@/lib/features-client";
import { bookMdUrl, bookPdfUrl, bookReadUrl } from "@/lib/book-link";
import { BookCover } from "@/components/cards/BookCover";
import { ClampedText } from "@/components/cards/CardText";
import { useBoardStore } from "@/lib/store";
import { useT } from "@/lib/i18n/client";
import type { CardPackUi, EditorFieldsProps } from "@/lib/card-pack-client";

function Fields({ card }: EditorFieldsProps) {
  const t = useT();
  const features = useFeatures();
  return (
    <>
      <span className="hint">
        {t("cards.book.hintBefore", { name: card.book?.name || "—" })}<code>{card.book?.bookId || "—"}</code>{t("cards.book.hintAfter")}
      </span>
      {features.library ? (
        <button type="button" className="mini-btn" onClick={() => useBoardStore.getState().setDrawer("books")}>
          <UI.library {...ICON_SM} /> {t("cards.book.pickAnother")}
        </button>
      ) : null}
      {bookReadUrl(card.book) ? (
        <a className="link-btn" href={bookReadUrl(card.book)} target="_blank" rel="noopener noreferrer">
          {t("cards.book.openInLibrary")}
        </a>
      ) : null}
    </>
  );
}

export const ui: CardPackUi = {
  CardFace({ card }) {
    const t = useT();
    const book = card.book;
    if (!book?.bookId) return <span className="placeholder">{t("cards.book.empty")}</span>;
    const read = bookReadUrl(book);
    const pdf = bookPdfUrl(book);
    const md = bookMdUrl(book);
    return (
      <div className="book-card">
        {/* 封面是这张卡的主体：一屏十几本书时，认出是哪本靠的是图不是标题 */}
        <a
          className="book-cover nodrag"
          href={read || pdf || "#"}
          target={read || pdf ? "_blank" : undefined}
          rel="noopener noreferrer"
          title={read || pdf ? t("cards.book.openTitle", { name: book.name }) : t("cards.book.noFiles")}
          onClick={(event) => {
            if (!read && !pdf) event.preventDefault();
          }}
        >
          <BookCover bookId={book.bookId} name={book.name} />
        </a>
        <div className="book-main">
          <div className="book-name">{book.name}</div>
          {book.subtitle ? <div className="book-sub">{book.subtitle}</div> : null}
          {book.author ? <div className="book-author">{book.author}</div> : null}
          {book.desc ? <ClampedText text={book.desc} className="book-desc" /> : null}
          <div className="book-foot nodrag">
            {read ? (
              <a className="card-action" href={read} target="_blank" rel="noopener noreferrer">
                <UI.open {...ICON_SM} />
                {t("cards.book.readOnline")}
              </a>
            ) : null}
            {pdf ? (
              <a className="book-link" href={pdf} target="_blank" rel="noopener noreferrer" title={t("cards.book.openPdf")}>
                PDF
              </a>
            ) : null}
            {md ? (
              <a className="book-link" href={md} target="_blank" rel="noopener noreferrer" title={t("cards.book.openMarkdown")}>
                MD
              </a>
            ) : null}
          </div>
        </div>
      </div>
    );
  },
  FullView({ card }) {
    const t = useT();
    const book = card.book;
    if (!book?.bookId) return <span className="placeholder">{t("cards.book.readerEmpty")}</span>;
    const links: [string, string][] = [
      [bookReadUrl(book), t("cards.book.linkRead")],
      [bookPdfUrl(book), "PDF"],
      [bookMdUrl(book), t("cards.book.linkMarkdown")],
    ];
    return (
      <div className="reader-book">
        <BookCover bookId={book.bookId} name={book.name} className="reader-book-cover" size={34} />
        <div className="reader-text">
          <h3>{book.name}</h3>
          {book.subtitle ? <p className="reader-book-sub">{book.subtitle}</p> : null}
          <div className="reader-book-meta">
            {book.author ? <span className="meta-chip">{book.author}</span> : null}
            {book.model ? <span className="meta-chip">{book.model}</span> : null}
            {book.created ? <span className="meta-chip mono">{book.created}</span> : null}
            <span className="meta-chip mono" title={t("cards.book.idTitle")}>
              {book.bookId}
            </span>
          </div>
          {book.desc ? <p className="reader-para">{book.desc}</p> : null}
          <div className="reader-book-links">
            {links
              .filter(([url]) => url)
              .map(([url, label]) => (
                <a key={label} className="mini-btn" href={url} target="_blank" rel="noopener noreferrer">
                  <UI.open {...ICON_SM} /> {label}
                </a>
              ))}
          </div>
        </div>
      </div>
    );
  },
  editor: {
    draftFrom() {
      return {};
    },
    buildPatch() {
      return {};
    },
    Fields,
  },
  toolbar: {
    title: "图书卡：从本机书库挑一本，卡面直接显示封面",
    feature: "library",
    group: 4,
    order: 20,
    onClick: () => useBoardStore.getState().setDrawer("books"),
  },
};

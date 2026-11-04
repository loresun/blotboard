"use client";

/**
 * 图书封面。
 *
 * 书库里偶尔有书还没生成封面（gen_covers.py 是整批跑的，新书要等下一次），
 * 这时候不能把浏览器那个裂图图标留在卡面上——降级成一块带书名的占位，
 * 一眼看出「是这本书，只是还没有封面」，而不是「这张卡坏了」。
 */
import { useEffect, useState } from "react";
import { bookCoverUrl } from "@/lib/book-link";
import { useCardImage } from "@/lib/card-image-client";
import { TYPE_ICON } from "@/lib/icons";
import { useT } from "@/lib/i18n/client";

const BookIcon = TYPE_ICON.book;

export function BookCover({
  bookId,
  name,
  className,
  size = 16,
}: {
  bookId: string;
  name: string;
  className?: string;
  /** 占位图里那个图标的大小，跟着使用场景走（卡面小、阅读模式大） */
  size?: number;
}) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [bookId]);
  // 封面也走卡面图片的闸门（屏幕外不拉 / 限流 / 切板取消），见 lib/card-image-client.ts
  const imgRef = useCardImage(bookId && !failed ? bookCoverUrl(bookId) : "");

  if (!bookId || failed) {
    return (
      <span className={`book-cover-holder${className ? ` ${className}` : ""}`} title={t("cards.book.noCover", { name })}>
        <BookIcon size={size} strokeWidth={1.6} />
        <em>{name}</em>
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imgRef}
      className={className}
      alt={name}
      draggable={false}
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

"use client";

/**
 * Markdown 正文的两种壳。
 *
 * - `Markdown`：完整摊开（阅读模式 / 抽屉里用），有多长给多长。
 * - `MarkdownPreview`：卡面用。卡片高度是固定的，排过版的正文没法再用 line-clamp
 *   数行数截断（那只对纯行内内容管用），所以改成「超出就底部渐隐」——
 *   一眼能看出下面还有，想读全文点卡头的放大按钮进阅读模式。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "@/lib/markdown";

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`md${className ? ` ${className}` : ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function MarkdownPreview({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const ref = useRef<HTMLDivElement | null>(null);
  const [clipped, setClipped] = useState(false);

  // 渐隐只在真的装不下时才加：短正文底下压一层灰会让人以为内容被截了
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setClipped(el.scrollHeight - el.clientHeight > 2);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [html]);

  return (
    <div className={`card-md-wrap${clipped ? " clipped" : ""}${className ? ` ${className}` : ""}`}>
      <div ref={ref} className="md card-md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

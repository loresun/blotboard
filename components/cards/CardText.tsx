"use client";

/**
 * 卡面正文的两个基础渲染件（自 CardBody.tsx 拆出，多个卡片包共用）。
 */
import { useEffect, useRef } from "react";
import { Markdown, MarkdownPreview } from "./Markdown";
import { looksLikeMarkdown } from "@/lib/markdown";

/**
 * 正文截断：行数按**容器实际高度**现算，不写死。
 * 用户把卡片拉高就多显示几行，底下不再留白；真放不下才收成 …。
 * -webkit-line-clamp 只吃固定行数，所以只能量完再写；卡片 resize 由 ResizeObserver 触发重算。
 */
export function ClampedText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
      // +2 容忍亚像素误差，免得最后一整行被挤掉
      const lines = Math.max(1, Math.floor((el.clientHeight + 2) / lineHeight));
      const next = String(lines);
      if (el.style.getPropertyValue("-webkit-line-clamp") !== next) {
        el.style.setProperty("-webkit-line-clamp", next);
      }
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div ref={ref} className={`card-text clamped${className ? ` ${className}` : ""}`}>
      {text}
    </div>
  );
}

/**
 * 卡面正文：写了 Markdown 就按 Markdown 排版，纯文本仍走按高度算行数的截断。
 * 两条路的取舍见 lib/markdown.ts 的 looksLikeMarkdown。
 */
export function BodyText({ text, className }: { text: string; className?: string }) {
  return looksLikeMarkdown(text) ? (
    <MarkdownPreview text={text} className={className} />
  ) : (
    <ClampedText text={text} className={className} />
  );
}

/**
 * 阅读模式正文：写了 Markdown 就排版（摊开一整屏正是标题 / 列表 / 表格值得排的场合），
 * 纯文本仍走 pre-wrap —— 随手记的东西里，缩进和空行本身就是格式，
 * 交给 Markdown 解析反而会把四个空格的缩进变成代码块。判断口径与卡面同一份。
 */
export function ReaderText({ body }: { body: string }) {
  return looksLikeMarkdown(body) ? (
    <Markdown text={body} className="reader-md" />
  ) : (
    <p className="reader-para">{body}</p>
  );
}

"use client";

/**
 * 代码卡的渲染（卡面 / 阅读模式共用一个高亮件）。
 *
 * **高亮库按需 import**，与 Mermaid 卡同一条纪律（见 DiagramCard 抬头）：
 * highlight.js 的核心 76 KB、每种语法 4–24 KB，没有代码卡的板一个字节都不该下。
 * 这里更进一步——**语法也是按语言分别 import**：一张 python 卡只下核心 + python，
 * 不会把 26 种语法一起拖下来（LOADERS 是一张显式的静态表，正是为了让打包器
 * 能把它们切成 26 个独立 chunk；写成模板字符串 import 会把 386 种语法全打进去）。
 *
 * 高亮失败 / 语言不认识时**不猜**：老老实实按纯文本等宽显示。
 * 猜错的高亮（把 yaml 当 python 涂色）比没有高亮更误导人。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { highlightModuleOf } from "@/cards/code/languages";
import { ICON_SM, UI } from "@/lib/icons";
import { useBoardStore } from "@/lib/store";
import { useT } from "@/lib/i18n/client";

/** 只用到 highlight.js 的这三件事，就地声明形状，不为类型再引一次包。 */
interface HljsCore {
  registerLanguage(name: string, definition: unknown): void;
  highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
  getLanguage(name: string): unknown;
}

/** 语法模块表：键是 languages.ts 里 HIGHLIGHT_ALIASES 的值域（26 个） */
const LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  javascript: () => import("highlight.js/lib/languages/javascript"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  python: () => import("highlight.js/lib/languages/python"),
  bash: () => import("highlight.js/lib/languages/bash"),
  json: () => import("highlight.js/lib/languages/json"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  sql: () => import("highlight.js/lib/languages/sql"),
  go: () => import("highlight.js/lib/languages/go"),
  rust: () => import("highlight.js/lib/languages/rust"),
  java: () => import("highlight.js/lib/languages/java"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  php: () => import("highlight.js/lib/languages/php"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  swift: () => import("highlight.js/lib/languages/swift"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  css: () => import("highlight.js/lib/languages/css"),
  scss: () => import("highlight.js/lib/languages/scss"),
  xml: () => import("highlight.js/lib/languages/xml"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  diff: () => import("highlight.js/lib/languages/diff"),
  ini: () => import("highlight.js/lib/languages/ini"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  lua: () => import("highlight.js/lib/languages/lua"),
  plaintext: () => import("highlight.js/lib/languages/plaintext"),
};

let corePromise: Promise<HljsCore> | null = null;

function loadCore(): Promise<HljsCore> {
  if (!corePromise) {
    corePromise = import("highlight.js/lib/core").then((module) => (module.default || module) as unknown as HljsCore);
  }
  return corePromise;
}

/** 已经注册进核心的语法（同一个 core 实例全局共用，注册一次就够） */
const registered = new Map<string, Promise<void>>();

async function loadLanguage(moduleName: string): Promise<HljsCore> {
  const core = await loadCore();
  if (!registered.has(moduleName)) {
    registered.set(
      moduleName,
      LOADERS[moduleName]().then((module) => {
        core.registerLanguage(moduleName, module.default);
      }),
    );
  }
  await registered.get(moduleName);
  return core;
}

/**
 * 高亮结果按「语言 + 源码」缓存。
 * 理由与 mermaid 那份一样：大板开了「只渲染可视区」，卡片划出屏幕会卸载、划回来又挂载；
 * 同一张卡还会在卡面和阅读模式各渲一次。
 */
const cache = new Map<string, string>();
const CACHE_MAX = 64;

function remember(key: string, html: string): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, html);
}

/**
 * 一段高亮好的源码。
 *
 * 首帧先出纯文本（高亮是渐进增强，绝不能因为库还没下完就白屏），
 * 库到位后原地换成高亮版。`lineNumbers` 给阅读模式用。
 */
export function CodeBlock({
  source,
  language,
  lineNumbers = false,
  className = "",
}: {
  source: string;
  language: string;
  lineNumbers?: boolean;
  className?: string;
}) {
  const moduleName = highlightModuleOf(language);
  // 分隔符写成 `\u0000` 转义而不是真埋一个 0x00 字节：埋了的话 file/grep 会把整个文件
  // 判成二进制，`grep -r` 从此悄悄跳过它（既不报错也不列出来）。运行时完全等价。
  const key = `${moduleName || ""}\u0000${source}`;
  const [html, setHtml] = useState<string>(() => cache.get(key) || "");

  useEffect(() => {
    if (!source || !moduleName) {
      setHtml("");
      return;
    }
    const hit = cache.get(key);
    if (hit !== undefined) {
      setHtml(hit);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const core = await loadLanguage(moduleName);
        // ignoreIllegals：贴进来的往往是片段（半个函数、缺个括号），
        // 语法不完整时也要出色，而不是整段退回纯文本
        const out = core.highlight(source, { language: moduleName, ignoreIllegals: true }).value;
        remember(key, out);
        if (!cancelled) setHtml(out);
      } catch {
        // 高亮不是内容：库下不来 / 语法炸了就安静地按纯文本显示
        remember(key, "");
        if (!cancelled) setHtml("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, source, moduleName]);

  const lines = useMemo(() => (lineNumbers ? source.split("\n").length : 0), [lineNumbers, source]);

  return (
    <div className={`code-block${lineNumbers ? " numbered" : ""}${className ? ` ${className}` : ""}`}>
      {lineNumbers ? (
        <pre className="code-gutter" aria-hidden="true">
          {Array.from({ length: lines }, (_, index) => index + 1).join("\n")}
        </pre>
      ) : null}
      <pre className="code-pre">
        {html ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{source}</code>}
      </pre>
    </div>
  );
}

/** 复制按钮：成功给一句提示，失败（无 HTTPS / 无权限）也要说清楚，不能默默不动。 */
export function CopyCodeButton({ source }: { source: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <button
      type="button"
      className="ac-icon-btn nodrag"
      data-act="copy-code"
      title={t("cards.code.copyAll")}
      onClick={async (event) => {
        event.stopPropagation();
        try {
          if (!navigator.clipboard) throw new Error(t("cards.code.noClipboard"));
          await navigator.clipboard.writeText(source);
          setDone(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setDone(false), 1400);
        } catch (err) {
          useBoardStore.getState().showToast(t("cards.code.copyFailed", { error: (err as Error).message }));
        }
      }}
    >
      {done ? <UI.check {...ICON_SM} /> : <UI.copy {...ICON_SM} />}
    </button>
  );
}

/**
 * 卡面：源码区 + 页脚（语言 / 文件名 / 「编辑文本」/ 复制）。
 *
 * 装不下就渐隐——`.code-scroll` 溢出时才加 `clipped`（由 ResizeObserver 现算），
 * 与正文卡「按容器高度现算行数」是同一套心智：卡片拉高就多显示几行，
 * 真放不下才在底部化开一道白，暗示「下面还有」。
 */
export function CodeCardFace({
  source,
  language,
  filename,
  action,
}: {
  source: string;
  language: string;
  filename?: string;
  /** 页脚上多挂一个动作（卡片包放「编辑文本」用，见 components/cards/SourceFace.tsx） */
  action?: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => setClipped(el.scrollHeight - el.clientHeight > 4);
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, [source, language]);

  if (!source) return <span className="placeholder">{t("cards.code.empty")}</span>;

  return (
    <div className="card-stack code-card">
      <div ref={ref} className={`grow code-scroll nowheel${clipped ? " clipped" : ""}`}>
        <CodeBlock source={source} language={language} />
      </div>
      <div className="code-foot nodrag">
        <span className="meta-chip mono" title={language ? t("cards.code.languageTitle", { language }) : t("cards.code.noLanguageTitle")}>
          {language || t("cards.code.plaintext")}
        </span>
        {filename ? (
          <span className="code-file mono" title={filename}>
            {filename}
          </span>
        ) : null}
        <span className="foot-spacer" />
        {action}
        <CopyCodeButton source={source} />
      </div>
    </div>
  );
}

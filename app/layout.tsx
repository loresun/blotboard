import type { Viewport } from "next";
import { cookies, headers } from "next/headers";
import { AIDOCS_URL, BOOK_LIBRARY_URL, GOAL_AGENT_WEB_URL, PUBLIC_URL } from "@/lib/config";
import { ENABLED_FEATURES, TASK_BACKEND } from "@/lib/features";
import { LOCALE_COOKIE, LOCALE_HTML_LANG, parseLocale, preferredLocale } from "@/lib/i18n";
import { LocaleProvider } from "@/lib/i18n/client";
import { localeMetadata } from "@/lib/i18n/metadata";
import "./globals.css";

export async function generateMetadata() {
  return localeMetadata("meta.board.title", "meta.board.desc");
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

/**
 * 运行时地址与功能开关通过 body data-* 下发（agent 指令模板、任务详情跳转、
 * 入口显隐都吃这一份），前端不写死端口；换端口 / 换机器 / 开关集成只改环境变量。
 *
 * `data-features` 是 lib/features.ts 的镜像：没开的功能连对应 origin 都不下发
 * （React 对 undefined 属性是整个不渲染），前端读到什么就是什么，不用二次判断。
 *
 * 语言走的是另一条路：它是**每个浏览器各选各的用户偏好**，不是这台部署的配置。
 * 服务端读 cookie 决定，一次写三处——`<html lang>`（给读屏与浏览器翻译）、
 * `<body data-locale>`（给事件回调里那些没有 hook 的代码）、LocaleProvider 的初值
 * （给组件树）。三处同源，所以水合后不会先闪一下另一种语言。
 * 还没选过的（cookie 为空）按浏览器的 Accept-Language 猜一次，之后一律听用户的。
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  const saved = store.get(LOCALE_COOKIE)?.value;
  const locale = saved ? parseLocale(saved) : preferredLocale((await headers()).get("accept-language"));
  return (
    <html lang={LOCALE_HTML_LANG[locale]}>
      <body
        data-board-base={PUBLIC_URL}
        data-features={ENABLED_FEATURES.join(",")}
        data-task-backend={TASK_BACKEND}
        data-locale={locale}
        data-goal-agent-web={GOAL_AGENT_WEB_URL || undefined}
        data-aidocs-base={AIDOCS_URL || undefined}
        data-book-library={BOOK_LIBRARY_URL || undefined}
      >
        <LocaleProvider initial={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}

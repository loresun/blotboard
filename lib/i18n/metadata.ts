/**
 * 页面 metadata 的语言：跟 `<html lang>` 同一份 cookie，所以浏览器标签页上的标题
 * 与页面正文永远是同一种语言（以前标题写死中文，英文界面下只有标签页还是中文）。
 *
 * 放在单独文件而不是各页各写一遍：`cookies()` 只能在服务端调用，
 * 每个 page.tsx 抄一遍 parseLocale 迟早有人漏掉。
 */
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, parseLocale, t, type DictKey } from "./index";

export async function localeMetadata(titleKey: DictKey, descKey: DictKey): Promise<Metadata> {
  const locale = parseLocale((await cookies()).get(LOCALE_COOKIE)?.value);
  return { title: t(locale, titleKey), description: t(locale, descKey) };
}

"use client";

/**
 * 跨服务链接的 host 跟着「用户是怎么进来的」走。
 *
 * 画板与它的兄弟服务（知识库 / 书库 / Goal Agent）常常同机部署，
 * 服务端配的却是 127.0.0.1——从 Tailscale（100.x）或局域网打开画板时，
 * 点出去的链接就成了打不开的回环地址。
 *
 * 规则：只有「配置指向本机回环」且「用户不是从本机回环进来的」时才换 host，
 * 端口与协议保持配置里的（兄弟服务不一定跟画板同协议）。
 * 配置本身指向别的机器时一律不动——那是有意为之的跨机部署。
 */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

export function sameHostAs(configured: string): string {
  if (typeof window === "undefined") return configured;
  try {
    const url = new URL(configured);
    if (!LOOPBACK.has(url.hostname)) return configured;
    const here = window.location.hostname;
    if (!here || LOOPBACK.has(here)) return configured;
    url.hostname = here;
    return url.origin;
  } catch {
    return configured;
  }
}

/** 画板自己的地址：用户此刻就在这个 origin 上，直接用它最准 */
export function boardOrigin(): string {
  if (typeof window !== "undefined") return window.location.origin;
  return "http://127.0.0.1:8567";
}

/**
 * 知识库。地址只认 body dataset（服务端按 env 下发，见 app/layout.tsx）：
 * 未配置时 dataset 里根本没有这个键，这里返回空串——调用方以空串为「功能没开」，
 * 前端不再自带默认端口（那是「没配也假装有」的旧行为）。
 */
export function aidocsOrigin(): string {
  const configured = (typeof document !== "undefined" && document.body.dataset.aidocsBase) || "";
  return configured ? sameHostAs(configured) : "";
}

/** Goal Agent 主界面。同上：dataset 没有就是没配置，返回空串。 */
export function goalAgentOrigin(): string {
  const configured = (typeof document !== "undefined" && document.body.dataset.goalAgentWeb) || "";
  return configured ? sameHostAs(configured) : "";
}

/** 卡片深链：复制给别人、发给自己手机，都该是能打开的那个 host */
export function cardDeepLink(boardId: string, cardId?: string): string {
  return `${boardOrigin()}/?board=${boardId}${cardId ? `&card=${cardId}` : ""}`;
}

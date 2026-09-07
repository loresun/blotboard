"use client";

/**
 * 资料条目的落点：**先去知识库的阅读页**，不是原始平台。
 *
 * 资料卡是知识库的入口，不是外链收藏夹——点开要看的是库里那份（有转写、有分析、有向量），
 * 原文链接只当次要出口留着。
 */
import { aidocsOrigin } from "./origins";
import type { RefItem } from "./types";

/** resource_id 形如 doc:{platform}:{docId}，末段就是知识库里的主键 */
function docIdOf(item: RefItem): { docId: string; platform: string } {
  if (item.docId) return { docId: item.docId, platform: item.platform || "" };
  // 早期存下的条目没有 docId 字段，从 resourceId 反解出来——否则会退回原始平台链接
  const parts = String(item.resourceId || "").split(":");
  const tail = parts[parts.length - 1] || "";
  return /^\d+$/.test(tail)
    ? { docId: tail, platform: item.platform || parts[1] || "" }
    : { docId: "", platform: item.platform || "" };
}

/** 知识库阅读页；解不出 docId（不是 doc:* 资源）、或知识库根本没配置时才退回原文链接 */
export function refPrimaryUrl(item: RefItem): string {
  const { docId, platform } = docIdOf(item);
  const origin = aidocsOrigin();
  if (docId && origin) {
    return `${origin}/document/${encodeURIComponent(docId)}${platform ? `?platform=${encodeURIComponent(platform)}` : ""}`;
  }
  return item.url || "";
}

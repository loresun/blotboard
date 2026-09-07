import { assertCanWrite } from "@/lib/auth";
import { badRequest, ok, readJson, route } from "@/lib/http";
import { listCardPacks, setPackEnabled, setPacksEnabled } from "@/lib/card-pack-store";

export const dynamic = "force-dynamic";

/** 卡片包清单（20 个原生包 + 开关状态）。免鉴权只读：卡片中心与工具条都靠它。 */
export const GET = route(async () => {
  return ok({ packs: listCardPacks() });
});

/**
 * 开 / 关卡片包。停用只挡新建：画板上已有的这类卡片照常渲染 / 编辑 / 导出。
 *
 * 两种 body，一次请求都能用：
 *  · 单个：`{ type: "svg", enabled: false }`（老形态，界面上的开关走它）
 *  · 批量：`{ enabled: { svg: false, html: true } }`——装机 / 换形态时要改的从来不是一个包，
 *    整批先校验再一次落盘，不会留下改了一半的开关表。
 */
export const PATCH = route(async (request: Request) => {
  assertCanWrite(request);
  const body = await readJson(request);
  // 批量形态：enabled 是对象（单个形态里它是布尔，两者天然分得开）
  if (body.enabled && typeof body.enabled === "object" && !Array.isArray(body.enabled)) {
    if (body.type !== undefined) {
      throw badRequest("批量形态别再带 type：要么 `{type, enabled: bool}`，要么 `{enabled: {type: bool, …}}`");
    }
    return ok({ packs: setPacksEnabled(body.enabled as Record<string, unknown>) });
  }
  if (typeof body.type !== "string" || !body.type) {
    throw badRequest("type 必须是卡片类型字符串（批量请传 `{enabled: {type: bool, …}}`）");
  }
  if (typeof body.enabled !== "boolean") throw badRequest("enabled 必须是布尔");
  return ok({ packs: setPackEnabled(body.type, body.enabled) });
});

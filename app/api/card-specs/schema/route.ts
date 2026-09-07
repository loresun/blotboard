import { route } from "@/lib/http";
import { PUBLIC_URL } from "@/lib/config";
import { cardMetaOf } from "@/lib/card-metas";
import { ENVELOPE_NATIVE_TYPES } from "@/lib/card-ingest";
import { enabledSpecs } from "@/lib/card-spec-store";
import { envelopeSchemaDocument, specPromptBlock } from "@/lib/card-spec-schema";

export const dynamic = "force-dynamic";

/**
 * 整个信封的 JSON Schema：涵盖当前**启用**的全部规格 + 原生卡片。
 * 这就是「注入 schema」的那份东西——外部系统 / agent 拿它就能构造出能被收下的卡片。
 * `?format=prompt` 给一份 Markdown 版（全部启用规格的字段表）。
 */
export const GET = route(async (request: Request) => {
  const specs = enabledSpecs();
  const format = new URL(request.url).searchParams.get("format");
  if (format === "prompt") {
    const body = [
      "# blotboard 卡片规格（当前启用）",
      "",
      `往画板送卡片：POST ${PUBLIC_URL}/api/boards/{boardId}/ingest，body 是下面这个信封：`,
      "",
      "```json",
      JSON.stringify(
        { format: "blotboard.cards", version: 1, mode: "strict", cards: [{ spec: "<规格 id>", fields: {} }], edges: [] },
        null,
        2,
      ),
      "```",
      "",
      "只校验不落库：把同样的 body POST 到 /api/card-specs/validate。",
      "",
      "`cards[]` 里也能直接放**原生卡片**（不需要规格）：`{\"type\":\"…\", \"title\":…, \"content\":…}` 加上",
      "该类型的专属字段。信封只收自包含的类型，专属字段的键按类型对号入座：",
      "",
      ...ENVELOPE_NATIVE_TYPES.map((type) => {
        const key = cardMetaOf(type)?.fieldKey;
        return `- \`${type}\`${key ? ` → \`${key}\`（跟单张建卡的字段形状完全一样）` : "（只有 title / content）"}`;
      }),
      "",
      "**image / pdf / board 不能走信封**：`file.uploadId` / `boardRef.boardId` 是本机主键，换台机器指不到东西。",
      "先在目标机器拿到 id（`POST /api/uploads` / `POST /api/boards`），再 `POST /api/boards/{boardId}/cards` 单张建卡。",
      "",
      "报错分三类：**缺必填字段**（去补值）· **字段值不合规**（照文案里的期望改那个值）· **未知字段**（已丢弃）。",
      "",
      ...specs.map((spec) => specPromptBlock(spec)),
    ].join("\n");
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(JSON.stringify(envelopeSchemaDocument(specs, PUBLIC_URL), null, 2), {
    status: 200,
    headers: { "content-type": "application/schema+json; charset=utf-8", "cache-control": "no-store" },
  });
});

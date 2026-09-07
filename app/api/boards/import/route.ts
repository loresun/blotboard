import { actorOf, assertCanWrite } from "@/lib/auth";
import { MAX_IMPORT_BODY_BYTES, badRequest, ok, readText, route } from "@/lib/http";
import { BundleFormatError, parseBoardBundleText } from "@/lib/board-bundle";
import { importBoardBundle, type ImportConflict, type ImportMode } from "@/lib/board-transfer";

export const dynamic = "force-dynamic";

/**
 * 导入画板：**收一份导出文件，立起若干块新板**。
 *
 * 收三种形状，body 直接放文件内容就行（`content-type` 不影响判断，看内容）：
 *  · 画板包 JSON（`GET /api/boards/export` 或本机「备份整库」的产物）；
 *  · 单块板 JSON（`?format=json` 的产物，也就是画板配置里那份）；
 *  · **导出的 HTML**——产物末尾带着同一份画板包，图片从正文里的 data URI 取回。
 * 也可以包一层：`{"bundle": {...}, "mode": "restore"}`。
 *
 * 参数（query 或 body 都认）：
 *  · `mode=copy`（默认）一律当新板导入，卡片 / 连线换新 id，任务卡不继承来源机器的
 *    Issue 与任务 id；`mode=restore` 尽量保住原 id，用来恢复自己的备份。
 *  · `onConflict=skip`（默认）/ `replace`（覆盖同 id 的板，覆盖前自动打快照）/ `copy`（另存一块）。
 *  · `group=项目名` 把这批板统一归到某个分组。
 *
 * **认错的参数当场 400，一个字都不写**：`mode=restroe` 这种拼错以前会静默退回默认的 copy，
 * 于是「恢复备份」变成「又复制了一份」，而调用方（尤其是 agent）从 201 里看不出意图被改过。
 * 缺省仍然是缺省——不传就是 copy / skip，只有**显式给了但不认识**的值才拒。
 *
 * **只新建、不改已有的板**（除非显式 `onConflict=replace`）：导入是「拿进来」，
 * 不该顺手动别人正在用的板。
 */
const IMPORT_MODES = ["copy", "restore"] as const;
const IMPORT_CONFLICTS = ["skip", "replace", "copy"] as const;

/**
 * 显式给了就必须认识。写在**动手之前**：这条路后面会建板 / 覆盖板，
 * 校验掉到写入之后就变成「拒绝了，但已经写进去几块了」。
 */
function pickOption<T extends string>(name: string, value: string | null | undefined, allowed: readonly T[], fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw badRequest(`${name} 只能是 ${allowed.join(" / ")}，收到的是「${String(value).slice(0, 40)}」`);
}

export const POST = route(async (request: Request) => {
  assertCanWrite(request);
  const raw = await readText(request, MAX_IMPORT_BODY_BYTES);
  if (!raw.trim()) throw badRequest("请求体是空的：把导出的 .json / .html 文件内容放在 body 里");

  const params = new URL(request.url).searchParams;
  let payload: string = raw;
  let mode = params.get("mode");
  let onConflict = params.get("onConflict");
  let group = params.get("group");

  // 包了一层的写法：{ bundle | html | text, mode, onConflict, group }
  if (raw.trimStart().startsWith("{")) {
    try {
      const body = JSON.parse(raw) as Record<string, any>;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const inner = body.bundle ?? body.html ?? body.text ?? body.board;
        // 只有**看着像内容**的才当外层包装：卡片信封里也有个 board 字段（`{id,name}`），
        // 不这么挑就会把信封的那两个字段当成要导的板，报出一句驴唇不对马嘴的错
        const usable =
          typeof inner === "string" ||
          (Boolean(inner) &&
            typeof inner === "object" &&
            (Array.isArray((inner as Record<string, unknown>).boards) ||
              Array.isArray((inner as Record<string, unknown>).cards)));
        if (usable) {
          payload = typeof inner === "string" ? inner : JSON.stringify(inner);
          mode = mode ?? (typeof body.mode === "string" ? body.mode : null);
          onConflict = onConflict ?? (typeof body.onConflict === "string" ? body.onConflict : null);
          group = group ?? (typeof body.group === "string" ? body.group : null);
        }
      }
    } catch {
      /* 不是 JSON 就当文本走下面的解析，那边报的错更具体 */
    }
  }

  let parsed;
  try {
    parsed = parseBoardBundleText(payload);
  } catch (err) {
    throw err instanceof BundleFormatError ? badRequest(err.message) : err;
  }

  const result = importBoardBundle(parsed.bundle, {
    mode: pickOption<ImportMode>("mode", mode, IMPORT_MODES, "copy"),
    onConflict: pickOption<ImportConflict>("onConflict", onConflict, IMPORT_CONFLICTS, "skip"),
    ...(group !== null && group !== undefined ? { group } : {}),
    actor: actorOf(request),
    htmlAssets: parsed.htmlAssets,
  });
  return ok({ ...result }, 201);
});

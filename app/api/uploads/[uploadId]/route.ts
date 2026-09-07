import fs from "node:fs";
import { assertCanWrite } from "@/lib/auth";
import { ApiError, ok, route } from "@/lib/http";
import { isClaimed, resolveUploadFile } from "@/lib/uploads";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ uploadId: string }> };

/** 删除尚未被卡片引用的暂存上传；已 claimed 的拒绝（409）。 */
export const DELETE = route(async (request: Request, ctx: Ctx) => {
  assertCanWrite(request);
  const { uploadId } = await ctx.params;
  const id = decodeURIComponent(uploadId);
  const file = resolveUploadFile(id);
  if (isClaimed(id)) throw new ApiError("附件已被画板卡片引用，不能删除", 409);
  try {
    fs.unlinkSync(file);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  return ok({});
});

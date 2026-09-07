/**
 * 图片卡的服务端归一化（自 lib/board-schema.ts 机械拆入）。
 * normalizeFileField 是 image / media / pdf 共用的（同一个 file 字段），定义在这里，另两个包引用。
 */
import fs from "node:fs";
import path from "node:path";
import type { FileField, UploadKind } from "@/lib/types";
import { UPLOAD_ID_RE, cleanText } from "@/lib/normalize-base";
import { badRequest } from "@/lib/http";
import { uploadFormatOfId } from "@/lib/upload-accept";
import type { CardPackSchema } from "@/lib/card-pack-types";

export function normalizeFileField(
  file: Partial<FileField> = {},
  { uploadsDir, required = false }: { uploadsDir?: string; required?: boolean } = {},
): FileField {
  const uploadId = cleanText(file.uploadId, 200);
  if (!uploadId) {
    if (required) throw badRequest("image/media/pdf 卡片必须提供 file.uploadId（先 POST /api/uploads）");
    return {};
  }
  if (!UPLOAD_ID_RE.test(uploadId)) throw badRequest("file.uploadId 格式无效");
  // 磁盘上的真实大小：调用方不传 size 是常态（agent 照 skill.md 建卡就只给 uploadId），
  // 而卡面要显示「12.3 MB」。文件就在手边，没必要指望调用方报得准
  let bytesOnDisk: number | null = null;
  if (uploadsDir) {
    const abs = path.join(uploadsDir, uploadId);
    if (!abs.startsWith(`${uploadsDir}${path.sep}`)) throw badRequest("file.uploadId 无效");
    if (!fs.existsSync(abs)) throw badRequest(`上传文件不存在：${uploadId}`);
    try {
      bytesOnDisk = fs.statSync(abs).size;
    } catch {
      /* 读不到就退回调用方报的值 */
    }
    // claimed 标记：被卡片引用后不再被孤儿 GC 回收，也不允许 DELETE
    try {
      fs.writeFileSync(`${abs}.claimed`, `${Date.now()} board\n`, { flag: "wx" });
    } catch {
      /* 已 claim 过 */
    }
  }
  // kind / mediaType 以**上传件 id 的扩展名**为准：id 是本服务生成的，后缀一定是规范扩展名，
  // 而调用方报的 kind 经常是错的（agent 建音视频卡时照着 image 卡的例子写 kind:"image"）。
  // 认不出后缀（老数据 / 手工塞进 uploads 的文件）才退回调用方给的值。
  const format = uploadFormatOfId(uploadId);
  const declaredKind: UploadKind | undefined =
    file.kind === "image" || file.kind === "audio" || file.kind === "video" || file.kind === "file" ? file.kind : undefined;
  return {
    uploadId,
    name: cleanText(file.name, 200, { fallback: uploadId }),
    kind: format?.kind || declaredKind || "file",
    mediaType: format?.mediaType || cleanText(file.mediaType, 100),
    size: bytesOnDisk ?? (Number.isFinite(Number(file.size)) ? Number(file.size) : null),
  };
}

/** 这个上传件是不是音视频（音视频卡的建卡闸门用它）。 */
export function isPlayableFile(file: FileField): boolean {
  return file.kind === "audio" || file.kind === "video";
}

/** image / pdf 两个包共用的 schema 钩子（只差 beforeConvert 报错文案里的类型名）。 */
export function fileCardSchema(type: "image" | "pdf"): CardPackSchema {
  return {
    onCreate(card, input, ctx) {
      card.file = normalizeFileField(input.file, { uploadsDir: ctx.uploadsDir, required: true });
    },
    beforeConvert(card, patch) {
      if (!(patch.file?.uploadId || card.file?.uploadId)) {
        throw badRequest(`转为 ${type} 卡片必须提供 file.uploadId`);
      }
    },
    onConvert(card, patch, ctx) {
      card.file = normalizeFileField({ ...(card.file || {}), ...(patch.file || {}) }, { uploadsDir: ctx.uploadsDir });
    },
    onPatch(card, patch, ctx) {
      if (patch.file !== undefined) {
        card.file = normalizeFileField({ ...(card.file || {}), ...patch.file }, { uploadsDir: ctx.uploadsDir });
      }
    },
  };
}

export const schema: CardPackSchema = fileCardSchema("image");

/**
 * 音视频卡的服务端归一化。
 *
 * 归一化本身与 image / pdf 同一份（normalizeFileField，三型共用 `file` 字段），
 * 这里只多一道闸门：**引用的上传件必须真的是音视频**。
 * 不拦的话，把一个 png 的 uploadId 填进音视频卡会建出一张永远转圈的空播放器——
 * 而错在建卡的那一刻就能看出来，就该在那一刻报出来（建卡严）。
 */
import { badRequest } from "@/lib/http";
import type { FileField } from "@/lib/types";
import { isPlayableFile, normalizeFileField } from "@/cards/image/schema";
import type { CardPackSchema } from "@/lib/card-pack-types";

const KIND_LABEL: Record<string, string> = { audio: "音频", video: "视频", image: "图片", file: "文件" };

/** 音视频卡只收 audio / video 的上传件；收到图片 / PDF 时**指路**到该建哪种卡。 */
function assertPlayable(file: FileField): FileField {
  if (isPlayableFile(file)) return file;
  const kind = KIND_LABEL[String(file.kind)] || "这个文件";
  const better = file.kind === "image" ? "image" : "pdf";
  throw badRequest(
    `音视频卡只收音频 / 视频上传件，${file.uploadId} 是${kind}：改建 \`{"type":"${better}","file":{"uploadId":"${file.uploadId}"}}\``,
  );
}

export const schema: CardPackSchema = {
  onCreate(card, input, ctx) {
    card.file = assertPlayable(normalizeFileField(input.file, { uploadsDir: ctx.uploadsDir, required: true }));
  },
  beforeConvert(card, patch) {
    if (!(patch.file?.uploadId || card.file?.uploadId)) {
      throw badRequest("转为 media 卡片必须提供 file.uploadId");
    }
  },
  onConvert(card, patch, ctx) {
    card.file = assertPlayable(
      normalizeFileField({ ...(card.file || {}), ...(patch.file || {}) }, { uploadsDir: ctx.uploadsDir }),
    );
  },
  onPatch(card, patch, ctx) {
    if (patch.file !== undefined) {
      card.file = assertPlayable(
        normalizeFileField({ ...(card.file || {}), ...patch.file }, { uploadsDir: ctx.uploadsDir }),
      );
    }
  },
  markdownLines(card) {
    if (!card.file?.uploadId) return [];
    // 文件名那行是公共行（board-service 统一加），这里只补「是音频还是视频、什么格式」
    return [`- 媒体：${KIND_LABEL[String(card.file.kind)] || "音视频"}（${card.file.mediaType || "未知格式"}）`];
  },
};

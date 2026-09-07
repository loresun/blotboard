import { CARD_PACK_API_VERSION, type CardMeta } from "@/lib/card-pack-types";

/**
 * 音视频卡：引用一个上传件（file.uploadId），卡面直接播——视频用 `<video>`，音频用 `<audio>`。
 *
 * 与图片 / PDF 卡同族（三种共用 `file` 字段），区别只在卡面怎么渲染：
 * 图片是一张图、PDF 是一个文件条、音视频是一个带进度条的播放器。
 * **本地文件**才走这里；嵌别人网站上的播放页（B 站 / YouTube）是网页嵌入卡（html）的事。
 *
 * defaultEnabled: true —— 与其他包不同，音视频卡**没有工具条入口**（跟图片 / PDF 一样，
 * 靠拖文件进画布 / 上传按钮建卡）。包停用时用户看不到「入口不见了」，只会在把一个
 * mp4 拖进画布时撞一句「卡片包已停用」，费解。新装机默认开着，不想要再去卡片中心关。
 */
export const meta: CardMeta = {
  apiVersion: CARD_PACK_API_VERSION,
  type: "media",
  label: "音视频",
  fallbackTitle: "音视频卡片",
  icon: "media",
  size: [400, 300],
  defaultW: 400,
  defaultH: 300,
  color: "rose",
  fieldKey: "file",
  groupOrder: 19,
  defaultEnabled: true,
  // file.name 的检索贡献在 image 包里给过一次（三型共用 file 字段），这里不重复
};

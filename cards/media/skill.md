### 音视频（media）

**本地**音频 / 视频文件，卡面上直接播（视频 `<video>`、音频 `<audio>`，都带进度条）。
嵌 B 站 / YouTube 那种**别人网站上的播放页**不走这里，用网页嵌入卡（html）。

**文件字段叫 `file.uploadId`，不是 `media.uploadId`** —— 写错会被点名 400。

**必须先上传再建卡**：`POST /api/uploads`（二进制 body + `x-file-name` 头，写鉴权）拿到 `uploadId`，
再建卡带 `file: { uploadId }`。

```bash
UPLOAD=$(curl -s -X POST "$BASE/api/uploads" -H "x-auth-key: $TOKEN" \
  -H "x-file-name: talk.mp4" -H "content-type: video/mp4" --data-binary @talk.mp4 \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["upload"]["id"])')
curl -s -X POST "$BASE/api/boards/$BOARD/cards" -H "x-auth-key: $TOKEN" -H "content-type: application/json" \
  -d "{\"type\":\"media\",\"title\":\"访谈原片\",\"file\":{\"uploadId\":\"$UPLOAD\"}}"
```

收哪些格式：音频 `mp3 / m4a / aac / wav / ogg / oga / opus / flac`、视频 `mp4 / m4v / webm / mov / ogv`。
单文件上限默认 200 MB（`BLOTBOARD_MEDIA_MAX_MB` 可改）。上传口按**文件签名**校验，
改扩展名混别的东西进来会 415；`kind` / `mediaType` 由服务端按上传件后缀推导，**不用自己填**。

传了图片 / PDF 的 uploadId 会 400 并指路改建 image / pdf 卡（反过来也一样：
音视频不要建成 image 卡，那只会得到一张裂图）。

卡面地址由服务端补（`/api/boards/uploads/{id}`，支持 Range 分段，所以拖进度条是有效的）。
**不能走信封导入**：`uploadId` 是本机上传件的主键，换台机器指不到东西——只能这样单张建卡。

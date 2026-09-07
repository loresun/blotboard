### 图片（image）

**文件字段叫 `file.uploadId`，不是 `image.uploadId`** —— 名字对不上是这类卡最常踩的坑，
写成 `image: { uploadId }` 会被点名 400（不会静默收下）。

**必须先上传再建卡**：`POST /api/uploads`（二进制 body + `x-file-name` 头，写鉴权）拿到 `uploadId`，
再建卡带 `file: { uploadId }`——直接建卡不带有效 uploadId 会 400。

```bash
UPLOAD=$(curl -s -X POST "$BASE/api/uploads" -H "x-auth-key: $TOKEN" \
  -H "x-file-name: cover.png" --data-binary @cover.png | python3 -c 'import json,sys;print(json.load(sys.stdin)["upload"]["id"])')
curl -s -X POST "$BASE/api/boards/$BOARD/cards" -H "x-auth-key: $TOKEN" -H "content-type: application/json" \
  -d "{\"type\":\"image\",\"title\":\"封面\",\"file\":{\"uploadId\":\"$UPLOAD\"}}"
```

卡面地址由服务端补（`/api/boards/uploads/{id}`），不落库、不用自己拼。
**不能走信封导入**：`uploadId` 是本机上传件的主键，换台机器指不到东西——只能这样单张建卡。

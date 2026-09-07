### PDF（pdf）

**文件字段叫 `file.uploadId`，不是 `pdf.uploadId`** —— 写成 `pdf: { uploadId }` 会被点名 400。

同 image：先 `POST /api/uploads`（二进制 body + `x-file-name` 头，写鉴权）拿 `uploadId`，
再建卡带 `file: { uploadId }`。卡面显示文件名与大小，点开在浏览器里读。

**不能走信封导入**（`uploadId` 是本机上传件的主键）：先上传，再 `POST /api/boards/{id}/cards` 单张建卡。

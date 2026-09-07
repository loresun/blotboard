### 规格卡（data）

按一份「卡片规格」填好的结构化信息——外部卡片进画板的正规入口。`data.{specId,specVersion,fields,source}`。

- **先查字段表再填**：`GET /api/card-specs/{specId}`（人话版说明就在响应里）。规格外的 key 会被丢掉，别猜字段名
- **PATCH 是合并**（与待办/导图相反）：只传要改的字段；清掉某字段显式传 `null`
- `source.externalId` 是判重主键（同规格 + 同 externalId = 同一张卡），同步外部数据能带就带
- 标题可省：规格的 `display.title` 指了哪个字段，就自动用它当卡片标题
- 要存的是「一条条同构的记录」而没有合适规格时，可以现场造一份规格（`POST /api/card-specs`），别拿 text 卡硬凑

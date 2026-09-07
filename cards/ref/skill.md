### 资料组（ref）

一次知识库检索选中的若干条，攒成一张参考素材卡。`ref.{source:"aidocs",query,mode,items[],fetchedAt}`，
item 是 `{resourceId,title,url,platform,docId,snippet,score}`。

- 检索走 `POST /api/aidocs/search`（免鉴权，`{query, mode: vector|hybrid, limit}`），结果可直接攒进 items
- **红线：只存 id / 标题 / 摘要 / 链接，正文永远回知识库取**——别把知识库正文复制进画板
- 依赖部署配置 `AIDOCS_URL`；已落板的资料卡是本地快照，服务关掉照常显示
- **可以走信封导入**（`type:"ref"` + `ref:{query,mode,items}`）：卡里是检索结果快照，
  对端没配知识库也只是链接点不开，卡片本身的数据一点不少

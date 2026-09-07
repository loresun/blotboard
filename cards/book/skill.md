### 图书（book）

本机书库里一本书的索引卡。`book.{bookId,name,subtitle,author,desc,files,fetchedAt}`。

- 先 `GET /api/books`（免鉴权，`?q=` 按书名/作者筛）拿 `bookId` 与 `files`，原样塞进 `book` 字段
- **红线：只存 bookId + 元信息快照**，封面与正文都回书库取；封面卡面自动走
  `/api/books/{bookId}/cover` 同源代理，**别把封面 SVG 复制进画板**
- 依赖部署配置 `BOOK_LIBRARY_URL`；已落板的图书卡是快照，书库关掉照常显示
- **可以走信封导入**（`type:"book"` + `book:{bookId,name,…}`）：卡里是元信息快照，
  对端没配书库也只是封面与正文链接点不开，卡片本身的数据一点不少

# 可选集成协议：知识库 · 书库

画板本体零外部依赖。**资料卡**（从知识库检索、攒成参考素材）与**图书卡**（从书库挑书，
封面 / 在线读 / PDF）这两类卡片需要一个外部服务顶在后面——这份文档说清那个服务
**必须实现哪几个 HTTP 口、回什么形状**，好让任何人都能接上自己的。

跟任务后端一个路子：任务后端有 [RUNNER.md](RUNNER.md)，这两条有这一份。
画板这边只认协议，不认具体是谁：

| 集成 | 环境变量 | 不配的后果 | 实现层 | 唯一调用面 |
| --- | --- | --- | --- | --- |
| 知识库（资料卡） | `AIDOCS_URL` | `features.search=false`，入口不渲染，API 回 503 | `lib/aidocs.ts` | `lib/integrations/search-provider.ts` |
| 书库（图书卡） | `BOOK_LIBRARY_URL` | `features.library=false`，入口不渲染，API 回 503 | `lib/book-library.ts` | `lib/integrations/library-provider.ts` |

想换一种后端，改的是 provider 那一个文件，不是散在各处的调用点。

## 先跑起来看看

仓库自带一个**两条协议都实现了的参考实现**，用来验证自己的服务形状对不对，
也用来在没有真服务时把这两张卡片跑通：

```bash
node scripts/mock-integrations.mjs --port 8899
```

```bash
AIDOCS_URL=http://127.0.0.1:8899 BOOK_LIBRARY_URL=http://127.0.0.1:8899 npm run dev
```

起来之后画板上会多出「资料卡」的检索入口与「图书卡」的挑书入口，
数据是 mock 里那几条写死的假数据。它同时是一份**可执行的协议说明**——
下面每一条要求，那个文件里都有对应的实现。

## 通用约定

- **地址就是前缀**：画板把下面的路径直接拼在 `AIDOCS_URL` / `BOOK_LIBRARY_URL` 后面，
  所以配的值**不要带尾斜杠**（`http://127.0.0.1:8899`，不是 `…:8899/`）。
- **不带鉴权**。这两条桥假设服务与画板在同一台机器 / 同一个可信网段里
  （与画板自己的威胁模型一致，见 [SECURITY.md](../SECURITY.md)）。
  要鉴权就在中间放一层反代。
- **超时**：知识库 75 秒（向量检索可能真的慢），书库 10 秒。超时一律转成 502。
- **画板不复制你的数据**。卡片上只留 id + 一份摆得出卡面的元信息快照，
  正文永远回你的服务取——这是全仓一条红线，跟「Issue 的真源在任务后端」同一条。
  所以你的服务改了标题，已存在的卡片不会自己变（那是快照，不是缓存）。
- **多回的字段一律忽略**，缺的字段按下面的默认值兜底。加字段不会打破画板。

---

## 一、知识库（资料卡）

### `POST {AIDOCS_URL}/api/agent/vectors/search` — 向量检索

请求体：

```json
{ "query": "画板怎么做的", "top_k": 10, "platform": "bilibili" }
```

- `top_k`：1–30（画板侧已经夹好了）。
- `platform`：可选，用户在检索框里选了平台才带。

### `POST {AIDOCS_URL}/api/agent/search` — 混合检索

```json
{ "query": "画板怎么做的", "limit": 10, "platform": "bilibili" }
```

注意两条口的**参数名不同**（`top_k` / `limit`）——这是历史形状，画板照实发。

### 两条口共用的响应

```json
{
  "query_interpreted": "画板 实现",
  "total": 2,
  "results": [
    {
      "resource_id": "doc:bilibili:186864",
      "doc_id": "186864",
      "title": "从零做一块画板",
      "platform": "bilibili",
      "source_url": "https://www.bilibili.com/video/BV1xx",
      "snippet": "……命中的那段正文……",
      "score": 0.83
    }
  ]
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `results` | 是 | 命中列表。也接受 `chunks`（向量检索按切片返回时的习惯叫法），两个都没有当空结果 |
| `results[].resource_id` | 是\* | 条目主键。没有它时画板会用 `doc:{platform}:{doc_id}` 拼一个；两个都没有这条被丢掉 |
| `results[].doc_id` | 否 | 你库里的文档主键。**只有纯数字才会被采用**，用来拼阅读页地址 |
| `results[].title` | 否 | 缺省用 `resource_id` |
| `results[].platform` | 否 | 也接受 `source_type` |
| `results[].source_url` | 否 | 原文外链，**必须 http/https** 才会被采用 |
| `results[].snippet` | 否 | 也接受 `chunk_text`；截断到 1200 字 |
| `results[].score` | 否 | 相关度。同一 `resource_id` 出现多条时**只留分最高的那条** |
| `query_interpreted` | 否 | 你对检索词的改写；没有就回显原词 |
| `total` | 否 | 缺省用去重后的条数 |

响应体也可以整个包在 `{ "data": … }` 里，画板会自动解一层。

**失败怎么表达**：非 2xx，或者 `{"success": false, "message": "…"}`。
画板一律转成 502 并把 `message` 原样显示给用户。

### 阅读页地址（不是接口，是约定）

资料卡点开去的是**你库里那一份**，地址按这个模式拼：

```
{AIDOCS_URL}/document/{docId}?platform={platform}
```

解不出数字 `docId` 时才退回 `source_url`。所以：要么提供数字主键 + 这个页面，
要么干脆不给 `doc_id`、让卡片直接指向原文，两种都能用。

---

## 二、书库（图书卡）

### `GET {BOOK_LIBRARY_URL}/api/books?full=1` — 全量书目

书库假设只有几十本，所以**没有分页也没有检索**：一次拉完，画板在自己这边过滤。

```json
{
  "books": [
    {
      "id": "how-boards-work",
      "name": "画板是怎么工作的",
      "subtitle": "一本给 agent 看的说明书",
      "author": "某人",
      "desc": "……简介……",
      "files": { "html": "read.html", "pdf": "book.pdf", "md": "book.md" },
      "model": "pipeline-v3",
      "created": "2026-01-02",
      "updated": "2026-03-04"
    }
  ]
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | 是 | **只能是 `[a-z0-9_-]`，≤120 字符**（会拼进 URL；不合规的整条丢掉）。大写会被转成小写 |
| `name` | 否 | 缺省用 `id`；≤300 字 |
| `subtitle` / `author` / `desc` | 否 | ≤300 / 120 / 2000 字 |
| `files.html` / `.pdf` / `.md` | 否 | **文件名，不是路径**：带 `/` 或 `\` 的一律丢掉。有哪个就渲染哪个入口 |
| `model` / `created` / `updated` | 否 | 卡面上的元信息；列表按 `updated`（退 `created`）倒序 |

排序由画板做，你不用管。

### `GET {BOOK_LIBRARY_URL}/covers/{id}.svg` — 封面

回图片字节即可。画板**不透传你的 `content-type`**：
只认 `image/svg+xml|png|jpeg|webp|gif|avif`，其余一律按 SVG 处理，
并且给这条响应挂一层禁掉脚本的 CSP（理由见 `app/api/books/[bookId]/cover/route.ts`）。
所以封面里的 `<script>` 不会执行——**别指望封面能跑代码**。

没有这本书的封面就回 404，卡面自己降级成占位图。

封面走画板的同源代理（`/api/books/{id}/cover`），这样从 Tailscale / 局域网打开画板时
也看得见——你的书库地址如果是回环地址，在别人机器上是不存在的。

### `GET {BOOK_LIBRARY_URL}/books/{id}/{file}` — 产物文件

「在线读 / PDF / Markdown」三个按钮直接指向这里，**不经画板代理**
（整本书带一堆相对资源，代理不划算）。`{file}` 就是上面 `files` 里给的那个文件名。

这意味着：**这个地址得在用户的浏览器里打得开**。画板会把它的 host 换成
「用户此刻访问画板用的那个 host」（`lib/origins.ts` 的 `sameHostAs`）——
你在 `BOOK_LIBRARY_URL` 里配 `127.0.0.1:9000`，用户从 Tailscale 进来时
链接会自动变成 `<那台机器的 Tailscale 地址>:9000`。端口和路径不动。

---

## 自检

服务写好之后，最快的验证方式是让画板自己去探：

```bash
npm run doctor
```

报告里的「可选集成」一节会逐条打这两个服务，把状态码和返回形状问题直接写出来。
也可以只打其中一条：

```bash
curl -s -XPOST "$AIDOCS_URL/api/agent/vectors/search" -H 'content-type: application/json' -d '{"query":"test","top_k":1}'
curl -s "$BOOK_LIBRARY_URL/api/books?full=1"
```

对着上面的表看字段就行。参考实现 `scripts/mock-integrations.mjs` 是最短的正确答案。

# 卡片规格（Card Spec）· JSON 格式规范 v1

> 画板本来只有 12 种内置卡片。**外面的信息不长这样**：飞书里的一条消息、一篇公众号文章、
> 一张审批单、一个 GitHub Issue、一条用户反馈——它们各有各的字段。
> 这套体系解决的是：**怎么把这些「外部卡片」规范地存进画板，并且能互相传阅。**
>
> 一句话：**一份规格 = 一类卡片的说明书；加一种新卡片形式 = 加一个 JSON 文件**，
> 不改前端、不改后端、不用重启。装上就能用，用不上就关掉（插件 + 开关）。

---

## 0. 三个概念

| 概念 | 是什么 | 存在哪 |
| --- | --- | --- |
| **规格 Card Spec** | 一类卡片的字段定义 + 显示方式 + 示例 | `data/card-specs/*.json`（内置，git 跟踪）· `<数据目录>/my-card-specs/*.json`（自定义） |
| **规格卡 data card** | 画板上第 13 种卡片：按某份规格填好的一份数据 | 跟其他卡片一样在 `boards.json` 里 |
| **信封 Envelope** | 外部系统往画板送卡片的交换格式（一批卡片 + 连线） | 不落地，是 HTTP body |

开关状态（哪份规格被停用了）是**用户数据**，存 `<数据目录>/card-spec-state.json`，不写回规格文件。

---

## 1. 信封：往画板送卡片

```jsonc
POST /api/boards/{boardId}/ingest        // 落板（写鉴权）
POST /api/card-specs/validate            // 只校验不落库（免鉴权，先看清楚再决定）

{
  "format": "blotboard.cards",          // 固定
  "version": 1,                          // 固定
  "generator": "feishu-bot/1.2",         // 可选，谁生成的，只作记录
  "mode": "strict",                      // strict（默认）| lenient
  "onDuplicate": "update",               // update（默认）| skip | create
  "cards": [
    {
      "id": "m1",                        // 可选：信封内的本地 id，只用于 edges 引用
      "spec": "feishu-message",          // 规格 id → 这是一张规格卡
      "fields": {                        // 按规格填的字段值
        "sender": "张三",
        "text": "客户希望下周三前看到第一版大纲",
        "sentAt": "2026-08-20T10:12:00Z"
      },
      "source": {                        // 可选：外部出处
        "app": "feishu",
        "url": "https://…",
        "externalId": "om_xxx"           // ★ 判重用，见 §5
      },
      "title": "自定义标题",              // 可选，不给就按规格的 display.title 生成
      "color": "blue",                   // 可选
      "x": 0, "y": 0, "w": 340, "h": 250, // 可选，不给就自动排成网格
      "agentPrompt": "…"                 // 可选
    },
    { "id": "t1", "type": "text", "title": "我的批注", "content": "这条要跟进" }  // 原生卡片
  ],
  "edges": [
    { "from": "m1", "to": "t1", "label": "跟进", "kind": "produces" }
  ]
}
```

**规则**

- `cards[]` 里两种形态二选一：带 `spec` = 规格卡；带 `type` = 原生卡片。
- 原生卡片的白名单口径是**自包含**——一封信封换台机器照样能完整重建这张卡。
  真源是各卡片包 `meta.envelope`（`cards/<type>/meta.ts`），`ENVELOPE_NATIVE_TYPES` 从注册表派生，
  `/api/card-specs/schema` 的 type 枚举、prompt 版、报错文案全从同一处来，不会漂移。

  | | 类型 | 为什么 |
  | --- | --- | --- |
  | ✅ 收 | `text` `task` `quote` `link` `todo` `mindmap` `svg` `mermaid` | 内容全在卡里 |
  | ✅ 收 | `excalidraw` | `source` 是自带的 .excalidraw JSON 字符串，一份就是全部 |
  | ✅ 收 | `html` | 只存 url（**仍要过嵌入白名单**，不合规按原规则拒） |
  | ✅ 收 | `book` `ref` | 元信息 / 检索结果的**快照**，正文本来就在书库 / 知识库；对端没配那两个服务也只是链接点不开，数据无损 |
  | ❌ 拒 | `image` `media` `pdf` | `file.uploadId` 是**本机上传件的主键**，换台机器指不到东西 |
  | ❌ 拒 | `board` | `boardRef.boardId` 是**本机画板的主键**，同上 |
  | ❌ 拒 | `data` | 规格卡不写 `type`，改成 `spec` + `fields` |

  被拒时报错会点名替代路径（如「先 `POST /api/uploads` 拿 uploadId，再 `POST /api/boards/{id}/cards` 单张建卡」）。
- 原生卡片的专属字段跟单张建卡**完全一样**，按 `meta.fieldKey` 放在各自的键里：
  `excalidraw:{source}` · `html:{url,mode,frameW,frameH}` · `book:{bookId,…}` · `ref:{query,mode,items}` ……
- `edges[].from/to` 用**信封内的本地 id**，也可以直接写画板上已有的 `c_` 卡片 id（把新卡接到老卡上）。
  两端解析不出来的边会被跳过并在 `warnings` 里说明，不会让整批失败。
- 上限：一封 200 张卡 / 400 条边；请求体 1 MB。
- 返回：`{ created[], updated[], skipped[], rejected[], edgeIds[], warnings[] }`。

**strict vs lenient**（这是整套体系里最要紧的一个选择）

| mode | 行为 | 什么时候用 |
| --- | --- | --- |
| `strict`（默认） | 只要有一张卡不合规，**整批都不落板**，返回 409 并说清是哪几张、为什么 | 一批数据是一个整体（一次同步、一次导入）。落一半会留下要人工对账的残局 |
| `lenient` | 跳过坏卡，其余照落，报告里逐条说明 | 从杂乱来源批量捞的东西，能收多少算多少 |

---

## 2. 规格文件：定义一类卡片

```jsonc
{
  "id": "feishu-message",          // kebab-case，必须与文件名一致
  "version": 1,                    // 结构版本；改字段就 +1
  "name": "飞书消息",
  "category": "external",          // external 外部对接 | record 结构化记录 | insight 指标与洞察
  "description": "群里的一条飞书消息 / 机器人通知",
  "icon": "message",               // 固定图标集，见 lib/icon-names.ts 的 SPEC_ICON_NAMES
  "tags": ["飞书", "IM"],
  "source": { "app": "feishu", "hint": "从哪拿到这些数据" },
  "defaultEnabled": true,          // 装上默认开着；实验性规格可以写 false
  "card": { "w": 340, "h": 250, "color": "blue" },   // 新建这类卡的默认尺寸与颜色

  "display": {                     // ★ 卡面怎么显示——全部规格共用同一个渲染器，靠它区分
    "title": "sender",             // 哪个字段当卡片标题（text / url / enum）
    "subtitle": "chat",            // 副标题（任意字段）
    "body": "text",                // 正文（text / longtext）
    "badges": ["msgType"],         // 页脚徽标，最多 4 个
    "link": "url",                 // 「打开」按钮指向哪个 url 字段
    "time": "sentAt"               // 页脚时间（date 字段）
  },

  "fields": [
    { "key": "sender", "label": "发送人", "type": "text", "required": true, "max": 60 },
    { "key": "text",   "label": "消息正文", "type": "longtext", "required": true },
    { "key": "msgType","label": "消息类型", "type": "enum",
      "options": [{ "value": "text", "label": "文本" }, { "value": "card", "label": "卡片" }] },
    { "key": "mentioned", "label": "@ 到的人", "type": "tags", "max": 10 },
    { "key": "url",    "label": "消息链接", "type": "url", "hint": "点开能跳回飞书" },
    { "key": "sentAt", "label": "发送时间", "type": "date" }
  ],

  "example": { "sender": "张三", "text": "…", "msgType": "text" }   // 既是文档，也是「用示例建一张卡」的数据源
}
```

### 字段类型（九种，不支持嵌套对象）

| type | 值形状 | 说明 |
| --- | --- | --- |
| `text` | 字符串 | 默认上限 300 字，`max` 可调 |
| `longtext` | 字符串 | 默认上限 4000 字 |
| `number` | 数字 | 可给 `unit`（"元" / "次" / "%"），只用于显示 |
| `bool` | 布尔 | 也接受 `"true"` / `"1"` / `"是"` |
| `date` | 毫秒时间戳 | 也接受 ISO 串与**秒级**时间戳，入库统一成毫秒 |
| `url` | 字符串 | 必须 http(s)，否则丢弃并提示 |
| `enum` | 字符串 | 必须在 `options` 里；给 label 也能认出来 |
| `tags` | 字符串数组 | 最多 20 条；给逗号分隔的字符串也行 |
| `list` | 对象数组 | 表格型字段，列由 `item[]` 定义（列类型只能 text/url/number/bool），最多 50 行 |

**为什么不支持任意嵌套**：卡片要能在一张 320px 的卡面上一眼看完，也要能在表单里手改。
真需要嵌套的东西（一整份文档、一棵树）应该另开一张卡，或者用 `list` 摊平成表格。

### 写规格的两条手感规矩

- **`label` 控制在 5 个字以内**：卡面属性区的标签列是固定宽的，长标签会折行；解释写进 `hint`。
- **重要的字段写在前面**：没被 `display` 用到的字段会按 `fields` 数组顺序出现在属性区。
- 别把主键、长 id 放进 `display.title` / `subtitle`——看不出信息还占位置，放属性区就好。

### 上限

单份规格 40 个字段 · enum 24 个选项 · list 8 列 · 单张卡 `fields` 序列化后 20 KB · 单个规格文件 32 KB。

---

## 3. 校验的两种脾气（有意不同）

| 入口 | 脾气 | 为什么 |
| --- | --- | --- |
| **规格文件**（读盘） | 严格，写错就**大声报错**并指明文件与字段 | 规格是资产。被悄悄兜底成一张空卡，比报错难查十倍 |
| **信封导入** `/ingest` | 严格：必填缺失、规格没装、规格停用都会被拒 | 批量数据要守规矩，否则脏数据会一路流进画板 |
| **单卡 API** `POST/PATCH /cards` | 宽容：清洗 + 兜底，不报错 | 一次改一个字段是常态；**不认识的规格也照样收下**（见 §4） |

具体清洗规则：规格里没定义的字段丢掉并提示 · 类型不合的值丢掉并提示 · 超长截断 ·
`date` 归一成毫秒 · `enum` 认 value 也认 label · 整卡超 20 KB 时先压长文本。

**字段级问题分三类，文案不许混**（踩过的坑：enum 值非法却报「缺必填字段」，调用方照着补也补不对）：

| 类别 | 什么情况 | 文案长什么样 | 后果 |
| --- | --- | --- | --- |
| 缺必填 | `required` 的字段**压根没给** | `缺必填字段：发送人（key=sender）` | 信封整张卡被拒 |
| 值不合规 | 给了但不合法，值被丢弃 | `字段值不合规：类型（key=msgType）「voice」不是合法取值，值已丢弃；可选：text / image / file（value 与 label 都认）` | 必填 → 整张卡被拒；非必填 → 只进 warnings |
| 未知字段 | 规格里没定义 | `未知字段（规格里没有，已丢弃）：xxx——字段表见 GET /api/card-specs/{id}` | 只进 warnings |

「值不合规」的文案必须写清**期望**：`enum` 列出合法值（前 8 个 + 总数）、`date` 说明接受
ISO 8601 / 10 位秒级 / 13 位毫秒级、`url` 说明必须 http(s) 绝对地址、`bool` 列出接受的写法。
每条都带 `key=`（agent 按 key 改）与中文 label（人按 label 认），信封里再前缀
`#下标 id=信封内 id（规格名）` 定位到具体是哪张卡。这三类在 `POST /api/card-specs/validate`
的 `problems` / `warnings` 里也是同一套。

---

## 3.5 卡面长什么样（`display` 怎么落地）

版式借的是飞书消息卡片，配色走画板自己的纸感体系：

```
┌──────────────────────────────────────┐
│ ▣ {title}                       ⋯    │  卡头：规格图标 + 标题
│ 「规格名」{subtitle}  [badge][badge] │  标题带：规格 pill + 次要信息 + 状态徽标
│ {body，最多 6 行}                     │  正文
│ ──────────────────────────────       │  分隔线
│   标签   值（最多两行）               │  属性区：display 没用到的字段自动列在这
│ ────────────────────────────────     │
│ {source.app} · {time}        打开 ↗  │  脚注：来源 · 时间 ——— 链接按钮
└──────────────────────────────────────┘
```

`bool` 字段做徽标时显示的是**字段标签本身**（「追更中」「已 push」），真假用颜色区分——
裸一个「是」放在卡面上没人看得懂，所以 bool 的 label 要能独立读懂。

## 4. 看别人的卡片：规格没装也能看

这是整套体系能互相传阅的前提：

- 画板上一张 `data` 卡引用了本机**没有**的规格 → 卡面降级成朴素的 key-value 表，
  外加一个「规格未安装」提示，**内容一个字都不丢**；编辑抽屉里直接改原始字段 JSON。
- 想看清楚别人给的一封 JSON 里到底有什么：`POST /api/card-specs/validate`
  （或界面上「规格 → 收卡片 → 先校验」）——每张卡摊成「标签 + 人话值」的表格，
  哪几张有问题、问题是什么，一目了然，**不落库**。
- 想把这份规格也装上：把对方的规格 JSON `POST /api/card-specs` 就行。

---

## 5. 判重：同一条记录再推一次是更新

外部系统的常态是**反复推同一批数据**（追更、轮询、重试）。所以：

- 卡片带 `source.externalId` 时，`{specId}::{externalId}` 就是这张卡的外部主键；
- 再送一次命中已有卡片 → 默认 **update**（字段**整份替换**，因为对方给的是这条记录此刻的完整样子），
  **几何位置保持不动**——用户可能已经把这张卡摆到某个位置了；
- `onDuplicate: "skip"` 只补新的；`"create"` 每次都新建（一般不要）。

没有 `externalId` 的卡永远是新建——所以**能带就带上**。

---

## 6. 开关：插件怎么关

- `PATCH /api/card-specs/{id}` `{"enabled": false}`（界面：规格中心里的开关）。
- 停用后：不能再收这类卡（`/ingest` 返回 409），新建菜单里不出现；
  **画板上已有的卡片完全不受影响**——关掉一个开关不该让已有数据消失。
- 状态只记「被改过的那些」，跟规格自己的 `defaultEnabled` 一致时会把记录删掉，状态文件保持干净。

---

## 7. 拿 Schema 去构造卡片（「注入 schema」）

| 想要什么 | 打哪 |
| --- | --- |
| 一份规格的 JSON Schema（Draft 2020-12） | `GET /api/card-specs/{id}/schema` |
| 同一份东西的人话版（省 token，喂 agent） | `GET /api/card-specs/{id}/schema?format=prompt` |
| **整个信封**的 Schema（涵盖全部**启用**的规格 + 原生卡片） | `GET /api/card-specs/schema` |
| 信封 Schema 的人话版 | `GET /api/card-specs/schema?format=prompt` |

界面上对应「复制 Schema」「复制说明」「复制示例信封」三个按钮——
把它甩给对面的开发者 / 甩进另一个 agent 的提示词，对方就知道该怎么拼 JSON。

---

## 8. 导出：同一套格式出去

```
GET /api/boards/{id}/export?format=cards            # 整块板 → 信封
GET /api/boards/{id}/export?format=cards&only=data  # 只导规格卡
```

与 `format=json` 的区别：那份是**本服务的内部结构**（几何、id 一应俱全，改完能 `PUT /whole` 回去）；
`format=cards` 是**交换格式**——规格卡摊成 `spec + fields`，别人不用懂 blotboard 的卡片模型也能读，
也能原样 POST 到另一台机器的 `/ingest` 上。两台画板之间搬卡片，走这条。

---

## 9. 自定义规格

```bash
# 建（写到 <数据目录>/my-card-specs/<id>.json）
curl -X POST http://127.0.0.1:8567/api/card-specs -H "x-auth-key: $TOKEN" \
  -H 'content-type: application/json' -d @my-spec.json

# 改（要显式 overwrite）
… -d '{ …, "overwrite": true }'

# 删（只能删自定义的；内置规格只能停用）
curl -X DELETE http://127.0.0.1:8567/api/card-specs/my-spec -H "x-auth-key: $TOKEN"
```

- id 不能与内置规格重名（两台机器上「同一个 id 两种结构」是最难查的一类问题），
  也不能叫 `schema` / `validate`（跟固定路由撞车）。
- 也可以直接往目录里丢文件——目录按 mtime 自动重读，**不用重启**。

---

## 10. 内置规格（17 份）

| 分类 | 规格 | 用途 |
| --- | --- | --- |
| 外部对接 | `feishu-message` | 群里的一条飞书消息 / 机器人通知 |
| | `feishu-doc` | 飞书云文档 / 多维表格的索引卡 |
| | `wechat-article` | 公众号文章索引（正文在知识库里） |
| | `github-issue` | Issue / PR 的状态卡 |
| | `source-account` | 追更清单上的一个号：平台主键、追到哪了、为什么追 |
| | `agent-skill` | 引用资源：一条能被 agent 直接装上用的 skill / MCP / CLI / 库（聚合视图见 `/resources` 页与 `GET /api/resources`） |
| 结构化记录 | `local-service` | 一个本机常驻服务：端口 / pm2 名 / 代码路径 / 干什么 / 踩过的坑 |
| | `incident-fix` | 排障记录：现象 → 根因 → 修法 → 提交 → 复发信号 |
| | `topic-idea` | 选题：给谁看、什么角度、钩子、手上的料、自评 |
| | `content-piece` | 内容成品：平台、数据、复盘、对应哪个选题 |
| | `meeting-note` | 会议纪要：结论 + 待办表 |
| | `decision-log` | 决策记录（ADR 风格：背景 / 决定 / 代价） |
| | `contact` | 联系人：怎么找到他、上次聊到哪 |
| | `prompt` | 提示词模板：用途、system、正文、变量、实测手感 |
| 指标与洞察 | `metric-snapshot` | 一个数字 + 它的口径与变化 |
| | `model-bench` | 模型实测：多快、多贵、翻车点、能不能上生产 |
| | `user-feedback` | 一条原话反馈：渠道、情绪、主题 |

## 11. 完整 API 一览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/card-specs` | — | 规格列表（含开关状态）；`?full=1` 连字段定义一起给 |
| POST | `/api/card-specs` | 写 | 新建 / 覆盖自定义规格 |
| GET | `/api/card-specs/{id}` | — | 详情（字段定义 + 示例 + agent 说明块） |
| PATCH | `/api/card-specs/{id}` | 写 | 开 / 关（`{"enabled": bool}`） |
| DELETE | `/api/card-specs/{id}` | 写 | 删除自定义规格 |
| GET | `/api/card-specs/{id}/schema` | — | 单份规格的 JSON Schema；`?format=prompt` 给人话版 |
| GET | `/api/card-specs/schema` | — | 信封 Schema（全部启用规格）；`?format=prompt` 同上 |
| POST | `/api/card-specs/validate` | — | 干跑校验一封信封，不落库 |
| POST | `/api/boards/{id}/ingest` | 写 | 收一封信封落板 |
| GET | `/api/boards/{id}/export?format=cards` | — | 整块板导成信封 |

## 12. 不做的事（v1 明确划掉）

- ❌ **规格版本迁移**：`version` 只是个记号，不做老卡片自动升级（改了字段名，老卡片里的老字段就是读不到；需要迁移就写一次性脚本）
- ❌ **跨机器同步规格**：规格文件自己拷/自己 POST，不做订阅与自动分发
- ❌ **嵌套对象字段**：见 §2
- ❌ **规格里挂计算 / 校验脚本**：规格是**数据**，不是代码——能执行的东西一旦能从外部传进来，这套体系就成了攻击面

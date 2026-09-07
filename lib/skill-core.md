<!--
  /api/skill 的核心章节（与卡片包无关的部分）。
  cards/<type>/skill.md 是各包自己的小节；这份按 `## ` 切成分节（format=json 用）。
  占位符：{{BASE}} = 本部署对外地址；{{TOKEN_HINT}} = token 来源说明（按部署现算）；
  {{TOKEN_SHELL}} = 取 token 的可复制 shell（同样按部署现算）。
-->

## 鉴权

> 本指南里的 HTTP API / MCP 操作的是**服务端文件库**。如果用户顶栏显示「浏览器 · workspace」，
> 数据在该标签页 origin 的 IndexedDB：不要对 `/api/boards` 发写请求，那会写进另一套库。
> 必须通过用户已授权的 Playwright/CDP 浏览器控制进入该标签页，调用
> `window.blotboardBrowser` 的 `listBoards/getBoard/putBoard/deleteBoard/exportBundle/importBundle`。
> 普通 shell 进程不能直接、安全地修改浏览器 profile 里的 IndexedDB 文件。

**动手前先把 token 拿到手**——写接口没有 token 一律 403，不是「先试试再说」的东西：

```bash
{{TOKEN_SHELL}}

curl -s -X POST {{BASE}}/api/boards \
  -H "x-auth-key: $TOKEN" -H "content-type: application/json" \
  -d '{"name":"新画板"}'
```

- {{TOKEN_HINT}}
- **读操作免鉴权**，直接 GET（画板、卡片、规格、`/api/skill`、`/api/capabilities` 都是）。
- **写操作**（POST / PATCH / PUT / DELETE）带请求头 `x-auth-key: <token>`；缺了或不对返回
  **403**（不是 401），响应体 `error` 里会把这套办法再说一遍。
- 浏览器同源请求走另一条通道：`x-board-web: 1`（页面自己用的，脚本别拿它当后门——跨源无效）。
- 机器可读版：`GET /api/capabilities` 的 `auth` 段（`{header, webHeader, source, tokenFile, tokenEnv}`）。
- 服务默认只接受本机 / 私网 / Tailscale 直连（TCP 层闸门，改不了头绕不过）。

## API 总表

卡片公共字段：`title` `content`（Markdown）`x` `y` `w` `h` `z` `color`（amber/blue/green/violet/rose/slate）
`agentPrompt`（卡片级 agent 指令，转 Issue 自动拼进正文）`createdBy`（user/agent）
`frameId`（归属哪个分组框，见 frame 那节）
`reading`（阅读顺序的例外：`{"skip":true}` 通读时跳过这张、`{"order":<数字>}` 显式序号排到最前；
两项都不设 = 完全按摆放位置读。传 `null` 清掉。**只影响阅读模式**，导出与大纲照旧收全板）。

**读一块板要打对口子**（这里最容易踩空）：`GET /api/boards` 只给**摘要清单**（每块板的 id / 名字 /
卡片数，**不含 cards**）；`GET /api/boards/{id}` 给**整块板**——`board.cards[]` `board.edges[]`
`board.comments[]` 一趟全在里面。看见列表里没有 cards 就以为「接口不返回卡片」是误会，换单板口即可。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/boards` | 画板**摘要**列表（不含 cards）/ 新建（`{name, parentId?, group?}`） |
| GET/PATCH/DELETE | `/api/boards/{id}` | 详情：**带 cards / edges / comments**（`?since=` 条件拉取）/ 改名·分组·父板 / 删除 |
| GET | `/api/boards/{id}/export?format=md\|json\|cards\|html\|bundle` | 导出：md 给人和 agent 读；json 可改完 PUT 回 whole；cards 是信封交换格式；bundle 是**画板包**（整块板搬走，见下） |
| GET | `/api/boards/export?ids=\|group=\|all=1` | **一批板**的导出：`format=json` 画板包 / `html` 一份文件装一整批 / `md` 逐块拼接；超过 200 块要分卷（`plan=1` 看计划、`volume=N` 取第 N 卷） |
| POST | `/api/boards/import` | 收一份导出文件立成新板（body 直接放文件原文）；`?mode=copy\|restore`、`?onConflict=skip\|replace\|copy`（**认错的值当场 400 且零写入**） |
| PUT | `/api/boards/{id}/state` | 批量几何（viewport + 卡片 x/y/w/h/z），只动位置最安全 |
| PUT | `/api/boards/{id}/whole` | 全量替换（**先 GET 最新再改再 PUT**；`comments` 三态：不传=不动 / 给数组=整表替换 / 给 `[]`=清空。两端没变的连线**保住原 id**，挂在上面的批注不会因为回写一次就没了） |
| POST | `/api/boards/{id}/tidy` | 服务端整理 `{mode: tidy\|flow\|LR\|TB\|group\|grid\|timeline\|kanban\|matrix\|swimlane\|cluster}`（tidy 保结构，其余会推翻布局；matrix 四象限 / swimlane 类型×状态泳道 / cluster 按连通分量分簇；每种模式干什么见 `/api/capabilities` 的 layouts） |
| POST | `/api/boards/{id}/cards` | 建卡（未知类型 / 停用的卡片包 → 400 结构化报错） |
| PATCH/DELETE | `/api/boards/{id}/cards/{cid}` | 改卡（含类型互转）/ 删卡（级联删连线与批注） |
| PATCH/DELETE | `/api/boards/{id}/cards` | 批量改 `{ids,patch}` / 批量删 `{ids}` |
| POST | `/api/boards/{id}/edges` | 连线 `{from,to,label?,kind?,weight?,tags?}`；kind ∈ rel/blocks/enables/references/produces；weight 是 1-5 的**关系强弱**（语义，与线宽 width 分开），tags ≤6 个短标签 |
| PATCH/DELETE | `/api/boards/{id}/edges/{eid}` | 改标签/语义/外观（color/style/width，传 null 恢复跟随语义）/ 关系强弱与标签（weight 传 null 取消标注、tags 传 `[]` 清空）/ 删 |
| GET/POST | `/api/boards/{id}/comments` | 评论清单（`?status=open` 默认）/ 加评论 |
| PATCH/DELETE | `/api/boards/{id}/comments/{cmid}` | 标解决 `{resolved:true}`·改正文 / 删 |
| POST | `/api/boards/{id}/comments/{cmid}/replies` | 回复 `{text, createdBy:"agent"}` |
| POST | `/api/uploads` | 上传（二进制 body + `x-file-name` 头）→ `uploadId`，image / media（音视频）/ pdf 卡用 |
| GET/POST | `/api/boards/{id}/history` | 连续编辑历史；POST `{action:"undo"\|"redo"}`，必须带 `x-board-since: <最新 board.updatedAt>`，版本不符返回409且不改板。最多100步/8MiB；只恢复画板，不取消任务执行 |
| GET | `/api/boards/{id}/checkpoints` | 自动快照清单（时间 / 原因 / 卡片连线计数 / 大小） |
| POST | `/api/boards/{id}/checkpoints/{stamp}/restore` | 回滚到那一版（**覆盖**卡片 / 连线 / 批注；回滚前会自动再打一份点） |
| DELETE | `/api/boards/{id}/checkpoints/{stamp}` | 删一份快照 |
| GET | `/api/boards/{id}/activity` | 这块板最近的批量改动记录（最多 50 条；整板 GET 里也带 `board.activity`） |
| POST | `/api/boards/{id}/ingest` | 收卡片信封落板 |
| POST | `/api/card-specs/validate` | 信封干跑校验（免鉴权，不落库） |
| GET | `/api/card-specs` `/api/card-specs/{id}` | 规格清单 / 字段表（响应带人话说明块） |
| GET | `/api/card-specs/schema?format=prompt` | 整封信封的人话 Schema（喂 prompt 用） |
| GET | `/api/boards/search?q=` | 跨画板全文搜索 |
| GET/PATCH | `/api/card-packs` | 卡片包的开关状态 / 开关（单个 `{type, enabled}`，批量 `{enabled:{svg:false,html:true}}`） |
| GET | `/api/templates` · POST `/api/templates/{id}/apply\|insert` | 模板中心：13 个思维框架一键铺开 |
| GET | `/api/capabilities` | 能力自描述（免鉴权）：整理模式 layouts、mermaid 渲染边界、skillFocus 都在里面 |
| GET | `/api/skill?format=install` | 可安装的轻量 SKILL.md（带 name / description）；只存入口，每次操作重新查询指南与能力，不含凭据 |
| GET | `/api/skill?focus=cards,tasks` | 就是本指南；带 focus 只输出相关章节（鉴权那节始终附上），省上下文 |

### 三条最短路（照抄就能跑）

先 `BASE=…`、`TOKEN=$(cat "${BLOTBOARD_DATA_DIR:-./data}/token")`（见「鉴权」那节）。
这三件事占了 agent 日常的绝大多数，各给一条最短的：

**① 批量往板上加内容**——一次多张卡走信封（`/ingest`），别一张一张 POST：

```bash
curl -sS -X POST "$BASE/api/boards/$BOARD/ingest" -H "x-auth-key: $TOKEN" \
  -H 'content-type: application/json' -d '{
    "format": "blotboard.cards", "version": 1,
    "cards": [
      {"type": "text", "title": "调研结论", "content": "## 要点\n- 一\n- 二"},
      {"type": "task", "title": "把结论发出去", "task": {"status": "todo"}}
    ]
  }'
```

回的是 `{ok, created:[{id,type,title}], report}`——`created[].id` 就是深链要用的 `card=`，
落板前服务端已自动打了一份快照。**不给坐标就自动排布**，加完想理一理再调 ③。

**② 导入 / 导出一份文件**（备份、搬家、把另一台的板端过来）：

```bash
# 导出：一块板（连子板）→ 标准画板包文件；&download=1 直接给文件，不带 {ok,…} 外壳
curl -fsS "$BASE/api/boards/export?ids=$BOARD&format=json&download=1" -o board.blotboard.json
# 导入：文件原文直接当 body 发过去
curl -sS -X POST "$BASE/api/boards/import?mode=copy" -H "x-auth-key: $TOKEN" \
  --data-binary @board.blotboard.json
```

回的是 `{ok, imported:[{id,name,group}], skipped, assets, notes}`。
`mode=copy` 一律新建（默认，不动已有的板），`mode=restore` 才按原 id 恢复。
**别拿 `format=md` 当备份**——那是给人读的摘要，导不回来。

**③ 只改布局，不动内容**——两条口，按需要选一条：

```bash
# 服务端整理：十一种模式，mode 的清单在 /api/capabilities 的 layouts
curl -sS -X POST "$BASE/api/boards/$BOARD/tidy" -H "x-auth-key: $TOKEN" \
  -H 'content-type: application/json' -d '{"mode":"tidy"}'
# 自己算好坐标就走纯几何口：只认 viewport 与 x/y/w/h/z，碰不到正文
curl -sS -X PUT "$BASE/api/boards/$BOARD/state" -H "x-auth-key: $TOKEN" \
  -H 'content-type: application/json' -d '{"cards":[{"id":"c_xxx","x":120,"y":80}]}'
```

`/tidy` 回 `{ok, mode, moved, changed}`（`changed` 是真变了几张；并行改动会 409，重来一次即可），
`/state` 回 `{ok, applied, total, updatedAt}`。**布局不是单独一类 `focus`**——
整理归在本节（`focus=api`），模式清单看 `/api/capabilities` 的 `layouts`。


## 改板安全网（快照与回滚）

**大改之前不用手动备份**——服务端会在每个「一次改很多」的入口动手**之前**自动照一张相：
`PUT /whole` · `POST /ingest` · `POST /paste` · `POST /tidy` · 批量 `PATCH/DELETE /cards` ·
单卡 `DELETE`（它会级联删连线与批注）· `POST /templates/{id}/insert`。
每块板留最近 N 份（默认 10，`BLOTBOARD_CHECKPOINT_KEEP` 可调，`0` = 整个关掉），超出删最旧。

- **单卡建 / 改不打点**（那条路有编辑抽屉的自动保存与删除撤销）；`PUT /state` 纯几何也不打点。
- **改砸了怎么办**：让用户在画板顶栏「历史」里点回滚，或者你自己调
  `POST /api/boards/{id}/checkpoints/{stamp}/restore`。回滚**覆盖**当前的卡片 / 连线 / 批注
  （板名、分组、父板不动），并且在覆盖前**自动再打一份点**——所以回滚本身也有回头路，
  响应里的 `checkpoint` 就是那份「回滚前」的 id。
- 这台开没开：`GET /api/capabilities` 的 `checkpoints` 段。关着的话，你在大改前自己
  `GET /api/boards/{id}/export?format=json` 留一份。
- **打点失败不会让你的写入失败**（安全网降级、主写入照常）——所以别把「我看到快照了」
  当成写入成功的判据，写入成功看的还是响应本身。
- 顺带记一条**工作日志**（`board.activity`，上限 50 条）：谁（`x-auth-key` = agent、
  `x-board-web` = 浏览器）在什么时候用哪个入口改了多少东西、对应哪份快照。
  这张表**只由服务端写**，请求体里带 `activity` 一律忽略（`PUT /whole` 也不会把它冲掉）。

## 搬家：画板包（备份 / 迁移 / 分享）

信封（下一节）是「往一块已有的板里送卡片」；要把**板本身**端走——名字、分组、卡片、
连线、评论、附件字节一起——用画板包：

- 导出一块：`GET /api/boards/{id}/export?format=bundle`（`&children=1` 连子画板一起）；
  导一批：`GET /api/boards/export?ids=b_a,b_b`（也认 `group=` / `all=1`）。
  默认把**子画板与被 board 卡指到的板**一起带上，不然对端点开那张卡是死链。
- 导入：`POST /api/boards/import`，body 直接放文件原文。认四种形状：画板包 JSON、
  单块板 JSON（`format=json` 的产物）、**排版导出的 HTML**——那份产物末尾带着同一份数据，
  所以「发给人看的文件」与「能导回画板的文件」是同一个文件（图片从正文的 data URI 还原）——
  以及**整个 HTTP 响应**（`{"ok":true,"bundle":{…}}`，把导出响应直接存成文件的那种）。
- 两种语义：`mode=copy`（默认）**一律新建**，卡片 / 连线换新 id，任务卡不继承来源机器的
  Issue 与任务 id；`mode=restore` 保住原 id 用来恢复自己的备份，撞上同 id 默认跳过，
  要覆盖得显式 `onConflict=replace`（覆盖前自动打一份快照）。
  **这两个参数写错一个字母就是 400、一块板都不写**（以前 `mode=restroe` 会静默退回 copy，
  于是「恢复备份」变成「又复制了一份」，而 201 里看不出来）；不传仍是默认值。
- 附件跟着包走（base64，总量上限 24 MB）；本机已有同一个上传件就复用，不再落第二份。
  超限没打包的会在响应的 `notes` 里逐条说明——别当成静默丢件。
- **一份包最多 200 块板，超了就分卷，绝不截断**：不给 `volume` 直接要一批超限的板会
  **413** 并附上完整分卷计划（总数 / 几卷 / 每一卷的取回地址）。先 `?plan=1` 只看计划不打包，
  再逐个 `?volume=1…N` 取。每一卷都是**完整可导入**的画板包，卷号写在 `bundle.volume` 里；
  要还原整个库就把每一卷都导一遍（跨卷的子画板引用等对应那卷导进来才连得上）。

## 评论工作流（用户交活的主要方式）

用户右键卡片 / 连线 / 空白处写评论，然后说「按画板上的评论改」——那些评论就是需求。

1. `GET /comments`（默认只回未解决的，正是要处理的那批；`?target=card&targetId=c_xxx` 收窄）
2. 按评论改板子
3. **回复**交代改了什么（`POST /comments/{id}/replies`）——只改不回，用户看不出你动过哪条
4. **标解决**（`PATCH {resolved:true}`）——只回不结，会一直挂在用户的待处理里

拿不准该不该结（只改了一半 / 不同意这条意见）就只回复不解决，把决定权留给用户。
读整块板用 `export?format=md`：卡片评论就摊在对应卡片正文下面，一趟拿全。
你也可以主动挂评论（`createdBy:"agent"`）——发现问题但不确定该不该动手时，评论比直接改稳妥。
评论的目标不给改；删卡会连带删掉挂在它身上的评论。

## 规格与信封（结构化卡片的正规入口）

- **一份规格 = 一类卡片的说明书**（字段、类型、卡面显示）。建规格卡前先
  `GET /api/card-specs/{id}` 查字段表——规格外的 key 会被丢掉，必填缺了信封整批拒收。
- **信封**是批量收发格式：`{format:"blotboard.cards", version:1, mode, onDuplicate, cards:[…], edges:[…]}`。
  `edges[]` 每项是 `{from,to,label?,kind?,weight?,tags?}`（两端写信封内的 `id`，或画板上已有的 `c_` 卡片 id）。
  `cards[]` 两种形态：带 `spec`+`fields` = 规格卡；带 `type` = 原生卡。原生卡收的是**自包含**的类型：
  text / task / quote / link / todo / mindmap / svg / mermaid / **excalidraw** / **html** / **book** / **ref**
  （专属字段跟单张建卡一模一样，如 `excalidraw:{source}`、`html:{url}`）。
  **不收 image / media / pdf / board**——它们的 `file.uploadId` / `boardRef.boardId` 是**本机主键**，
  换台机器指不到东西：这四种先拿到本机 id，再 `POST /api/boards/{id}/cards` 单张建卡。
- 报错分三类，别混着读：**缺必填字段**（压根没给，去补值）· **字段值不合规**（给了但不合法，
  文案里写着期望——enum 列合法值、date 说接受格式、url 要 http(s)，照着改那个值）· **未知字段**
  （规格里没有，已丢弃，去 `GET /api/card-specs/{id}` 查字段表）。每条都带 `#下标 id=信封内 id` 与 `key=`。
- `mode=strict`（默认）一张坏卡整批拒；`lenient` 跳过坏卡。拿不准先 POST `/api/card-specs/validate` 干跑。
- **判重**：卡片带 `source.externalId` 时，同规格 + 同 externalId 再送一次默认是**更新**（字段整份替换、
  位置不动）——外部数据反复同步不刷屏靠它，能带就带。
- 旧格式名 `goal-board.cards` 照收（兼容一个大版本）。
- 没有合适的规格就现场造一份（`POST /api/card-specs`，写盘即生效不用重启），别拿 text 卡硬凑。

## 深链约定

- 卡片直达：`{{BASE}}/?board=b_xxx&card=c_xxx` —— 改完回报用户时给这个链接，点开就落在那张卡上
- 任务台：`{{BASE}}/tasks?issue=i_xxx`（Issue 详情）· `/tasks?board=b_xxx`（按板收窄）
- 导航页：`{{BASE}}/nav`（跨画板找卡）
- 用户从别的 host（如 Tailscale IP）访问时，回报链接按**用户此刻访问的 host** 拼，别硬写 127.0.0.1

## 常见坑

1. **别拿旧快照 PUT /whole 回去**——会抹掉任务卡的 issueId/taskId 账本。先 GET；只改位置用 PUT /state
2. **image / media / pdf 必须先上传**拿 uploadId，否则 400；文件字段叫 **`file.uploadId`**，
   不是 `image.uploadId` / `media.uploadId` / `pdf.uploadId`（写错会被点名 400，别静默）。
   音视频建 `type:"media"`（本地文件；嵌别人网站的播放页用 html 卡），`kind`/`mediaType` 服务端按后缀推导，不用自己填
3. **连线不能自环、不能重复**（重复 409）；`link.url` 必须 http(s)
4. **待办 / 导图 / 图表源码是整体替换**——todo.items、mindmap.root、mermaid/svg.source 都要先读再改；
   **规格卡的 data.fields 相反是合并**，清字段显式传 null
5. **类型专属字段只写给对应类型的卡**——往 text 卡发 `task` 字段会被忽略，要先转 type
6. **停用的卡片包挡新建不挡已有**——新建 400 时读 `GET /api/card-packs` 看开关；画板上已有的卡照常读写
7. **按评论干完活要回复 + 标解决**（见评论工作流）
8. **whole 别顺手清评论**——`comments` 三态：**不传**（或不是数组）= 那张表一个字不动；**传数组** = 整表替换（落脚点已经没了的评论顺带剪掉）；**传 `[]`** = 显式清空。想留着批注就别把这个键写进 body
9. **图表 / 手绘的 source 是字符串**：`excalidraw.source` 传对象也认（会自动序列化成 JSON），
   但 `mermaid.source` / `svg.source` 要的是源码字符串，传对象直接 400——别落一个 `[object Object]`
10. **403 不是接口不存在**：写操作没带 token 就是它，照鉴权那节把 `x-auth-key` 补上（响应体里也写着）
11. **公共枚举写错会 400，不会被静默吞掉**：`color`（amber/blue/green/violet/rose/slate）、连线的
    `kind`/`style`/`color`/`width`、任务卡的 `task.status`/`task.priority`——单卡建 / 改与连线接口收到
    白名单外的值一律 400 并列出合法值；`null` 仍表示「跟随默认 / 跟随语义」，不是错值。
    （whole / 粘贴 / 信封是「收卡宽」的路，那边仍旧兜底，别拿它当校验器）

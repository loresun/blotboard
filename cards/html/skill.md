### 网页嵌入（html）

外部网页 / PPT 原样嵌进画板（沙箱 iframe）。`html.{url,mode,frameW,frameH}`：

- **只装地址，不存 HTML 正文**；`url` 必须 http(s) 且 host 要过白名单——先 `GET /api/embed-allow`
  （免鉴权）看现在允许哪些，非白名单域 400（部署侧用 `BLOTBOARD_HTML_ALLOW` 配）
- `frameW × frameH` 是被嵌页面的逻辑视口（PPT 常见 1280×720），卡面等比缩放；0 = 铺满卡片
- `mode` ∈ auto（进可视区自动加载）/ manual（点一下才加载）——页面重、一板多张时用 manual
- 一页一个 HTML 文件的 PPT 按页各建一张卡横着排开；单文件 JS 翻页的建一张就够
- **可以走信封导入**（`type:"html"` + `html:{url}`）：卡里只有地址，自包含；
  但白名单照样要过，对端不允许那个 host 就会被拒（报错里写着现在允许哪些）

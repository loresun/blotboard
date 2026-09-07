# 安全说明

## 威胁模型：本地优先 + 两道闸门

Blotboard 是**单机、单用户**的服务：数据就是磁盘上的 JSON 文件，没有账号、没有多租户，
它假设「能连到这个端口的人 = 你自己」。守住这条假设的是两道闸门：

| 闸门 | 在哪 | 管什么 |
| --- | --- | --- |
| **网络层**：只接受可信网段直连 | `server.mjs`，看 TCP 连接的真实 `remoteAddress`（不是可伪造的 `x-forwarded-for`） | 本机 / 私网 / Tailscale(100.64/10) / 链路本地放行，其余一律 403 |
| **应用层**：写操作要凭证 | `lib/auth.ts` | 浏览器靠同源 + `x-board-web` 头，agent 靠 `x-auth-key`（token 见 `<数据目录>/token`，0600） |

**读操作免鉴权**是有意的取舍（`GET /api/boards/...`、`/api/skill`、`/api/capabilities`），
边界完全落在第一道闸门上。默认绑定 loopback（`127.0.0.1`）；局域网共享需要显式更改监听地址。

`BLOTBOARD_ALLOW_PUBLIC_DIRECT=1` 关掉的正是第一道；配上默认的 `BLOTBOARD_HOST=0.0.0.0`，
等于把读写权限交给任何能连到这个端口的人。启动时会为此打一条显眼警告。
正确做法（反代 / Tailscale）见 README 的「放到公网前想清楚」。

## 已知边界（设计如此，但请知悉）

- **上传件没有应用层鉴权**。`/api/uploads/{id}` 的下载与预览有意免鉴权——卡面 `<img src>`
  与导出的单文件 HTML 都要能直接取到它。拦住它的只有不可枚举的 upload id 与网络层闸门。
  放到不可信网络前，这一层需要你自己加（反代按路径加鉴权，或不开放 `/api/uploads/`）。
- **ACP agent 继承画板进程的全部环境变量**（`{ ...process.env, ...agent.env }`）。
  `<数据目录>/runner-settings.json` 因此是**高信任输入**：能改它（或调 `PATCH /api/runner-settings`）
  的人，等于能在这台机器上以你的身份执行任意命令。别注册来路不明的命令。
- **网页嵌入卡跑的是别人的代码**。默认只允许本机 / 私网 / Tailscale 的地址
  （`BLOTBOARD_HTML_ALLOW`，`@none` 可整个关掉），同源地址会主动摘掉 `allow-same-origin`。
  把白名单放开到公网域名前，请当成「在你的页面里执行第三方脚本」来评估。
- **`x-forwarded-*` 默认不信**。只有 `BLOTBOARD_TRUST_PROXY=1` 时才用它们拼「回指画板的地址」。
  站在反代后面才该开——否则任何直连客户端都能让导出文件里的链接指向别处。
- **数据目录里有秘密**：`token`（内部 token）与 `runner-settings.json`（可能含 agent 的 env）
  都是 0600。别把数据目录整个提交进 git 或塞进公开备份。

## 报告问题

发现安全问题请**不要开公开 issue**，直接私下联系仓库维护者（GitHub 私信，或仓库
Security 页的 Private vulnerability reporting）。请附上复现步骤与影响范围；
在修复发布前请勿公开细节。

本项目是单机自用定位的小项目，暂不承诺 SLA 式的响应时限，但会尽快处理。

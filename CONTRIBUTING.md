# 参与 Blotboard

先说清楚项目现在的状态：**v1.0.0，首个公开版本**。从这一版起按语义化版本走——
破坏性改动进大版本，数据格式与 API 的变更都会写进 [CHANGELOG.md](CHANGELOG.md)。
公开使用者还少，遇到坑请开 issue，这是现在最有价值的贡献。

参与之前请先读一遍[行为准则](CODE_OF_CONDUCT.md)。

## 跑起来

需要 Node.js ≥ 20.9（Next 16 的下限）。

```bash
npm install          # postinstall 会从 node_modules 同步 Excalidraw 字体资产
npm run dev          # 开发（HMR）→ http://127.0.0.1:8567
```

端口被占会自动往后顺延，实际端口有三个准确来源：`<数据目录>/port` 文件、`GET /api/health`
的 `port` 字段、启动日志。数据默认落在仓库里的 `data/`（gitignored），
`BLOTBOARD_DATA_DIR` 可以换到别处——**开发时建议换一个**，免得把玩坏的板写进你真的在用的目录。

## 提交前只有一条命令

```bash
npm run check
```

它按「便宜的先跑」串起全套，任一步失败立刻停下并告诉你**这一步是干什么的、红了通常意味着什么**：

| 步骤 | 是什么 |
| --- | --- |
| `lint:repo` | 仓库静态体检（秒级，纯 Node 无依赖）：私有痕迹 / grep 不可见的源文件 / 文档死链 / 卡片包完整性 / env 与 README 对账 / CSS 变量 / 构建期 env 陷阱 |
| `test:unit` | 构建互斥、源码包边界、前端资源诊断回归 |
| `typecheck` | `tsc --noEmit` |
| `build` | 生产构建（smoke / e2e 都要吃它的产物，所以排在它们前面） |
| `smoke` | API 冒烟：自起隔离实例 + mock Runner + mock ACP agent + MCP 子进程 |
| `e2e` | Playwright 端到端（首次先 `npx playwright install chromium`） |

单独跑某一条当然可以（`npm run lint:repo` / `npm run smoke` …），
但**提交前的要求只有 `npm run check` 这一条**——以前写成四条并列，结果「跑了三条就提交」
成了常态，漏掉的那条通常是最慢也最重要的 e2e。修完一步想接着往下跑：
`npm run check -- --from smoke`。

三条硬要求：

- **测试数量只增不减**。改行为就改断言，别删用例。
- **测试永远用隔离数据目录**。smoke 与 e2e 都自己起实例、自己挑临时目录，
  任何情况下都不许指向仓库里的 `data/`。提交前 `git status data/` 必须是干净的。
- **`lint:repo` 红了就修问题，不要放宽检查**。那里面每一条都对应这个仓库真栽过的一次跟头，
  确实需要豁免时，加进脚本里的白名单并**写清理由**（脚本里有现成的例子）。

CI（`.github/workflows/ci.yml`）跑的就是 `npm run check`，机器上没有任何外部服务——
所以用例不能依赖你本机跑着的东西，要外部响应就自己 mock。

## 用着出问题时

```bash
npm run doctor      # 打活服务，出一份可以直接贴进 issue 的 Markdown 诊断报告
```

版本 / 端口实际落位 / 数据目录 / token 生效来源（**只报来源类型，不打印值**）/
三个可选集成的可达性 / 启用的卡片包与规格 / 板数与坏板文件 / 快照占用与孤儿目录 /
磁盘余量 / 最近一次写入时间，一次给全。它**只读**，不改任何数据；
服务连不上时给的是排查步骤而不是堆栈。报 bug 时贴上它的输出，能省掉好几个来回。

## 加一种卡片包

一种卡片 = `cards/<type>/` 下的一个目录，完整步骤在 [AGENTS.md](AGENTS.md)
「加一种卡片包（step by step）」。动手前先自问一句：**这个需求能不能下沉成规格 JSON**
（`data/card-specs/`，热插拔零代码）？能就别写代码包。

架构分层、目录导览、数据约定、以及那十来条「改代码的红线」也都在 AGENTS.md，
动结构之前请先读它。

## 改界面文案 / 加一种语言

界面文案不写在组件里，全在 `lib/i18n/dicts/`：一个界面区域一对文件
（`chrome` 顶栏与设置、`sidebar` 左栏与工具条、`panels` 抽屉、`cards` 卡片包、
`pages` 独立页、`canvas` 画布与共享标签）。

- **改一句话**：改对应的 `*.zh.ts`（中文是键的唯一来源）与 `*.en.ts`。
  ⚠️ 中文那份的值同时被 e2e 按可见文字取元素，改字要连着改用例。
- **组件里怎么取**：渲染期用 `useT()`，事件回调 / store 里没有 hook 就用 `tr()`，
  卡片类型名用 `useCardLabel()`。`{name}` 是占位符，`t("key", { name })` 替换。
- **加一种语言**：`lib/i18n/index.ts` 的 `LOCALES` 加一个码，给每份字典补一个
  `*.<code>.ts`（类型是 `Record<keyof typeof xxxZh, string>`，**漏一条 typecheck 当场红**），
  帮助文档放 `docs/guide/<code>/`（文件名即 slug，没译的那页自动退回中文）。
- 语言存在 `blotboard.locale` cookie 里，服务端渲染那一遍就已经定下来——
  所以别在组件里读 `navigator.language` 猜。

## 提交

- 分支从 `master` 切；提交信息中文英文都行，说清**为什么**改而不是改了什么。
- 一个提交做一件事；跨主题的改动拆开。
- 注释写「为什么这么做」，尤其是那些看起来可以更简单、但简单版会出问题的地方——
  这个仓库的注释风格就是如此，请跟上。
- PR 里说明：改了什么、怎么验的、有没有行为变化。

## 报安全问题

别开公开 issue，走 [SECURITY.md](SECURITY.md)。

生产服务运行时不要在同一工作区构建；隔离构建、发布与备份步骤见 [DEPLOYMENT.md](docs/DEPLOYMENT.md)。

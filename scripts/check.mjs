#!/usr/bin/env node
/**
 * `npm run check` —— 提交前的**唯一**一条命令。
 *
 * 为什么要收成一条：以前 CONTRIBUTING 写的是四条命令并列，于是「跑了三条就提交」
 * 变成常态——漏掉的那条通常就是最慢的 e2e，而它恰好是唯一能发现「界面还能不能用」的。
 * 一条命令没有漏跑的余地。
 *
 * 顺序是**便宜的先跑**：一秒的静态体检能挡住的问题，没必要等六分钟的 e2e 来告诉你。
 *   lint:repo → typecheck → build → smoke → e2e
 * （build 排在 smoke / e2e 前面不是为了快，是它俩都要吃 `.next` 产物。）
 *
 * 失败时除了原样透传子进程的输出，还会多打一段：**这一步是干什么的、红了通常意味着什么**。
 * 排障最贵的一步往往是「看到一堆报错，不知道该从哪个方向想」。
 *
 * 用法：
 *   npm run check                 全跑
 *   npm run check -- --from smoke 从某一步开始（前面几步刚跑过就别重复）
 *   npm run check -- --skip e2e   跳过某几步（逗号分隔）
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const STEPS = [
  {
    name: "lint:repo",
    args: ["run", "lint:repo"],
    what: "仓库静态体检：私有痕迹 / grep 不可见的源文件 / 文档死链 / 卡片包完整性 / env 与 README 对账 / CSS 变量 / 构建期 env 陷阱",
    means:
      "红的是「编译得过但会静默出错」的那一类问题。报告里每条都带了文件:行号与改法，照着改；如果你觉得某条不该红，先想清楚再动检查——放宽它等于把当年那个坑重新打开。",
  },
  {
    name: "test:unit",
    args: ["run", "test:unit"],
    what: "构建互斥、发布安全与静态资源诊断回归（独立临时目录）",
    means: "生命周期或发布边界回归，修复对应脚本，不要跳过这些检查。",
  },
  {
    name: "typecheck",
    args: ["run", "typecheck"],
    what: "TypeScript 全量类型检查（tsc --noEmit）",
    means:
      "多半是漏改了某处枚举 / 注册表。加卡片包时三份注册表少一处、`BOARD_CARD_TYPES` 元组少一项，都会在这里第一个红。",
  },
  {
    name: "build",
    args: ["run", "build"],
    what: "Next 生产构建（smoke 与 e2e 都要吃它的产物，所以排在它们前面）",
    means:
      "常见两类：① 服务端代码 import 了 React 组件（红线 1：`lib/` 与 `app/api/` 不得引 `ui.tsx`）；② 客户端组件里用了只有 node 才有的 API。",
  },
  {
    name: "smoke",
    args: ["run", "smoke"],
    what: "API 冒烟：自起隔离实例 + mock Runner + mock ACP agent + MCP 子进程，约一千条断言",
    means:
      "接口行为变了。注意它跑在**临时数据目录**上，红了不代表你本机的数据有事；反过来，如果它红在「透传往返」那几条，说明有字段在存取途中被洗掉了——那是兼容第一铁律，必须修不能改断言。",
  },
  {
    name: "e2e",
    args: ["run", "e2e"],
    what: "Playwright 端到端：goal-agent 与 local 两种形态各起一个实例，跑真浏览器",
    means:
      "界面层面出问题了。首次跑要先 `npx playwright install chromium`。失败的 trace 在 `test-results/` 里，`npx playwright show-trace <路径>` 能一帧帧回看。",
  },
];

const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : null;
};
const from = valueOf("--from");
const skip = new Set((valueOf("--skip") || "").split(",").map((s) => s.trim()).filter(Boolean));

let started = false;
const planned = STEPS.filter((step) => {
  if (from && !started) {
    if (step.name !== from) return false;
    started = true;
  }
  return !skip.has(step.name);
});
if (from && !started) {
  console.error(`--from ${from} 不是已知步骤；可选：${STEPS.map((s) => s.name).join(" / ")}`);
  process.exit(2);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const t0 = Date.now();

for (const [index, step] of planned.entries()) {
  const label = `[${index + 1}/${planned.length}] ${step.name}`;
  console.log(`\n\x1b[1m${label}\x1b[0m  \x1b[2m${step.what}\x1b[0m`);
  const started = Date.now();
  const result = spawnSync(npm, step.args, { cwd: ROOT, stdio: "inherit" });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status === 0) {
    console.log(`\x1b[32m✓ ${step.name}\x1b[0m \x1b[2m${seconds}s\x1b[0m`);
    continue;
  }
  console.error(`\n\x1b[31m\x1b[1m✗ ${step.name} 失败\x1b[0m \x1b[2m${seconds}s\x1b[0m`);
  console.error(`  \x1b[2m这一步在干什么：\x1b[0m${step.what}`);
  console.error(`  \x1b[2m红了通常意味着：\x1b[0m${step.means}`);
  const rest = planned.slice(index + 1).map((s) => s.name);
  if (rest.length) {
    console.error(`  \x1b[2m后面没跑的：\x1b[0m${rest.join(" / ")}　（修完可以 \`npm run check -- --from ${step.name}\` 接着跑）`);
  }
  process.exit(result.status ?? 1);
}

console.log(`\n\x1b[32m\x1b[1m全部通过\x1b[0m \x1b[2m共 ${((Date.now() - t0) / 1000).toFixed(0)}s\x1b[0m`);

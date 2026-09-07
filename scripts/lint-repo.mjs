#!/usr/bin/env node
/**
 * 仓库静态体检（`npm run lint:repo`）——把这个项目**真实踩过的坑**固化成会自动变红的检查。
 *
 * 为什么要单独一条命令：typecheck / smoke / e2e / build 四条守的都是「代码跑起来对不对」，
 * 但这个仓库栽过的跟头有一半是**静默**的——CSS 写了不存在的变量只是背景变透明、
 * 源码里一个裸 NUL 字节能让 `grep -r` 悄悄跳过整个文件、卡片包少写一个 FullView
 * 只在「点开那一种卡」时才空白。这些东西编译得过、测试也跑得绿，只有肉眼能发现，
 * 于是同一个坑会踩第二次。这份脚本就是把那些「只有肉眼能发现」的东西交给机器盯。
 *
 * 三条自我约束：
 *  1. **零依赖**：只用 Node 内置模块。体检脚本自己带一堆依赖就成了新的维护负担。
 *  2. **秒级**：纯静态读文件，不起服务、不装浏览器，所以能排在 `npm run check` 的第一位——
 *     贵的检查跑之前先把便宜的问题挑出来。
 *  3. **报告必须可操作**：每条红都给「文件:行号 + 为什么这是问题 + 怎么改」。
 *     只说「失败」的检查等于没有，人看不懂就会去放宽它而不是修它。
 *
 * 检查清单（编号与 README / CONTRIBUTING 无关，只是本文件内部的分节）：
 *   1 binary-invisible  源文件里的裸 NUL / 控制字符 —— grep 会把整个文件当二进制静默跳过
 *   2 private-traces    私有痕迹（本机路径 / 私有端口 / 内部工单号 / 身份串）
 *   3 doc-links         文档与注释里指向仓库内文件的引用必须真的存在
 *   4 card-packs        卡片包四件套 / 注册表 / 工具条分组 / **有专属字段就必须有 FullView**
 *   5 env-docs          代码里读的 env 与 README 环境变量表逐项对账
 *   6 css-vars          CSS 用了没定义也没兜底值的变量 —— 无效值静默回退
 *   7 build-time-env    读运行时 env 的页面 / 路由必须 force-dynamic —— 否则 env 被烤进构建产物
 *  10 skill-focus       文档 / 生成模板里的 `?focus=` 必须是 SKILL_FOCUS 里真有的值
 *
 * 用法：
 *   node scripts/lint-repo.mjs            全跑
 *   node scripts/lint-repo.mjs --only 4   只跑某几项（逗号分隔，编号或名字都行）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sourcePathAllowed, publicExampleHost } from "./source-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ── 报告基建 ─────────────────────────────────────── */

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s);
const redText = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s);
const greenText = (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s);

/** 一条问题：where 是「文件:行号」，why 是为什么它是问题，how 是怎么改。三样缺一不可。 */
const problems = [];
function report(check, where, why, how) {
  problems.push({ check, where, why, how });
}

/* ── 文件清单 ─────────────────────────────────────── */

/**
 * 扫描范围 = **git 跟踪的文件**。这样一来 `data/`（用户数据）、`.next/`、`node_modules/`、
 * 以及 gitignore 掉的本机 pm2 配置 `ecosystem.config.cjs` 天然不在范围内——
 * 后者按任务书本该显式白名单，用「只看进 git 的东西」这条口径更稳：
 * 白名单会忘记更新，「没提交的文件不会泄漏给别人」永远成立。
 *
 * 没有 git（源码包解压出来的场景）时退回手工遍历，忽略同一批目录。
 */
function listFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    const files = [...new Set(out.toString("utf8").split("\0").filter(Boolean))];
    if (files.length) return files;
  } catch {
    /* 不是 git 仓库 / 没装 git：往下走手工遍历 */
  }
  const skipDirs = new Set([".git", "node_modules", ".next", ".blotboard-runtime", "release", "out", "test-results", "playwright-report", "data"]);
  const acc = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel) || ROOT, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        walk(next);
      } else if (entry.isFile()) {
        acc.push(next);
      }
    }
  };
  walk("");
  for (const folder of ["data/templates", "data/card-specs"]) if (fs.existsSync(path.join(ROOT, folder))) walk(folder);
  return acc.filter(sourcePathAllowed);
}

/** 认得出的文本扩展名；其余（图片 / 字体 / PDF）一律跳过，免得把二进制当源码读。 */
const TEXT_EXT = new Set([
  ".ts", ".tsx", ".mjs", ".cjs", ".js", ".jsx", ".json", ".md", ".css", ".html",
  ".yml", ".yaml", ".txt", ".svg", ".sh",
]);
const isTextFile = (rel) => TEXT_EXT.has(path.extname(rel).toLowerCase()) || path.basename(rel) === "LICENSE";

const FILES = listFiles();
const TEXT_FILES = FILES.filter(isTextFile);

const readCache = new Map();
/** 读文本文件（带缓存）。读不到返回 null——文件清单可能来自 git index 而磁盘上已删。 */
function readText(rel) {
  if (readCache.has(rel)) return readCache.get(rel);
  let text = null;
  try {
    text = fs.readFileSync(path.join(ROOT, rel), "utf8");
  } catch {
    /* 保持 null */
  }
  readCache.set(rel, text);
  return text;
}
/** 字节偏移 → 行号（1 起）。检查 1 按字节扫，报错要给人看得懂的行号。 */
function lineOfOffset(buf, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < buf.length; i++) if (buf[i] === 0x0a) line++;
  return line;
}
function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/* ── 1. grep 不可见的源文件 ───────────────────────── */

/**
 * 防的是这个仓库真出过的一次事故：源码里两处用作分隔符的**裸 NUL 字节**，
 * 让 `grep -r` 把整个文件判定成二进制——既不报错，也不列出任何匹配，
 * 于是「私有痕迹清理」连查两轮都漏掉了那两个文件里的内容。
 *
 * 判定口径跟 grep 一致再宽一点：NUL 是硬红（grep 必然跳过），
 * 其余 C0 控制字符（除 \t \n \r）与 DEL 也报——它们同样会让文件在各种工具里表现诡异，
 * 而源码里想表达它们应该写转义序列而不是把字节本身埋进去。
 */
function checkBinaryInvisible() {
  const roots = ["app/", "cards/", "components/", "lib/", "scripts/", "bin/", "e2e/"];
  const targets = TEXT_FILES.filter(
    (rel) => roots.some((r) => rel.startsWith(r)) || (!rel.includes("/") && /\.(ts|tsx|mjs|cjs|js)$/.test(rel)),
  );
  for (const rel of targets) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(ROOT, rel));
    } catch {
      continue;
    }
    for (let i = 0; i < buf.length; i++) {
      const code = buf[i];
      const isControl = (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
      if (!isControl) continue;
      const hex = `0x${code.toString(16).padStart(2, "0")}`;
      report(
        "binary-invisible",
        `${rel}:${lineOfOffset(buf, i)}`,
        code === 0x00
          ? `源文件里有裸 NUL 字节（${hex}）——grep 会把整个文件判定成二进制，既不报错也不列出任何匹配，从此这个文件对 \`grep -r\` 隐形`
          : `源文件里有裸控制字符 ${hex}——同样会让 grep / diff / 编辑器把文件当二进制处理`,
        `把字节本身换成转义序列写进字符串：\`"\\u${code.toString(16).padStart(4, "0")}"\`（源码看得见、运行时等价）`,
      );
      break; // 一个文件报一条就够：整份文件都得改，逐字节刷屏没意义
    }
  }
}

/* ── 2. 私有痕迹 ──────────────────────────────────── */

/**
 * 开源仓库里不该出现的东西。**表里只放能写进公开仓库的模式**——
 * 「作者真实姓名」这类本身就是隐私的串，硬编码进这份（会被开源出去的）脚本
 * 等于在防泄漏的工具里泄漏一次，所以那部分改成**运行时从本机推导**（见 identityPatterns）。
 */
const PRIVATE_PATTERNS = [
  {
    id: "home-path",
    // `/Users/<占位>` 这种尖括号占位不会命中（用户名段要求以字母开头）
    re: /\/(?:Users|home)\/[a-z][A-Za-z0-9._-]*\//g,
    why: "本机绝对路径会泄漏用户名与目录结构；`/api/issues/:id` 是免鉴权读口，写进 prompt 就等于公开这台机器的目录树（红线 9）",
    how: "换成 `<数据目录>/…`、`<项目根>/…` 这类相对表述",
  },
  {
    id: "private-port",
    // 作者本机那一串服务的端口。画板自己的 8567 不在表里
    re: /\b(?:8305|8306|8310|8321|8322|8330|8340|8350|8600|8610|8766)\b/g,
    why: "这是作者本机私有服务的端口，开源用户没有对应服务；写进 UI 文案 / 占位符 / 错误提示会让人对着一个不存在的地址排查",
    how: "换成中性说法或 `http://127.0.0.1:9001` 这类明显的占位示例（env 变量名与其默认值不受影响）",
  },
  {
    id: "private-host",
    re: /\b(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/gi,
    why: "私有域名 / 本机 IP：对外没有意义，还暴露了作者的网络拓扑",
    how: "示例域名一律用 `example.com`，示例地址用 `127.0.0.1`",
  },
  {
    id: "ticket-id",
    re: /\b(?:GA-\d{1,5}|IN-2\d{5})\b/g,
    why: "内部工单号：读者查不到这条工单，注释里的「见 GA-xx」等于没写",
    how: "把工单里的结论**就地写成一句自解释的话**，不要指向外部编号",
  },
  {
    id: "secret-literal",
    // 「像密钥的字面量」：够长、字母数字混排，且赋给了 token / key / secret 这类名字
    re: /(?:token|secret|api[_-]?key|password)\s*[:=]\s*["'`](?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}["'`]/gi,
    why: "看起来是写死的密钥。这个仓库的 token 一律运行时从 `<data>/token` 或 env 读，源码里不该有值",
    how: "删掉这个值，改成从 env / 数据目录读；已经进过 git 的密钥要当成已泄漏，换一把新的",
  },
];

/**
 * 显式白名单：`{ file, ids, reason }`。**每条都必须写理由**——
 * 没有理由的豁免会随时间变成「以前有人关掉了这条检查，没人知道为什么」。
 */
const PRIVATE_ALLOW = [
  { file: "server.mjs", ids: ["private-host"], reason: "网络闸门记录 RFC 私网/Tailscale CIDR 范围，不是部署地址" },
  { file: "lib/embed-allow.ts", ids: ["private-host"], reason: "嵌入策略必须描述允许的私网地址范围" },
  { file: "e2e/security.spec.ts", ids: ["private-host"], reason: "安全用例验证私网地址与伪装域名的区分，地址仅作为纯函数输入" },
  { file: "scripts/source-policy.test.mjs", ids: ["private-host"], reason: "发布规则拒绝私网 IP 的负向测试，不访问网络" },
  {
    file: "docs/OPEN-SOURCE-PLAN.md",
    ids: ["private-port", "private-host", "ticket-id", "home-path"],
    reason: "开源决策记录：它的「私有痕迹清理」清单本身要点名清掉了哪些端口 / 域名 / 工单号，不点名就没法复核",
  },
  {
    file: "CHANGELOG.md",
    ids: ["private-port", "private-host", "ticket-id"],
    reason: "变更记录同理：写「把 8305 换成中性说法」时必须能写出 8305",
  },
  {
    file: "LICENSE",
    ids: ["identity"],
    reason: "MIT 协议要求写明版权人，这里出现作者标识是协议本身的要求",
  },
  {
    file: "package.json",
    ids: ["identity"],
    reason:
      "repository / homepage / bugs / author 四个字段：仓库开在个人账号下，公开地址里必然带账号名。这几个字段是 npm 与 GitHub 找到项目的唯一线索，去掉等于装了包的人报不了 bug",
  },
  {
    file: ".github/ISSUE_TEMPLATE/config.yml",
    ids: ["identity"],
    reason: "安全上报链接必须指向本仓库的 Security advisories 页，路径里就带着账号名",
  },
  {
    file: "scripts/lint-repo.mjs",
    ids: ["private-port", "private-host", "ticket-id", "secret-literal", "home-path"],
    reason:
      "这份文件**就是模式表本身**：不把 8305、example 域名、GA- 前缀写出来就没法查它们。它没有任何用户可见文案，也不参与构建产物",
  },
  {
    file: "packaging/npm-placeholder/LICENSE",
    ids: ["identity"],
    reason: "同上：占位包的 LICENSE 也要带版权行",
  },
];

/**
 * 「作者身份串」的模式**运行时推导**，不写进源码：
 * git 配置的用户名 / 邮箱本地部分、系统用户名、家目录名。
 * 只取长度 ≥ 4 的——`sun` 这种三字母串在英文文本里会满屏误报，
 * 而真正危险的「家目录绝对路径」已经由 home-path 那条兜住了。
 */
function identityPatterns() {
  const raw = new Set();
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return "";
    }
  };
  raw.add(git(["config", "user.name"]));
  const email = git(["config", "user.email"]);
  if (email) {
    raw.add(email);
    raw.add(email.split("@")[0]);
  }
  try {
    raw.add(os.userInfo().username);
    raw.add(path.basename(os.homedir()));
  } catch {
    /* 某些容器里拿不到，跳过 */
  }
  // 本机额外补充的模式（正则字符串数组），文件不进 git：`scripts/lint-repo.local.json`
  try {
    const extra = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "lint-repo.local.json"), "utf8"));
    for (const item of extra.identity || []) raw.add(String(item));
  } catch {
    /* 没有这个文件是常态 */
  }
  return [...raw]
    .filter((value) => value && value.length >= 4)
    .map((value) => ({
      id: "identity",
      re: new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      why: "作者的个人标识（git 用户名 / 邮箱 / 系统账号）出现在了源码里",
      how: "换成项目名或中性称呼；确实需要署名的地方（LICENSE 版权行）请加进 PRIVATE_ALLOW 并写明理由",
    }));
}

function checkPrivateTraces() {
  const patterns = [...PRIVATE_PATTERNS, ...identityPatterns()];
  for (const rel of TEXT_FILES) {
    const text = readText(rel);
    if (text === null) continue;
    for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      if (!publicExampleHost(match[1])) report("private-traces", `${rel}:${lineOfIndex(text, match.index)}`, "未经审查的硬编码网络地址，可能是私人部署或外部数据发送目标（值不回显）", "私人地址移入本机配置；通用公开文档/依赖地址请在 source-policy.mjs 中注明并登记");
    }
    const allowed = new Set(PRIVATE_ALLOW.filter((rule) => rule.file === rel).flatMap((rule) => rule.ids));
    for (const pattern of patterns) {
      if (allowed.has(pattern.id)) continue;
      pattern.re.lastIndex = 0;
      let match;
      let hits = 0;
      while ((match = pattern.re.exec(text)) !== null) {
        if (match[0].length === 0) break; // 防呆：零宽匹配会死循环
        report(
          "private-traces",
          `${rel}:${lineOfIndex(text, match.index)}`,
          pattern.why,
          pattern.how,
        );
        if (++hits >= 5) break; // 同一文件同一模式最多报 5 处，够定位了
      }
    }
  }
}

/* ── 3. 文档死链 ──────────────────────────────────── */

/**
 * 防的是「三处注释都写着「规则见某份设计文档 §3.3」，而那份文档从来不在这个仓库」那次——
 * 注释里的指路没人验证，读者照着找，找不到，然后开始怀疑是不是自己 checkout 错了。
 *
 * 三类引用都查：
 *  a. Markdown 的相对链接 `[文字](path)`；
 *  b. `docs/xxx.md` 与根目录 `*.md`；
 *  c. 指路的仓库内源码路径（`lib/board-schema.ts` 这类具体文件）。
 *
 * **扫描范围只有「.md 全文」与「代码里的注释」**。代码的字符串字面量不算指路——
 * 冒烟里有张代码卡的 filename 字段就长得跟一条仓库路径一模一样，那是测试夹具不是指路；
 * 把字面量也当引用查，报出来的全是噪声，而噪声多了这条检查就会被人关掉。
 * 带占位符（`<type>`、`*`、`{}`）的路径是模式不是具体文件，同样跳过。
 */
const ROOT_DOCS = ["AGENTS.md", "README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md", "THIRD-PARTY-NOTICES.md"];

/**
 * 死链白名单：`{ file, targets, reason }`。同私有痕迹那份的口径——**必须写理由**，
 * 而且按**具体目标**豁免而不是整份文件，免得这份文件里将来真出现的死链被一并放过。
 */
const DOC_LINK_ALLOW = [
  {
    file: "docs/OPEN-SOURCE-PLAN.md",
    targets: ["docs/agent-test-report-2026-09-02.md", "docs/SPEC.md"],
    reason:
      "开源前的清理记录：这两条恰恰是「已经移出本仓 / 从来不在本仓」的记录本身，写清是哪个文件才复核得了。文中已注明它们不在仓库里",
  },
  {
    file: "scripts/lint-repo.mjs",
    targets: ["scripts/lint-repo.local.json"],
    reason: "本机可选的额外模式表，按设计不进 git（见 .gitignore）——「不存在」才是它的常态",
  },
];

function existsInRepo(rel) {
  try {
    return fs.statSync(path.join(ROOT, rel)).isFile();
  } catch {
    return false;
  }
}

/**
 * 把代码里的非注释部分抹成空格（保留换行与偏移，行号才不会错位）。
 * `//` 的识别刻意要求前一个字符不是 `:` 或引号——否则 `https://…` 会被当成行注释起点。
 */
function commentsOnly(text) {
  const chars = new Array(text.length).fill(" ");
  const keep = (start, end) => {
    for (let i = start; i < end && i < text.length; i++) chars[i] = text[i];
  };
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") chars[i] = "\n";
  for (const m of text.matchAll(/\/\*[\s\S]*?\*\//g)) keep(m.index, m.index + m[0].length);
  for (const m of text.matchAll(/(^|[^:"'`\\/])\/\/[^\n]*/g)) keep(m.index, m.index + m[0].length);
  return chars.join("");
}

function checkDocLinks() {
  const placeholder = /[<>{}*…?]|\.\.\.|\bxxx\b/i;
  const scannable = TEXT_FILES.filter((rel) => /\.(md|ts|tsx|mjs|cjs|js)$/.test(rel));
  for (const rel of scannable) {
    const raw = readText(rel);
    if (raw === null) continue;
    const isMarkdown = rel.endsWith(".md");
    const text = isMarkdown ? raw : commentsOnly(raw);
    const allowed = new Set(DOC_LINK_ALLOW.filter((rule) => rule.file === rel).flatMap((rule) => rule.targets));
    const dir = path.dirname(rel);
    /** target → 第一次出现的位置，去重后统一判存在 */
    const refs = new Map();
    const add = (target, index, kind) => {
      if (!target || placeholder.test(target)) return;
      const key = `${kind}:${target}`;
      if (!refs.has(key)) refs.set(key, { target, index, kind });
    };

    if (isMarkdown) {
      // a. Markdown 相对链接（跳过 http(s) / mailto / 纯锚点）
      for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const href = m[1];
        if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) continue;
        if (href.startsWith("/")) {
          const pathname = href.split(/[?#]/)[0].replace(/\/+$/, "");
          const routePath = `app${pathname}/page.tsx`;
          const apiPath = `app${pathname}/route.ts`;
          if (existsInRepo(routePath) || existsInRepo(apiPath)) continue;
          add(routePath, m.index, "route");
          continue;
        }
        add(path.posix.normalize(path.posix.join(dir === "." ? "" : dir, href.split("#")[0])), m.index, "link");
      }
    }
    // b. docs/xxx.md 与根目录 *.md（注释里的指路最常写成这个形状）
    for (const m of text.matchAll(/\bdocs\/[A-Za-z0-9._-]+\.md\b/g)) add(m[0], m.index, "doc");
    for (const name of ROOT_DOCS) {
      for (const m of text.matchAll(new RegExp(`\\b${name.replace(".", "\\.")}\\b`, "g"))) add(name, m.index, "doc");
    }
    // c. 注释 / 文档里指路的仓库内源码路径
    for (const m of text.matchAll(/\b(?:lib|components|cards|scripts|bin|e2e|app|data)\/[A-Za-z0-9._/-]+\.(?:ts|tsx|mjs|cjs|json|md|css)\b/g)) {
      add(m[0], m.index, "src");
    }

    for (const { target, index, kind } of refs.values()) {
      if (existsInRepo(target) || allowed.has(target)) continue;
      // 目录形式的链接（`docs/`）也算数
      try {
        if (fs.statSync(path.join(ROOT, target)).isDirectory()) continue;
      } catch {
        /* 往下报 */
      }
      report(
        "doc-links",
        `${rel}:${lineOfIndex(text, index)}`,
        `指向 \`${target}\`，但这个文件不在仓库里${kind === "src" ? "（注释里的指路同样会被人照着找）" : ""}`,
        "把路径改成真实存在的文件；如果被指的内容已经不在本仓，就地把那句话写成自解释的说明，别留一个查不到的指针",
      );
    }
  }
}

/* ── 4. 卡片包完整性 ──────────────────────────────── */

/**
 * 这条最值钱，因为「加一种卡片包」是这个仓库最常见的改动，而它每一次都可能重犯同一个坑：
 * **规格卡（data）在阅读模式下一片空白**——正文在 `card.data.fields` 而不是 `card.content`，
 * 包里没写 `FullView`，横切的阅读模式就走通用兜底，显示「还没有正文」。
 * 只有点开那一种卡才看得见，测试与 typecheck 全绿。
 *
 * 判定方式是**读文件文本**而不是真的加载模块：这份脚本要在没构建产物、没装浏览器的情况下
 * 秒级跑完，为此接受「文本判断」的粗糙——宁可漏报也不误报（正则都要求匹配到具体形状）。
 */
const PACK_FILES = { required: ["meta.ts", "schema.ts", "ui.tsx", "skill.md"], optional: ["export.ts"] };

/**
 * FullView 豁免名单：**只有「专属字段不承载正文」的包**才能在这里。
 * 判定标准是一句话——「这张卡的正文是不是躺在 card.content 里」。是，通用兜底就够。
 */
const FULLVIEW_EXEMPT = {
  // 目前没有豁免项。text 卡 fieldKey 为 null，本来就不在检查范围内。
};

function checkCardPacks() {
  const packDirs = fs
    .readdirSync(path.join(ROOT, "cards"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const serverRegistry = readText("lib/card-registry.ts") || "";
  const clientRegistry = readText("lib/card-registry-client.ts") || "";
  const metaRegistry = readText("lib/card-metas.ts") || "";
  const toolbarSlots = new Map(); // `${group}` → Map<order, type>

  for (const type of packDirs) {
    const where = `cards/${type}/`;

    // ① 四件套齐全
    for (const name of PACK_FILES.required) {
      if (!existsInRepo(`cards/${type}/${name}`)) {
        report(
          "card-packs",
          `${where}${name}`,
          `卡片包缺少必备文件 \`${name}\`（四件套：${PACK_FILES.required.join(" / ")}；export.ts 可缺省）`,
          `照 AGENTS.md「加一种卡片包」补上；skill.md 缺了不会报错，但 \`/api/skill\` 里这类卡就没有任何说明`,
        );
      }
    }

    const metaText = readText(`cards/${type}/meta.ts`);
    const uiText = readText(`cards/${type}/ui.tsx`);
    if (metaText === null) continue;

    // ② meta.type 与目录名一致
    const declaredType = /^\s*type:\s*"([^"]+)"/m.exec(metaText)?.[1];
    if (declaredType !== type) {
      report(
        "card-packs",
        `${where}meta.ts`,
        `meta.type 是 \`${declaredType ?? "(没解析到)"}\`，与目录名 \`${type}\` 不一致`,
        "两者必须相同：注册表、信封白名单、卡片包开关都按目录名找包，按 meta.type 落库，不一致时表现是「建得出卡但开关管不到它」",
      );
    }

    // ③ 两份注册表都注册了它（少一处的表现各不相同：服务端少 = 归一化丢字段，客户端少 = 卡面空白）
    for (const [file, text, what] of [
      ["lib/card-registry.ts", serverRegistry, "服务端（meta + schema + export）"],
      ["lib/card-registry-client.ts", clientRegistry, "客户端（meta + ui）"],
      ["lib/card-metas.ts", metaRegistry, "meta 注册表（前后端共用）"],
    ]) {
      const imported = text.includes(`@/cards/${type}/`);
      // 两种写法都算注册：`text: { ... }` 与 ES 简写 `text,`（card-metas.ts 用的是后者）
      const keyed = new RegExp(`^\\s*${type}\\s*[,:]`, "m").test(text);
      if (!imported || !keyed) {
        report(
          "card-packs",
          file,
          `${what}里没有注册卡片包 \`${type}\`（import ${imported ? "有" : "缺"} / 键 ${keyed ? "有" : "缺"}）`,
          `在 ${file} 里补上 import 与记录项；三份注册表少任何一处，这个包的行为都会缺一半`,
        );
      }
    }

    // ④ 工具条分组：group ∈ 1..4，同组内 order 不重复
    if (uiText !== null) {
      const toolbar = /toolbar:\s*\{[\s\S]*?\n\s*\}/.exec(uiText)?.[0];
      if (toolbar) {
        const group = Number(/\bgroup:\s*(\d+)/.exec(toolbar)?.[1]);
        const order = Number(/\border:\s*(\d+)/.exec(toolbar)?.[1]);
        if (!(group >= 1 && group <= 4)) {
          report(
            "card-packs",
            `${where}ui.tsx`,
            `toolbar.group 是 \`${group}\`，合法值只有 1..4（1 基础·写 / 2 表达·画与结构 / 3 组织与结构化 / 4 外部来源）`,
            "改成 1-4 之一；分组口径见 lib/card-pack-client.ts 的 CardToolbarSpec 注释",
          );
        } else {
          const slots = toolbarSlots.get(group) || new Map();
          if (slots.has(order)) {
            report(
              "card-packs",
              `${where}ui.tsx`,
              `工具条第 ${group} 组的 order=${order} 已经被 \`${slots.get(order)}\` 占了`,
              "同组内 order 必须唯一：撞号时按钮先后顺序取决于注册表遍历次序，改注册表就会莫名其妙换位置",
            );
          } else {
            slots.set(order, type);
            toolbarSlots.set(group, slots);
          }
        }
      }
    }

    // ⑤ 有专属字段就必须有 FullView（第 5 号事故）
    const fieldKey = /^\s*fieldKey:\s*(null|"([^"]+)")/m.exec(metaText);
    const hasField = Boolean(fieldKey && fieldKey[1] !== "null");
    if (hasField && uiText !== null && !FULLVIEW_EXEMPT[type]) {
      // 只认「ui 对象里的 FullView 槽位」这一种形状：`FullView(` 方法简写或 `FullView:` 属性。
      // 注释里提到 FullView（text 卡就写着「缺省 FullView」）不算数——那正是当年漏掉的原因。
      const stripped = uiText.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (!/^\s{0,4}FullView\s*[:(]/m.test(stripped)) {
        report(
          "card-packs",
          `${where}ui.tsx`,
          `声明了专属字段 \`meta.fieldKey = "${fieldKey[2]}"\`，但 ui 里没有 FullView——这类卡的正文不在 card.content 里，阅读模式 / 对比 / 大纲会走通用兜底，摊开就是「还没有正文」的空白`,
          "在 ui 对象里补一个 FullView 槽位渲染专属字段；确实不需要（正文本来就在 content 里）的话，把这个 type 加进本文件的 FULLVIEW_EXEMPT 并写清理由",
        );
      }
    }
  }
}

/* ── 5. env 对账 ──────────────────────────────────── */

/**
 * 防的是「README 的环境变量表与代码漂移」：加了个 env 忘了写进表，用户翻遍文档也不知道有这个开关；
 * 或者删了个 env 表里还留着，用户配了半天没反应。两个方向都要报。
 *
 * 只管本项目自己的命名空间（BLOTBOARD_* / GOAL_AGENT_* / AIDOCS_URL / BOOK_LIBRARY_URL）；
 * 测试脚手架（scripts/ e2e/ playwright.config.ts）读的 E2E_* / SMOKE_* 不是对用户的承诺，不入表。
 */
const ENV_NAMESPACE = /^(?:BLOTBOARD_|GOAL_AGENT_|AIDOCS_URL$|BOOK_LIBRARY_URL$)/;

function checkEnvDocs() {
  const codeFiles = TEXT_FILES.filter(
    (rel) =>
      /\.(ts|tsx|mjs|cjs)$/.test(rel) &&
      !rel.startsWith("scripts/") &&
      !rel.startsWith("e2e/") &&
      rel !== "playwright.config.ts",
  );
  /** env 名 → 第一次出现的「文件:行号」 */
  const used = new Map();
  for (const rel of codeFiles) {
    const text = readText(rel);
    if (text === null) continue;
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      if (!ENV_NAMESPACE.test(m[1]) || used.has(m[1])) continue;
      used.set(m[1], `${rel}:${lineOfIndex(text, m.index)}`);
    }
  }

  const readme = readText("README.md") || "";
  const documented = new Set(
    [...readme.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]).filter((name) => ENV_NAMESPACE.test(name)),
  );

  for (const [name, where] of used) {
    if (documented.has(name)) continue;
    report(
      "env-docs",
      where,
      `代码里读了环境变量 \`${name}\`，但 README 的环境变量表里没有它`,
      "在 README「环境变量（全部可选）」表里补一行（变量 / 默认值 / 说明）；不打算对用户公开的开关就别放进 BLOTBOARD_ 命名空间",
    );
  }
  for (const name of documented) {
    if (used.has(name)) continue;
    report(
      "env-docs",
      "README.md",
      `README 里写着环境变量 \`${name}\`，但代码里没有任何地方读它`,
      "删掉这一行，或者补上读它的代码——文档里躺着一个不生效的开关，用户会配了它然后怀疑是自己弄错了",
    );
  }
}

/* ── 6. CSS 变量 ──────────────────────────────────── */

/**
 * 写了不存在的变量，CSS 会**静默**退成「无背景 / 无颜色」——浮层背景变透明就是这么来的，
 * 没有报错、只有肉眼能看出来。
 *
 * 与 smoke 里同名用例**有意共存**：smoke 那条是「起了服务之后顺手再验一遍」，
 * 这条是不起服务、秒级、`npm run check` 第一步就能挡住。两处都留的代价只是几行重复，
 * 收益是「只跑了其中一条命令」的人也不会漏掉这个坑。
 * 而且这条比 smoke 那条**多管一层**：组件里内联 style 写的 `var(--x)` 也要在 globals.css 里存在。
 */
function checkCssVars() {
  const css = readText("app/globals.css");
  if (css === null) return;
  const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  // 运行时由内联 style 注入的（见 CardNode / CompareModal），静态文件里当然找不到
  defined.add("--card-accent");

  const scan = (rel, text, extraDefined) => {
    const known = extraDefined ? new Set([...defined, ...extraDefined]) : defined;
    for (const m of text.matchAll(/var\((--[a-z0-9-]+)\s*(?!,)\)/g)) {
      if (known.has(m[1])) continue;
      report(
        "css-vars",
        `${rel}:${lineOfIndex(text, m.index)}`,
        `用了 CSS 变量 \`${m[1]}\`，但它既没有定义也没给兜底值——CSS 对无效值是静默回退，表现是「背景没了 / 颜色不对」，不会有任何报错`,
        `在 app/globals.css 的 \`:root\` 里定义它，或者写成 \`var(${m[1]}, <兜底值>)\``,
      );
    }
  };

  scan("app/globals.css", css);
  // 组件 / 卡片包里内联 style 引用的变量，同样得在 globals.css 里存在
  for (const rel of TEXT_FILES.filter((f) => /\.tsx$/.test(f))) {
    const text = readText(rel);
    if (text !== null) scan(rel, text);
  }
  // 导出的单文件 HTML 自带一份样式表，它有自己的 :root——按**文件内部**自洽来判
  const exportHtml = readText("lib/export-html.ts");
  if (exportHtml !== null) {
    const own = new Set([...exportHtml.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    scan("lib/export-html.ts", exportHtml, own);
  }
}

/* ── 7. 构建期陷阱 ────────────────────────────────── */

/**
 * 防的是这次：画板页曾经是 `force-static`，于是**构建那一刻的 env 被烤进了 HTML 产物**——
 * 用户改完 pm2 配置重启，页面上的功能开关还是旧的，看起来像缓存没清，实际是产物里就是旧值。
 *
 * 判定口径（保守，宁可少报）：
 *  · `app/**\/page.tsx` 一律要求 force-dynamic —— 根布局 app/layout.tsx 直接读 lib/config +
 *    lib/features 往 `<body data-*>` 上下发运行时开关，任何一个页面被静态化，那份下发就跟着被烤住；
 *  · `app/api/**\/route.ts` 只在「自己或其本地依赖闭包碰了 lib/config / lib/features / process.env」时要求；
 *  · 显式写了 `force-static` 且落在上面两类里的，报得更重（这正是当年那个 bug 的原形）。
 * 依赖闭包只跟本仓库内的相对 / `@/` import 走，不解析 node_modules（第三方不读我们的 env）。
 */
function resolveImport(fromRel, spec) {
  let base;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith("./") || spec.startsWith("../")) base = path.posix.normalize(path.posix.join(path.dirname(fromRel), spec));
  else return null; // 裸包名：node_modules，不跟
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsInRepo(candidate)) return candidate;
  }
  return null;
}

function importClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const text = readText(rel);
    if (text === null) continue;
    for (const m of text.matchAll(/(?:^|\n)\s*import[\s\S]{0,400}?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
      const resolved = resolveImport(rel, m[1] || m[2]);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

function checkBuildTimeEnv() {
  const entries = FILES.filter((rel) => /^app\/.*\/(page\.tsx|route\.ts)$/.test(rel) || /^app\/(page\.tsx|route\.ts)$/.test(rel));
  for (const rel of entries) {
    const text = readText(rel);
    if (text === null) continue;
    const isPage = rel.endsWith("page.tsx");
    const declared = /export\s+const\s+dynamic\s*=\s*["']([a-z-]+)["']/.exec(text)?.[1] || null;

    let reason = null;
    if (isPage) {
      reason = "根布局 app/layout.tsx 直接读 lib/config + lib/features，把运行时开关下发到 `<body data-*>`；页面一旦被静态化，这份下发就是构建那一刻的快照";
    } else {
      const closure = importClosure(rel);
      const touches = [...closure].some((f) => f === "lib/config.ts" || f === "lib/features.ts") || /process\.env\./.test(text);
      if (touches) reason = "这条路由（或它的本地依赖）读了运行时环境变量";
    }
    if (!reason) continue;

    if (declared === "force-static") {
      report(
        "build-time-env",
        `${rel}:${lineOfIndex(text, text.indexOf("force-static"))}`,
        `声明了 \`dynamic = "force-static"\`，但${reason}——env 会被烤进构建产物，改配置重启后不生效，表现像是「缓存没清」`,
        '改成 `export const dynamic = "force-dynamic"`',
      );
    } else if (declared !== "force-dynamic") {
      report(
        "build-time-env",
        rel,
        `没有声明 \`export const dynamic\`，而${reason}——Next 会按自己的推断决定静不静态化，env 有可能被烤进产物`,
        '在文件顶部显式写上 `export const dynamic = "force-dynamic"`（本仓库所有页面与路由都是这个口径）',
      );
    }
  }
}

/* ── 8. 工作区外来物（未跟踪且未忽略的东西） ────────── */

/**
 * `git status` 里那些 `??` 的东西。
 *
 * 为什么值得单开一条：这个仓库真的踩过——仓库根上长期躺着几个**跟项目无关的个人目录**
 * （一份 26 MB 的画板迁移备份、一份带 `sk-` 样式串的用量分析、两个临时探针脚本）。
 * 它们不在 git 里，所以前七条检查（扫描范围 = 受版本控制的文件）一条都看不见它们；
 * 而它们离「进公开仓库」只差一个手滑的 `git add -A`。
 *
 * 判据只有一条：**要么进 git，要么进 .gitignore，不许两头不靠**。
 *  - 是项目的产物 / 缓存 → 写进 .gitignore（迁移备份目录、临时探针脚本都已经在里面了）；
 *  - 是项目的文件 → `git add` 它；
 *  - 都不是（放错地方的个人文件）→ 挪出仓库。
 *
 * 只看**仓库根的第一层**：子目录里的未跟踪文件多半是正在写的新代码，
 * 报出来只会变成天天要按掉的噪音；而「误提交整个目录」这个事故恰恰都发生在根上。
 */
function checkStrayFiles() {
  let lines;
  try {
    lines = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    })
      .toString("utf8")
      .split("\n");
  } catch {
    return; // 不是 git 仓库（源码包解压出来的场景）：这条检查天然不适用
  }
  for (const line of lines) {
    if (!line.startsWith("?? ")) continue;
    // 名字里有空格 / 非 ASCII 时 git 会加引号并转义，形状正好是 JSON 字符串
    let name = line.slice(3).trim();
    if (name.startsWith('"') && name.endsWith('"')) {
      try {
        name = JSON.parse(name);
      } catch {
        /* 解不开就原样用 */
      }
    }
    // git 对整个未跟踪目录只报一行 `dir/`，所以去掉尾斜杠就是仓库根的第一层名字；
    // 带更深路径的（`sub/new-file.ts`）是子目录里的新文件，不在这条检查的范围内
    const top = name.replace(/\/+$/, "");
    if (!top || top.includes("/")) continue;
    report(
      "stray-files",
      top,
      "仓库根上有个既没进 git、也没被 .gitignore 忽略的东西——它离「被一个 `git add -A` 带进公开仓库」只差一步（这个仓库真的这么躺过一份 26 MB 的画板备份，和一份带密钥样式串的分析目录）",
      "三选一：是项目产物就写进 `.gitignore`；是项目文件就 `git add` 它；是放错地方的个人文件就挪出仓库",
    );
  }
}

/* ── 10. skill focus 漂移 ─────────────────────────── */

/**
 * 防的是这类事故：文档 / 生成模板里写着 `?focus=layout`，而 `SKILL_FOCUS` 里根本没有
 * `layout` 这个值——服务端老老实实回 400，照着文档做的 agent 却只看到「这台部署坏了」。
 * 本轮审计就是这么发现一份外部桥接 Skill 推荐了 `focus=layout` 的（那台服务把整理
 * 归在 `api` 那节）。仓库自己的文档与生成模板不能再往外播这种值。
 *
 * 口径：扫所有文本文件里**字面量**形式的 `focus=a,b,c`，逐个值对 `lib/skill.ts` 的
 * `SKILL_FOCUS` 校验（只认字母与逗号，所以 `focus=${...}` 这种运行时拼的天然不在范围内）。
 * 故意打错来测 400 的用例走白名单显式豁免，不靠猜。
 */
const FOCUS_DRIFT_ALLOW = new Set([
  // 故意写错的值，用来断言「不认识的 focus 要 400 并列出合法值」
  "scripts/smoke-api.mjs:nope",
  "e2e/agent-onboarding.spec.ts:invalid",
  // 断言「400 之外还得指路」的两条反例：按活分的 focus 里没有 layout；单复数写错也要给出正确的那个
  "scripts/smoke-api.mjs:layout",
  "scripts/smoke-api.mjs:card",
]);

function checkSkillFocus() {
  const skill = readText("lib/skill.ts");
  if (!skill) return;
  const declared = /export const SKILL_FOCUS = \[([^\]]*)\]/.exec(skill);
  if (!declared) {
    report(
      "skill-focus",
      "lib/skill.ts",
      "找不到 SKILL_FOCUS 的字面量声明，这条检查失去了真源",
      "要么保持 `export const SKILL_FOCUS = [...] as const` 这个形状，要么同步改这里的解析",
    );
    return;
  }
  const legal = new Set([...declared[1].matchAll(/"([a-z]+)"/g)].map((match) => match[1]));
  if (!legal.size) return;
  for (const rel of TEXT_FILES) {
    // 真源自己不算：它列的就是合法值
    if (rel === "lib/skill.ts" || rel === "scripts/lint-repo.mjs") continue;
    const text = readText(rel);
    if (!text) continue;
    for (const match of text.matchAll(/focus=([A-Za-z,]+)/g)) {
      for (const value of match[1].split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)) {
        if (legal.has(value)) continue;
        if (FOCUS_DRIFT_ALLOW.has(`${rel}:${value}`)) continue;
        report(
          "skill-focus",
          `${rel}:${lineOfIndex(text, match.index)}`,
          `\`focus=${value}\` 不是 SKILL_FOCUS 里的值——/api/skill 会回 400，照这份文档做的 agent 会以为部署坏了`,
          `改成合法值之一（${[...legal].join(" / ")}）；如果想说的是「整理 / 布局」那类活，它在 \`api\` 那节，模式清单在 /api/capabilities 的 layouts。确实是反例就加进本文件的 FOCUS_DRIFT_ALLOW 并写明理由`,
        );
      }
    }
  }
}

/* ── 跑 ───────────────────────────────────────────── */

const CHECKS = [
  { id: "9", name: "source-release", label: "源码发布边界（只允许代码与内置资产，拒绝私有运行数据）", run: () => {
    for (const file of FILES) {
      if (!sourcePathAllowed(file)) report("source-release", file, "不属于可发布源码的文件", "移出版本控制，保留在本机忽略目录中");
      else if (fs.existsSync(path.join(ROOT, file)) && fs.lstatSync(path.join(ROOT, file)).isSymbolicLink()) report("source-release", file, "源码包中的符号链接可能指向工作区外的私人文件", "用实际项目源码替代符号链接");
    }
  } },
  { id: "1", name: "binary-invisible", label: "grep 不可见的源文件（裸 NUL / 控制字符）", run: checkBinaryInvisible },
  { id: "2", name: "private-traces", label: "私有痕迹（本机路径 / 私有端口 / 工单号 / 身份串）", run: checkPrivateTraces },
  { id: "3", name: "doc-links", label: "文档与注释里的仓库内引用", run: checkDocLinks },
  { id: "4", name: "card-packs", label: "卡片包完整性（四件套 / 注册表 / 工具条 / FullView）", run: checkCardPacks },
  { id: "5", name: "env-docs", label: "环境变量与 README 对账", run: checkEnvDocs },
  { id: "6", name: "css-vars", label: "CSS 变量（用了没定义也没兜底的）", run: checkCssVars },
  { id: "7", name: "build-time-env", label: "构建期 env 陷阱（页面 / 路由必须 force-dynamic）", run: checkBuildTimeEnv },
  { id: "8", name: "stray-files", label: "工作区外来物（仓库根上既没进 git 也没被忽略的东西）", run: checkStrayFiles },
  { id: "10", name: "skill-focus", label: "skill focus 漂移（文档 / 模板里的 ?focus= 必须是 SKILL_FOCUS 里的值）", run: checkSkillFocus },
];

const onlyArg = (() => {
  const index = process.argv.indexOf("--only");
  return index >= 0 ? String(process.argv[index + 1] || "").split(",").map((s) => s.trim()).filter(Boolean) : null;
})();

const started = Date.now();
console.log(bold("仓库体检 lint:repo") + dim(`  ·  ${FILES.length} 个受版本控制的文件`));
for (const check of CHECKS) {
  if (onlyArg && !onlyArg.includes(check.id) && !onlyArg.includes(check.name)) continue;
  const before = problems.length;
  check.run();
  const found = problems.length - before;
  const mark = found ? redText("✗") : greenText("✓");
  console.log(`  ${mark} ${check.id}. ${check.label}${found ? redText(`  ${found} 处`) : ""}`);
}

if (problems.length) {
  console.log("");
  const byCheck = new Map();
  for (const item of problems) byCheck.set(item.check, [...(byCheck.get(item.check) || []), item]);
  for (const [check, items] of byCheck) {
    console.log(redText(bold(`【${check}】${items.length} 处`)));
    for (const item of items) {
      console.log(`  ${bold(item.where)}`);
      console.log(`    ${dim("为什么：")}${item.why}`);
      console.log(`    ${dim("怎么改：")}${item.how}`);
    }
    console.log("");
  }
  console.log(redText(`体检不通过：共 ${problems.length} 处`) + dim(`  ·  ${Date.now() - started}ms`));
  process.exit(1);
}

console.log(greenText(`\n体检通过` ) + dim(`  ·  ${Date.now() - started}ms`));

/**
 * 运行时配置：全部可用环境变量覆盖，默认值面向本机开发。
 *
 * 数据归属红线：画板数据（boards/uploads）在本项目 data/ 下自管；
 * Issue/任务/会话的真源永远是 Goal Agent，本服务只保存引用 id。
 */
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { DEFAULT_HTML_ALLOW, parseAllowSpec, type EmbedRule } from "./embed-allow";

export const PROJECT_ROOT = process.env.BLOTBOARD_ROOT
  ? path.resolve(process.env.BLOTBOARD_ROOT)
  : process.cwd();

export const DATA_DIR = process.env.BLOTBOARD_DATA_DIR
  ? path.resolve(process.env.BLOTBOARD_DATA_DIR)
  : path.join(PROJECT_ROOT, "data");

/**
 * 旧的单文件存储位置。现在只在首次启动迁移时读一次（迁完改名留底），
 * 环境变量名保持不变，冒烟/e2e 的数据隔离方式不用改。
 */
export const LEGACY_BOARDS_FILE = process.env.BLOTBOARD_DATA_FILE
  ? path.resolve(process.env.BLOTBOARD_DATA_FILE)
  : path.join(DATA_DIR, "boards.json");

/**
 * 现在的存储：一块板一个 JSON 文件，放在 `<旧文件名去掉 .json>/` 目录下
 * （默认 `data/boards/`）。见 lib/storage.ts 顶部注释。
 */
export const BOARDS_DIR = LEGACY_BOARDS_FILE.replace(/\.json$/i, "");

export const UPLOADS_DIR = process.env.BLOTBOARD_UPLOADS_DIR
  ? path.resolve(process.env.BLOTBOARD_UPLOADS_DIR)
  : path.join(DATA_DIR, "uploads");

/**
 * 音视频上传的单文件上限（MB）。图片 10 MB、PDF 20 MB 是写死的常量，音视频不行——
 * 一段几分钟的录屏就上百 MB，而这条上限同时是**磁盘用量的闸门**（上传件不会自动过期），
 * 所以留成 env：默认 200 MB，写坏了（负数 / 非数字）按默认走。
 */
export const MEDIA_MAX_BYTES = (() => {
  const raw = Number(process.env.BLOTBOARD_MEDIA_MAX_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : 200;
  return Math.round(mb * 1024 * 1024);
})();

/**
 * 自动快照目录（`<data>/checkpoints/<boardId>/<时间戳>-<原因>.json`，见 lib/checkpoints.ts）。
 *
 * 刻意**不**放在 BOARDS_DIR 里：storage 的目录扫描把 `b_*.json` 一律当成一块板，
 * 快照混进去会凭空多出一堆同 id 的板；分开放，两套机制互不知道对方存在。
 */
export const CHECKPOINTS_DIR = process.env.BLOTBOARD_CHECKPOINTS_DIR
  ? path.resolve(process.env.BLOTBOARD_CHECKPOINTS_DIR)
  : path.join(DATA_DIR, "checkpoints");

/**
 * 每块板保留几份自动快照（超出删最旧）。`0` = 整个功能关掉（不打点、列表恒空）。
 *
 * 默认 10：一次「agent 大改」通常连着几次批量写，10 份够倒回到动手之前，
 * 又不至于让一块 800 KB 的板拖出 8 MB 的历史。
 */
export const CHECKPOINT_KEEP = (() => {
  const raw = process.env.BLOTBOARD_CHECKPOINT_KEEP;
  if (raw === undefined || raw === "") return 10;
  const value = Number(raw);
  // 写坏了（负数 / 非数字）按默认走：安全网不该因为一个手滑的 env 就整个消失
  return Number.isInteger(value) && value >= 0 ? value : 10;
})();

/**
 * 信不信 `x-forwarded-host` / `x-forwarded-proto`（默认**不信**）。
 *
 * 这两个头决定「产物里回指画板的链接写成什么」——导出的 HTML / Markdown、
 * `/api/skill` 里给 agent 的 base。谁都能伪造它们：直连的客户端随手带一个
 * `x-forwarded-host: evil.example.com`，导出的文件里所有链接就都指向那台机器了。
 *
 * 只有**确实站在反向代理后面**时这两个头才有意义（那时是代理写的，客户端的会被它覆盖）。
 * 所以做成显式开关：`BLOTBOARD_TRUST_PROXY=1` 才信，否则一律用请求自己的 Host。
 */
export const TRUST_PROXY = process.env.BLOTBOARD_TRUST_PROXY === "1";

/**
 * 被删画板留下的快照目录，过了多少天才清（`0` = 永不清）。
 *
 * 为什么不删板就立刻清：那时候快照恰恰是最后一根稻草——把某份快照拷回
 * `<data>/boards/<id>.json` 就能把整块板捞回来，所以**故意留一段时间**。
 * 但只留不清就是纯泄漏：板早没了，谁也不会再往那个目录里写第二个字节，
 * `prune` 只在打点时触发，于是那几百 KB 会一直躺到手工发现为止。
 *
 * 默认 30 天：跨得过一次「删错了，过完假回来才想起来」；再久就该是有意备份，
 * 那种场景应该把快照文件拷走，而不是指望画板替你存着。
 */
export const CHECKPOINT_ORPHAN_TTL_DAYS = (() => {
  const raw = process.env.BLOTBOARD_CHECKPOINT_ORPHAN_TTL_DAYS;
  if (raw === undefined || raw === "") return 30;
  const value = Number(raw);
  // 跟 KEEP 一条口径：写坏了按默认走，不让一个手滑的 env 把「留一段时间」变成「立刻删」
  return Number.isFinite(value) && value >= 0 ? value : 30;
})();

/**
 * 内置模板目录。跟着**项目根**走而不是 DATA_DIR：模板是随仓库发布的资产（git 跟踪），
 * 换数据目录（冒烟测试、多实例）时不该跟着一起换到一个空目录去。
 */
export const TEMPLATES_DIR = process.env.BLOTBOARD_TEMPLATES_DIR
  ? path.resolve(process.env.BLOTBOARD_TEMPLATES_DIR)
  : path.join(PROJECT_ROOT, "data", "templates");

/**
 * 内置卡片规格目录。跟模板一样是**随仓库走的资产**，所以跟项目根走而不是 DATA_DIR。
 */
export const CARD_SPECS_DIR = process.env.BLOTBOARD_CARD_SPECS_DIR
  ? path.resolve(process.env.BLOTBOARD_CARD_SPECS_DIR)
  : path.join(PROJECT_ROOT, "data", "card-specs");

/**
 * 用户自定义卡片规格目录（跟 DATA_DIR 走：这是用户数据，不进 git）。
 * 规格中心里「新建规格」写到这里，同名 id 不允许覆盖内置规格。
 *
 * 目录名刻意不叫 card-specs：默认配置下 DATA_DIR 就是项目里的 data/，
 * 跟内置规格目录同名的话，用户自己建的规格会被当成内置规格（删不掉）。
 */
export const USER_CARD_SPECS_DIR = process.env.BLOTBOARD_USER_CARD_SPECS_DIR
  ? path.resolve(process.env.BLOTBOARD_USER_CARD_SPECS_DIR)
  : path.join(DATA_DIR, "my-card-specs");

/** 规格开关状态（哪些规格被停用了）。 */
export const CARD_SPEC_STATE_FILE = process.env.BLOTBOARD_CARD_SPEC_STATE_FILE
  ? path.resolve(process.env.BLOTBOARD_CARD_SPEC_STATE_FILE)
  : path.join(DATA_DIR, "card-spec-state.json");

/** 卡片包开关状态（20 个原生包哪些启用；首次生成规则见 lib/card-pack-store.ts）。 */
export const CARD_PACKS_FILE = process.env.BLOTBOARD_CARD_PACKS_FILE
  ? path.resolve(process.env.BLOTBOARD_CARD_PACKS_FILE)
  : path.join(DATA_DIR, "card-packs.json");

/*
 * 三个外部服务：**显式配置才启用**（未设置 = 空串 = 对应功能整体关闭，入口不渲染）。
 *
 * 以前默认指向作者本机那几个服务的端口，开源用户没有这些服务，
 * 按钮照常显示、点了才报错——现在把「有没有这个功能」收敛为「有没有配这个 env」，
 * 服务端唯一真源见 lib/features.ts。本机全功能实例在 ecosystem.config.cjs 里显式配。
 */

/**
 * 任务后端三选一（docs/RUNNER.md），优先级从上到下：
 *  1. BLOTBOARD_RUNNER_URL —— 通用 http 后端：任何按 RUNNER.md 协议实现的服务；
 *  2. GOAL_AGENT_RUNNER_URL —— Goal Agent（http 协议的特例，只是 token 来源不同）；
 *  3. 都没配 = **local**：Issue 落本地 issues.json，「发起任务」生成完整 prompt 供复制。
 * 任务功能因此永远可用（features.tasks 恒为 true），差别只在后端种类。
 */
export const RUNNER_URL = process.env.GOAL_AGENT_RUNNER_URL || "";
export const HTTP_RUNNER_URL = process.env.BLOTBOARD_RUNNER_URL || "";
/** http 后端的 token；不配就退回画板自己的内部 token（对端与画板共用一份时最省事）。 */
export const HTTP_RUNNER_TOKEN = process.env.BLOTBOARD_RUNNER_TOKEN || "";

/** local 任务后端的 Issue 存储（跟 DATA_DIR 走：这是用户数据）。 */
export const ISSUES_FILE = process.env.BLOTBOARD_ISSUES_FILE
  ? path.resolve(process.env.BLOTBOARD_ISSUES_FILE)
  : path.join(DATA_DIR, "issues.json");

/**
 * Runner 设置（ACP agent 注册表 + 权限档位，docs/RUNNER.md §4）。
 * 跟 DATA_DIR 走：里面可能有 agent 的 env（API key 之类），属于用户数据、不进 git。
 */
export const RUNNER_SETTINGS_FILE = process.env.BLOTBOARD_RUNNER_SETTINGS_FILE
  ? path.resolve(process.env.BLOTBOARD_RUNNER_SETTINGS_FILE)
  : path.join(DATA_DIR, "runner-settings.json");

/**
 * ACP run 的流式 transcript（一 run 一个 .jsonl，逐条 append）。
 * 不塞进 issues.json：transcript 是只增的流水，跟着单文件 JSON 全量读写会把它拖垮。
 */
export const RUNS_DIR = process.env.BLOTBOARD_RUNS_DIR
  ? path.resolve(process.env.BLOTBOARD_RUNS_DIR)
  : path.join(DATA_DIR, "runs");

/**
 * agent 没配 cwd 时的默认工作目录。刻意不用 process.cwd()（那是画板自己的仓库，
 * agent 在里面乱写等于自伤）；要让 agent 改某个仓库时，把该 agent 的 cwd 配到那个仓库。
 */
export const ACP_WORKSPACE_DIR = path.join(DATA_DIR, "acp-workspace");

/** 知识库（资料卡片的检索来源）。未配置 = 资料卡检索关闭。 */
export const AIDOCS_URL = process.env.AIDOCS_URL || "";

/** 本机书库索引（图书卡的来源：封面 / 在线读 / PDF 都在那儿）。未配置 = 图书卡入口关闭。 */
export const BOOK_LIBRARY_URL = process.env.BOOK_LIBRARY_URL || "";

/**
 * HTML 嵌入卡能嵌哪些域（逗号分隔；`@private` = 本机/私网/Tailscale，`@none` = 整张卡关掉）。
 * 规则语法与匹配逻辑见 lib/embed-allow.ts —— 那份是纯逻辑，前端也用同一套做输入提示。
 */
export const HTML_EMBED_ALLOW_SPEC = process.env.BLOTBOARD_HTML_ALLOW || DEFAULT_HTML_ALLOW;
export const HTML_EMBED_RULES: EmbedRule[] = parseAllowSpec(HTML_EMBED_ALLOW_SPEC);

/** Goal Agent 主界面（任务详情「在主界面查看」跳转用）。未配置 = 不渲染跳转链接。 */
export const GOAL_AGENT_WEB_URL = process.env.GOAL_AGENT_WEB_URL || "";

/** 本服务对外地址（agent 指令模板里写给 agent 的 base）。 */
export const PORT = Number(process.env.BLOTBOARD_PORT || 8567);
export const HOST = process.env.BLOTBOARD_HOST || "127.0.0.1";
export const PUBLIC_URL = process.env.BLOTBOARD_PUBLIC_URL || `http://127.0.0.1:${PORT}`;

/**
 * agent 写操作用的内部 token（请求头 x-auth-key），三级来源，前者优先：
 *  1. env `BLOTBOARD_INTERNAL_TOKEN` —— 显式指定，容器 / CI 最直接；
 *  2. env `BLOTBOARD_GOAL_AGENT_SETTINGS` —— 本机同时部署了 Goal Agent、想跟它共用一份
 *     token 时指向其 settings.json（读 internalApiToken；同一个 x-auth-key 既能调 Runner
 *     也能调画板，agent 侧零新概念）；
 *  3. 都没配就**自管**：`<DATA_DIR>/token`，首次启动不存在时自动生成并打印提示。
 * 开源版默认走第 3 级——画板不该依赖别的项目的配置文件才能起来。
 */
export const GOAL_AGENT_SETTINGS_FILE = process.env.BLOTBOARD_GOAL_AGENT_SETTINGS
  ? path.resolve(process.env.BLOTBOARD_GOAL_AGENT_SETTINGS)
  : null;

export const TOKEN_FILE = path.join(DATA_DIR, "token");

let tokenCache: { file: string; mtime: number | null; token: string } | null = null;

/** mtime 守卫缓存：文件没变就不重读（画板轮询频率高，每个请求都要过鉴权）。 */
function readTokenFileCached(file: string, parse: (raw: string) => string): string {
  let mtime: number | null = null;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    /* 文件不存在时下面统一抛 */
  }
  if (mtime !== null && tokenCache && tokenCache.file === file && tokenCache.mtime === mtime) {
    return tokenCache.token;
  }
  const token = parse(fs.readFileSync(file, "utf8"));
  if (!token) throw new Error(`${file} 里没有可用 token`);
  tokenCache = { file, mtime, token };
  return token;
}

export function readInternalToken(): string {
  if (process.env.BLOTBOARD_INTERNAL_TOKEN) return process.env.BLOTBOARD_INTERNAL_TOKEN;
  if (GOAL_AGENT_SETTINGS_FILE) {
    return readTokenFileCached(GOAL_AGENT_SETTINGS_FILE, (raw) => String(JSON.parse(raw).internalApiToken || ""));
  }
  try {
    return readTokenFileCached(TOKEN_FILE, (raw) => raw.trim());
  } catch {
    /* 不存在（或空）→ 首启自动生成 */
  }
  const token = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  // 0600：token 只该本用户可读；agent 要用时自己 cat 这个文件
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  console.log(`[blotboard] 已生成 agent token：${TOKEN_FILE}（写 API 请求头 x-auth-key 用它）`);
  tokenCache = { file: TOKEN_FILE, mtime: fs.statSync(TOKEN_FILE).mtimeMs, token };
  return token;
}

export function tryReadInternalToken(): string | null {
  try {
    return readInternalToken();
  } catch {
    return null;
  }
}

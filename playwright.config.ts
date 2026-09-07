import { defineConfig, devices } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { E2E_AIDOCS_URL, E2E_BOOK_LIBRARY_URL, E2E_GOAL_AGENT_WEB_URL } from "./e2e/integrations";

/**
 * E2E 用独立的临时数据目录 + mock Runner（e2e/mock-runner.mjs），
 * 绝不碰 data/ 里的真实画板。
 */
const PORT = Number(process.env.E2E_PORT || 8441);
const RUNNER_PORT = Number(process.env.E2E_RUNNER_PORT || 8442);
/**
 * 第二个实例：**local 任务后端**（不配任何 Runner env）。
 * Runner 设置区的表单只在 local 形态下可编辑（goal-agent 形态显示「由外部 Runner 接管」），
 * 两种形态都要有 e2e 覆盖，所以并排跑两个服务；测试里用绝对地址访问这台。
 */
const LOCAL_PORT = Number(process.env.E2E_LOCAL_PORT || 8443);
const dataDir = process.env.E2E_DATA_DIR || path.join(os.tmpdir(), "blotboard-e2e");
const localDataDir = `${dataDir}-local`;
const settingsFile = path.join(dataDir, "settings.json");

fs.mkdirSync(dataDir, { recursive: true });
// 存储是一板一文件（data/boards/），旧的单文件也一起清掉，免得每轮又被迁移出来
fs.rmSync(path.join(dataDir, "boards"), { recursive: true, force: true });
fs.rmSync(path.join(dataDir, "boards.json"), { force: true });
fs.rmSync(path.join(dataDir, "agent-commands.json"), { force: true });
// 规格开关是用户数据：不清掉的话，上一次跑里被停用的规格会带到下一次
fs.rmSync(path.join(dataDir, "card-spec-state.json"), { force: true });
fs.rmSync(path.join(dataDir, "my-card-specs"), { force: true, recursive: true });
// 卡片包开关同理；e2e 覆盖的是「全类型可用」的形态，全部包打开
// （首次生成的精简默认集、以及「老文件里没有的新包按 defaultEnabled」由 smoke 覆盖）
const allCardTypes = ["text", "task", "link", "quote", "image", "pdf", "ref", "board", "mindmap", "todo", "svg", "mermaid", "excalidraw", "data", "book", "html", "code", "table", "chart", "frame"];
fs.writeFileSync(
  path.join(dataDir, "card-packs.json"),
  JSON.stringify({ version: "1", enabled: Object.fromEntries(allCardTypes.map((type) => [type, true])) }, null, 2),
);
fs.writeFileSync(settingsFile, JSON.stringify({ internalApiToken: "e2e-token" }));

// local 实例的数据也每轮清干净：Runner 设置的 agent 列表要从空白开始才能断言增删
fs.mkdirSync(localDataDir, { recursive: true });
fs.rmSync(path.join(localDataDir, "boards"), { recursive: true, force: true });
fs.rmSync(path.join(localDataDir, "boards.json"), { force: true });
fs.rmSync(path.join(localDataDir, "issues.json"), { force: true });
fs.rmSync(path.join(localDataDir, "runner-settings.json"), { force: true });
fs.rmSync(path.join(localDataDir, "runs"), { recursive: true, force: true });

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "line" : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    /**
     * 钉死浏览器语言：界面是中英双语的，没选过语言时服务端按 `Accept-Language` 猜一次，
     * 而 Chromium 默认发的是 en-US——不钉的话整个套件跑成英文界面，
     * 而这里几乎每条断言都是按**可见中文**取元素的。
     * 英文那条路由单独有用例覆盖（board.spec 的「界面语言」一节）。
     */
    locale: "zh-CN",
  },
  webServer: [
    {
      command: `node e2e/mock-runner.mjs ${RUNNER_PORT}`,
      port: RUNNER_PORT,
      reuseExistingServer: false,
      stdout: "ignore",
    },
    {
      command: "node server.mjs",
      port: PORT,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      env: {
        NODE_ENV: "production",
        BLOTBOARD_PORT: String(PORT),
        // 端口是这里挑的，被占就该当场报错，别让服务悄悄顺延到别处（断言会打在空处）
        BLOTBOARD_PORT_STRICT: "1",
        BLOTBOARD_HOST: "127.0.0.1",
        BLOTBOARD_DATA_DIR: dataDir,
        BLOTBOARD_DATA_FILE: path.join(dataDir, "boards.json"),
        BLOTBOARD_UPLOADS_DIR: path.join(dataDir, "uploads"),
        BLOTBOARD_AGENT_COMMANDS_FILE: path.join(dataDir, "agent-commands.json"),
        GOAL_AGENT_RUNNER_URL: `http://127.0.0.1:${RUNNER_PORT}`,
        // 通用 http 后端优先级更高：显式清空，防外层 shell 环境把后端换掉
        BLOTBOARD_RUNNER_URL: "",
        // 三个可选集成显式打开：e2e 覆盖的是「配置了」的形态（跨服务链接的 host 拼对、
        // 入口可见）；隐藏形态由 smoke 的无 env 实例覆盖。地址默认指向本机空端口——
        // 服务不必活着，真要回源的用例自己 mock（见 e2e/integrations.ts）
        GOAL_AGENT_WEB_URL: E2E_GOAL_AGENT_WEB_URL,
        AIDOCS_URL: E2E_AIDOCS_URL,
        BOOK_LIBRARY_URL: E2E_BOOK_LIBRARY_URL,
        BLOTBOARD_GOAL_AGENT_SETTINGS: settingsFile,
      },
    },
    {
      command: "node server.mjs",
      port: LOCAL_PORT,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "ignore",
      env: {
        NODE_ENV: "production",
        BLOTBOARD_PORT: String(LOCAL_PORT),
        BLOTBOARD_PORT_STRICT: "1",
        BLOTBOARD_HOST: "127.0.0.1",
        BLOTBOARD_DATA_DIR: localDataDir,
        BLOTBOARD_DATA_FILE: path.join(localDataDir, "boards.json"),
        BLOTBOARD_UPLOADS_DIR: path.join(localDataDir, "uploads"),
        BLOTBOARD_AGENT_COMMANDS_FILE: path.join(localDataDir, "agent-commands.json"),
        // 全部 Runner / 集成 env 显式清空 = local 任务后端（Runner 设置表单可编辑的形态）
        GOAL_AGENT_RUNNER_URL: "",
        BLOTBOARD_RUNNER_URL: "",
        GOAL_AGENT_WEB_URL: "",
        AIDOCS_URL: "",
        BOOK_LIBRARY_URL: "",
        BLOTBOARD_GOAL_AGENT_SETTINGS: "",
      },
    },
  ],
});

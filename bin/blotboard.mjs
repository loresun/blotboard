#!/usr/bin/env node
/**
 * blotboard CLI 入口（package.json 的 bin）。
 *
 * 目前只有一个子命令：`blotboard mcp` —— 起一个 MCP server（stdio transport），
 * 把画板的 HTTP API 包成一套 board_* 工具，任何 MCP 客户端（Claude Code / Cursor /
 * 任意宿主）配一行就能操作画板，不用自己拼 curl。
 *
 * 画板服务本体不从这里起（那是 `npm start` / server.mjs 的事）：
 * CLI 只做「agent 接进来」这一侧。
 */
import fs from "node:fs";

const [, , command] = process.argv;

if (command === "mcp") {
  const { main } = await import("./blotboard-mcp.mjs");
  await main();
} else {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lines = [
    `blotboard v${pkg.version} —— 泼墨画板 CLI`,
    "",
    "用法：",
    "  blotboard mcp    起 MCP server（stdio），把画板 API 暴露成 board_* 工具",
    "",
    "环境变量：",
    "  BLOTBOARD_URL      画板服务地址（默认 http://127.0.0.1:8567）",
    "  BLOTBOARD_TOKEN    写操作 token；不配且连的是本机时，会尝试读 <data>/token",
    "  BLOTBOARD_DATA_DIR 数据目录（只用于找 token 文件，默认 ./data）",
    "",
    "先在可信源码目录 npm link，再配置 MCP 客户端（如 .mcp.json）：",
    '  { "mcpServers": { "blotboard": { "command": "blotboard", "args": ["mcp"] } } }',
    "",
    "画板服务本体：在仓库里 npm run build && npm start（详见 README）。",
  ];
  console.log(lines.join("\n"));
  if (command && command !== "help" && command !== "--help" && command !== "-h") {
    console.error(`\n未知子命令：${command}`);
    process.exit(1);
  }
}

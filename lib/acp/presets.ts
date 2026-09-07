/**
 * ACP agent 预设（「一键添加」用）。
 *
 * 每条 = 一个 coding agent 在本机怎么被拉成 ACP 服务端。命令都在 2026-09-07
 * 用画板自己的握手（initialize protocolVersion:1 + session/new，见 probe.ts）
 * 实测过——不是照文档抄的。
 *
 * 两类形态：
 *  - **自带 acp 子命令**（kimi / opencode）：直接 `<cli> acp`，最快；
 *  - **要适配器**（claude / codex / pi）：CLI 本身不说 ACP，得跑一个 adapter；
 *    `command` 给首选的已安装二进制，`fallback` 给 npx 兜底——probe 两条都试，
 *    「一键添加」落盘的是**实际探通的那条**（不猜）。
 *
 * 版本别钉死：adapter 迭代很快，钉旧版会以「握手超时」的形态挂掉
 * （acpx 里钉的 claude-agent-acp@^0.31.0 就是这么坏的，实际最新 0.75.x）。
 */
export interface AcpPreset {
  /** 稳定标识（也是「一键添加」落盘时的 agent id 前缀） */
  key: string;
  name: string;
  /** 首选启动方式（通常是已安装的二进制） */
  command: string;
  args: string[];
  /** command 不在 PATH 里时的兜底（npx 拉 adapter） */
  fallback?: { command: string; args: string[] };
  /** 这个 agent 归谁、怎么登录——检测报「要认证」时给人看的一句话 */
  auth: string;
  /** 实测备注（启动耗时、噪音、坑），显示在预设卡片上 */
  note?: string;
}

export const ACP_PRESETS: AcpPreset[] = [
  {
    key: "claude-code",
    name: "Claude Code",
    command: "claude-agent-acp",
    args: [],
    fallback: { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@latest"] },
    auth: "复用本机 `claude` 的登录态；没登录先在终端跑一次 `claude` 完成登录",
    note: "官方 ACP 适配器。别钉旧版本——钉 0.31 会卡在握手不返回",
  },
  {
    key: "codex",
    name: "Codex",
    command: "codex-acp",
    args: [],
    fallback: { command: "npx", args: ["-y", "@zed-industries/codex-acp@latest"] },
    auth: "复用 `~/.codex` 的登录态（chatgpt 或 OPENAI_API_KEY）",
    note: "冷启动约 20s（要拉模型列表）；stderr 的 skills 报错是噪音，不影响握手",
  },
  {
    key: "kimi",
    name: "Kimi CLI",
    command: "kimi",
    args: ["acp"],
    auth: "复用本机 `kimi` 的登录态",
    note: "自带 acp 子命令，冷启动 <1s——五个里最快",
  },
  {
    key: "opencode",
    name: "opencode",
    command: "opencode",
    args: ["acp"],
    fallback: { command: "npx", args: ["-y", "opencode-ai@latest", "acp"] },
    auth: "复用 `opencode` 的登录态（`opencode auth login`）",
    note: "自带 acp 子命令；冷启动约 15s",
  },
  {
    key: "pi",
    name: "pi",
    command: "pi-acp",
    args: [],
    fallback: { command: "npx", args: ["-y", "pi-acp@latest"] },
    auth: "复用本机 `pi` 的登录态（`pi auth`）",
    note: "CLI 本身不说 ACP，走 pi-acp 适配器",
  },
];

export function findPreset(key: string): AcpPreset | null {
  return ACP_PRESETS.find((preset) => preset.key === key) || null;
}

/**
 * 功能开关（服务端唯一真源）。
 *
 * 口径只有一条：**对应服务的地址配了才算有这个功能**——不探活、不猜测。
 * 服务临时挂了是「配置了但暂时不可用」（接口回 502），跟「没配置」（接口回 503、
 * 入口不渲染）是两种状态，别混在一起。
 *
 * 例外是任务链路：它**永远开着**——没配任何外部 Runner 时退到内置的 local 后端
 * （Issue 落本地、「发起任务」生成 prompt 供复制），所以 tasks 恒为 true，
 * 差别下沉为 TASK_BACKEND（后端种类），前端据此换文案与形态。
 *
 * 前端拿不到 process.env，这份开关经 app/layout.tsx 的 `<body data-features>`
 * 与 `<body data-task-backend>` 下发（见 lib/features-client.ts）；
 * /api/capabilities 也原样上报，agent 探一次全知道。
 */
import { AIDOCS_URL, BOOK_LIBRARY_URL, HTTP_RUNNER_URL, RUNNER_URL } from "./config";

export const FEATURES = {
  /** 任务链路：转 Issue / 发起任务 / 任务进展。恒为 true（未配 Runner 时是 local 后端）。 */
  tasks: true,
  /** 资料卡检索（知识库） */
  search: Boolean(AIDOCS_URL),
  /** 图书卡（本机书库） */
  library: Boolean(BOOK_LIBRARY_URL),
} as const;

export type FeatureName = keyof typeof FEATURES;

export type TaskBackendKind = "goal-agent" | "local" | "http";

/**
 * 当前的任务后端种类（选择次序见 lib/config.ts 注释）：
 * BLOTBOARD_RUNNER_URL → GOAL_AGENT_RUNNER_URL → local。
 */
export const TASK_BACKEND: TaskBackendKind = HTTP_RUNNER_URL ? "http" : RUNNER_URL ? "goal-agent" : "local";

/** 开启的功能名列表（下发 dataset / capabilities 用），顺序固定方便断言。 */
export const ENABLED_FEATURES: FeatureName[] = (Object.keys(FEATURES) as FeatureName[]).filter(
  (name) => FEATURES[name],
);

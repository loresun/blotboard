/**
 * e2e 里三个可选集成的地址（playwright.config.ts 喂给被测服务，用例照它断言链接）。
 *
 * 为什么默认是三个「没人监听」的端口：这三项在 e2e 里要验的只是**「配置了」这个事实**
 * —— 入口渲染出来、跨服务链接的 host / 端口拼对、未配置时整块隐藏的反面。
 * 服务本身**不需要活着**：真要回源的用例（书库书目、封面）自己 page.route mock 掉。
 * 所以默认值刻意指向本机空端口，跟 CI 那台干净机器完全同构——本机跑得过，CI 就跑得过。
 *
 * 本机真跑着这些服务、想顺带验一遍真实链路时，用 E2E_* 覆盖即可。
 */
const dead = (port: number) => `http://127.0.0.1:${port}`;

/** 知识库（资料卡检索）。8441-8443 被 e2e 自己的三个服务占着，这里从 8444 起 */
export const E2E_AIDOCS_URL = process.env.E2E_AIDOCS_URL || dead(8444);
/** 本机书库（图书卡） */
export const E2E_BOOK_LIBRARY_URL = process.env.E2E_BOOK_LIBRARY_URL || dead(8445);
/** 任务后端主界面（任务详情「在主界面查看」的落点） */
export const E2E_GOAL_AGENT_WEB_URL = process.env.E2E_GOAL_AGENT_WEB_URL || dead(8446);

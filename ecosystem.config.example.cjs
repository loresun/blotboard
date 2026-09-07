/**
 * pm2 进程定义模板：复制成 ecosystem.config.cjs 再按需改（那份不进 git）。
 *   cp ecosystem.config.example.cjs ecosystem.config.cjs
 *   npm run build && pm2 start ecosystem.config.cjs
 */
module.exports = {
  apps: [
    {
      name: "blotboard",
      cwd: __dirname,
      script: "server.mjs",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        BLOTBOARD_PORT: "8567",
        BLOTBOARD_HOST: "127.0.0.1",
        // ── 可选集成：显式配置才启用；**不配 = 对应功能整个隐藏**（入口不渲染，API 回 503）──
        // 下面几个地址都是占位示例，换成你自己那几个服务实际监听的地址。
        // 任务后端（任务卡转 Issue / 发起任务 / Agent 派单）
        // GOAL_AGENT_RUNNER_URL: "http://127.0.0.1:9001",
        // 任务后端的主界面（任务详情「在主界面查看」跳转；只在配了 Runner 时有意义）
        // GOAL_AGENT_WEB_URL: "http://127.0.0.1:9002",
        // 知识库（资料卡检索）
        // AIDOCS_URL: "http://127.0.0.1:9003",
        // 本机书库（图书卡：封面 / 在线读 / PDF）
        // BOOK_LIBRARY_URL: "http://127.0.0.1:9004",
        // token 默认自管在 data/token（首启自动生成）；想显式指定就打开下面这行
        // BLOTBOARD_INTERNAL_TOKEN: "换成你自己的随机串",
      },
      max_memory_restart: "600M",
      autorestart: true,
      watch: false,
    },
  ],
};

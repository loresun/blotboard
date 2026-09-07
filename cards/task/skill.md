### 任务（task）

要做的事，唯一能「转 Issue / 发起执行」的类型。专属字段 `task.{goal,priority,status,…}`：

- `goal` 任务目标（转 Issue 时的正文主体）；`priority` ∈ urgent/high/medium/low/none；`status` ∈ idea/issued/running/done
  （**这两个写错会 400 并列出合法值**，不会被静默兜底成 none / idea）
- `task.issueId / issueNumber / taskId` 是账本字段，由转 Issue / 发起任务的接口自动维护，**别手改**
- 用户对这张卡的执行要求写进卡片公共字段 `agentPrompt`（转 Issue 自动拼进正文），别塞 content

import { describeAuth, isAgentRequest } from "@/lib/auth";
import { ok, route } from "@/lib/http";
import { BOARDS_DIR, HTTP_RUNNER_TOKEN, HTTP_RUNNER_URL, PORT, RUNNER_URL, tryReadInternalToken } from "@/lib/config";
import { FEATURES, TASK_BACKEND } from "@/lib/features";
import * as store from "@/lib/storage";

export const dynamic = "force-dynamic";

export const GET = route(async (request: Request) => {
  // runner 探活只对远程后端做：local 后端没有外部 Runner，这个字段保持 false
  //（含义不变：「配置的外部 Runner 探得到吗」，监控脚本不用改）
  let runner = false;
  if (TASK_BACKEND !== "local") {
    const base = TASK_BACKEND === "http" ? HTTP_RUNNER_URL : RUNNER_URL;
    const token = TASK_BACKEND === "http" && HTTP_RUNNER_TOKEN ? HTTP_RUNNER_TOKEN : tryReadInternalToken() || "";
    try {
      const response = await fetch(`${base}/api/capabilities`, {
        headers: { "x-auth-key": token },
        signal: AbortSignal.timeout(2000),
        redirect: "error",
      });
      runner = response.ok;
    } catch {
      /* runner 不在也不影响画板自身可用 */
    }
  }
  // 坏掉的板文件不再让整个服务 500，但也不能只留在日志里——从这里能查到
  const broken = store.brokenBoardFiles();
  /**
   * **绝对路径只给带 token 的调用方**（与 lib/auth.ts 那条「绝对路径不进 API 响应」同一口径）。
   *
   * health 是免鉴权的 GET，而 `/Users/<名字>/…` 这种路径会把机器主人的用户名与目录结构
   * 一起送出去。本机自用时无所谓，但这个服务是可以摆在带 SSO 的反代后面的——
   * 那时「过了 SSO 的任何人」都能读到它，没必要。
   *
   * 字段名与含义一个字不改（老监控脚本照旧），只是不带 token 时整个不出现；
   * 唯一的消费者 scripts/doctor.mjs 会在本机找得到 token 时自动带上（找不到就跳过磁盘那几项，
   * 它本来就有这条降级分支——诊断远程实例时走的就是它）。
   */
  const trusted = isAgentRequest(request);
  return ok({
    service: "blotboard",
    port: PORT,
    boards: store.list().length,
    ...(trusted ? { dataDir: BOARDS_DIR, dataFile: BOARDS_DIR } : {}),
    ...(broken.length ? { brokenBoards: broken } : {}),
    runner,
    // 老字段全保留（监控脚本不用改）；features 是加出来的：哪些可选集成开着
    features: FEATURES,
    tokenConfigured: Boolean(tryReadInternalToken()),
    // 生效 token 来自哪（env / Goal Agent settings / 数据目录自管）——
    // 排「拿了 data/token 却 403」这类问题时，第一眼看的就是它
    tokenSource: describeAuth().source,
  });
});

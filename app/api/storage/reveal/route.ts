import { spawn } from "node:child_process";
import { DATA_DIR } from "@/lib/config";
import { assertCanWrite } from "@/lib/auth";
import { ApiError, ok, route } from "@/lib/http";

export const dynamic = "force-dynamic";

function revealDataDirectory() {
  // Keep executables static so the production tracer does not treat a dynamic
  // spawn target as possible access to every file in the project.
  if (process.platform === "darwin") return spawn("open", [DATA_DIR], { detached: true, stdio: "ignore" });
  if (process.platform === "win32") return spawn("explorer.exe", [DATA_DIR], { detached: true, stdio: "ignore" });
  if (process.platform === "linux") return spawn("xdg-open", [DATA_DIR], { detached: true, stdio: "ignore" });
  throw new ApiError("当前操作系统不支持自动打开数据目录，请在部署终端查看 BLOTBOARD_DATA_DIR", 501);
}

export const POST = route(async (request: Request) => {
  assertCanWrite(request);
  await new Promise<void>((resolve, reject) => {
    const child = revealDataDirectory();
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  // Absolute paths are deliberately omitted. The file manager is the reveal channel.
  return ok({ opened: true, location: "<数据目录>" });
});

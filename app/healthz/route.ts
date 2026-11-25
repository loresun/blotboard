import { PORT } from "@/lib/config";
import packageJson from "@/package.json";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify({
      ok: true,
      status: "ok",
      service: "blotboard",
      port: PORT,
      version: packageJson.version,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

import { localeMetadata } from "@/lib/i18n/metadata";
import { AgentOnboarding } from "@/components/AgentOnboarding";

export const dynamic = "force-dynamic";
export async function generateMetadata() {
  return localeMetadata("meta.agent.title", "meta.agent.desc");
}
export default function Page() {
  return <AgentOnboarding />;
}

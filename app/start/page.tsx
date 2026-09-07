import { localeMetadata } from "@/lib/i18n/metadata";
import { StartPage } from "@/components/StartPage";

export const dynamic = "force-dynamic";
export async function generateMetadata() {
  return localeMetadata("meta.start.title", "meta.start.desc");
}

export default function Page() {
  return <StartPage />;
}

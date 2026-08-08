import { TeamPanel } from "@/components/team-panel";
import {
  parseReturnTo,
  parseSettingsSection,
} from "@/components/settings-navigation";
import { parseGuideUrl } from "@/src/shared/onboarding-guide-machine";

type TeamPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function TeamPage({ searchParams }: TeamPageProps) {
  const query = (await searchParams) ?? {};
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== undefined) {
      params.append(key, value);
    }
  }
  const guideResult = parseGuideUrl(`/team?${params.toString()}`);
  const guide =
    guideResult.kind === "guide" &&
    (guideResult.route.step === "provider" ||
      guideResult.route.step === "agent")
      ? guideResult.route.step
      : undefined;

  return (
    <TeamPanel
      guide={guide}
      returnTo={parseReturnTo(query.returnTo)}
      section={parseSettingsSection(query.section)}
    />
  );
}

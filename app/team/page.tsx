import { TeamPanel } from "@/components/team-panel";
import {
  parseReturnTo,
  parseSettingsSection,
} from "@/components/settings-navigation";

type TeamPageProps = {
  searchParams?: Promise<{
    returnTo?: string | string[];
    section?: string | string[];
  }>;
};

export default async function TeamPage({ searchParams }: TeamPageProps) {
  const query = (await searchParams) ?? {};

  return (
    <TeamPanel
      returnTo={parseReturnTo(query.returnTo)}
      section={parseSettingsSection(query.section)}
    />
  );
}

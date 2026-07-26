"use client";

import { useCallback, useEffect, useState } from "react";
import { AgentForm } from "../components/AgentForm";
import { AgentList } from "../components/AgentList";
import { SkillForm } from "../components/SkillForm";
import { SkillList } from "../components/SkillList";
import { ProviderForm } from "../components/ProviderForm";
import { ProviderList } from "../components/ProviderList";
import type { SkillIndexDTO } from "../src/server/skillService";
import type { ProviderConfigDTO } from "../src/server/providerService";

type Status = "loading" | "empty" | "error" | "success";

export default function Home() {
  const [agentVersion, setAgentVersion] = useState(0);
  const [skillsVersion, setSkillsVersion] = useState(0);
  const [providersVersion, setProvidersVersion] = useState(0);
  const [skills, setSkills] = useState<SkillIndexDTO[]>([]);
  const [skillsStatus, setSkillsStatus] = useState<Status>("loading");
  const [providers, setProviders] = useState<ProviderConfigDTO[]>([]);
  const [providersStatus, setProvidersStatus] = useState<Status>("loading");

  const loadSkills = useCallback(async () => {
    setSkillsStatus("loading");
    try {
      const res = await fetch("/api/skills");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list: SkillIndexDTO[] = data.skills ?? [];
      setSkills(list);
      setSkillsStatus(list.length === 0 ? "empty" : "success");
    } catch {
      setSkillsStatus("error");
    }
  }, []);

  const loadProviders = useCallback(async () => {
    setProvidersStatus("loading");
    try {
      const res = await fetch("/api/providers");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list: ProviderConfigDTO[] = data.configs ?? [];
      setProviders(list);
      setProvidersStatus(list.length === 0 ? "empty" : "success");
    } catch {
      setProvidersStatus("error");
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills, skillsVersion]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders, providersVersion]);

  const bumpSkills = () => setSkillsVersion((v) => v + 1);
  const bumpProviders = () => setProvidersVersion((v) => v + 1);
  const bumpAgents = () => setAgentVersion((v) => v + 1);

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 p-4 sm:flex-row sm:p-6">
      <aside className="w-full shrink-0 rounded-token border border-line bg-surface-subtle p-4 sm:w-64">
        <h1 className="text-xl font-semibold">COOL AI</h1>
        <p className="mt-1 text-sm text-muted">多 agent 协作平台</p>
      </aside>
      <main className="flex-1 space-y-6">
        <section className="rounded-token border border-line bg-surface p-4">
          <h2 className="mb-3 text-lg font-medium">创建 Skill</h2>
          <SkillForm onCreated={bumpSkills} />
          <h3 className="mb-3 mt-4 text-base font-medium">Skill 列表</h3>
          <SkillList status={skillsStatus} skills={skills} onRetry={loadSkills} />
        </section>
        <section className="rounded-token border border-line bg-surface p-4">
          <h2 className="mb-3 text-lg font-medium">创建 Provider 配置</h2>
          <ProviderForm onCreated={bumpProviders} />
          <h3 className="mb-3 mt-4 text-base font-medium">Provider 列表</h3>
          <ProviderList
            status={providersStatus}
            configs={providers}
            onRetry={loadProviders}
          />
        </section>
        <section className="rounded-token border border-line bg-surface p-4">
          <h2 className="mb-3 text-lg font-medium">创建 Agent</h2>
          <AgentForm
            onCreated={() => { bumpSkills(); bumpProviders(); bumpAgents(); }}
            skills={skills}
            providerConfigs={providers}
          />
        </section>
        <section>
          <h2 className="mb-3 text-lg font-medium">Agent</h2>
          <AgentList
            version={agentVersion}
            skills={skills}
            providerConfigs={providers}
          />
        </section>
      </main>
    </div>
  );
}

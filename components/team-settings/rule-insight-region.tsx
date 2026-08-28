"use client";

import { useEffect, useState } from "react";

import { parseProjectSelection } from "@/components/settings-navigation";
import {
  ruleInsightSchema,
  type RuleInsight,
  type RuleInsightFinding,
} from "@/src/shared/rule-insight-contracts";

type RuleInsightRegionProps = {
  returnTo?: string;
};

function severityLabel(finding: RuleInsightFinding): string {
  return finding.severity === "block" ? "阻断" : "警告";
}

function severityClass(finding: RuleInsightFinding): string {
  return finding.severity === "block" ? "status-failed" : "status-queued";
}

export function RuleInsightRegion({ returnTo = "/" }: RuleInsightRegionProps) {
  const projectId = parseProjectSelection(returnTo)?.projectId ?? null;
  const [insight, setInsight] = useState<RuleInsight | null>(null);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!projectId) {
      setInsight(null);
      setError(false);
      return;
    }

    const controller = new AbortController();
    setInsight(null);
    setError(false);
    void fetch(`/api/projects/${encodeURIComponent(projectId)}/rule-insight`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("rule-insight");
        const payload: unknown = await response.json();
        const parsed = ruleInsightSchema.safeParse(payload);
        if (!parsed.success) throw new Error("rule-insight");
        return parsed.data;
      })
      .then((payload) => {
        if (!controller.signal.aborted) setInsight(payload);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });

    return () => controller.abort();
  }, [projectId, reloadKey]);

  const loading = projectId !== null && insight === null && !error;
  const agentNames = new Map(
    insight?.agents.map((agent) => [agent.id, agent.name]) ?? [],
  );
  const findingsByAgent = new Map<string, RuleInsightFinding[]>();
  for (const finding of insight?.findings ?? []) {
    const findings = findingsByAgent.get(finding.agentId) ?? [];
    findings.push(finding);
    findingsByAgent.set(finding.agentId, findings);
  }

  function retry() {
    setReloadKey((current) => current + 1);
  }

  return (
    <section
      aria-busy={loading || undefined}
      aria-labelledby="rule-insight-heading"
      className="rule-insight-region stack"
    >
      <h2 id="rule-insight-heading">规则与注入检查</h2>
      {!projectId ? (
        <p className="muted">打开项目后可检查该项目成员的提示与技能。</p>
      ) : loading ? (
        <p className="state-message">正在检查规则与注入风险…</p>
      ) : error ? (
        <div className="state-message stack" role="alert">
          <p>无法检查规则与注入风险。</p>
          <button className="button-secondary" onClick={retry} type="button">
            重新检查
          </button>
        </div>
      ) : insight && insight.findings.length === 0 ? (
        <div className="state-message stack">
          <p>未发现规则冲突或注入风险。</p>
          <button className="button-secondary" onClick={retry} type="button">
            重新检查
          </button>
        </div>
      ) : (
        <div className="usage-quota-grid">
          {[...findingsByAgent].map(([agentId, findings]) => (
            <article className="task-summary stack" key={agentId}>
              <h3>{agentNames.get(agentId) ?? agentId}</h3>
              <ul className="stack">
                {findings.map((finding) => (
                  <li className="stack" key={finding.id}>
                    <div
                      className="stack"
                      role={finding.severity === "block" ? "alert" : undefined}
                    >
                      <p>
                        <code>{finding.code}</code>{" "}
                        <span
                          className={`status-label ${severityClass(finding)}`}
                        >
                          {severityLabel(finding)}
                        </span>
                      </p>
                      <p className="muted">{`来源：${finding.sourceName}`}</p>
                      <p>{finding.reason}</p>
                      <p className="muted">{finding.excerpt}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

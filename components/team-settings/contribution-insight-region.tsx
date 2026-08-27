"use client";

import { useEffect, useState } from "react";

import { parseProjectSelection } from "@/components/settings-navigation";
import type { ContributionInsightDto } from "@/src/modules/operations-projection";

type ContributionInsightRegionProps = {
  returnTo?: string;
};

type EvidenceItem = ContributionInsightDto["roles"][number]["evidence"][number];

function evidenceHref(projectId: string, item: EvidenceItem): string {
  const encodedProject = encodeURIComponent(projectId);
  const encodedId = encodeURIComponent(item.id);
  return item.kind === "review"
    ? `/projects/${encodedProject}/reviews/${encodedId}`
    : `/projects/${encodedProject}/tasks/${encodedId}`;
}

function NavLink({
  href,
  children,
  className = "button-secondary",
}: {
  children: string;
  className?: string;
  href: string | null;
}) {
  return (
    <a
      aria-disabled={href ? undefined : "true"}
      className={className}
      href={href ?? "#"}
      onClick={href ? undefined : (event) => event.preventDefault()}
      tabIndex={href ? undefined : -1}
    >
      {children}
    </a>
  );
}

export function ContributionInsightRegion({ returnTo = "/" }: ContributionInsightRegionProps) {
  const projectId = parseProjectSelection(returnTo)?.projectId ?? null;
  const [insight, setInsight] = useState<ContributionInsightDto | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    void fetch(`/api/contribution${query}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("contribution");
        return response.json() as Promise<ContributionInsightDto>;
      })
      .then((payload) => {
        if (active) setInsight(payload);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const taskHref = projectId ? `/projects/${encodeURIComponent(projectId)}` : null;

  return (
    <section
      aria-labelledby="contribution-insight-heading"
      className="contribution-insight-region stack"
    >
      <h2 id="contribution-insight-heading">协作贡献</h2>
      <p className="muted">这不是排行榜</p>
      {insight ? (
        <div className="usage-quota-grid">
          {insight.roles.length === 0 ? (
            <p className="state-message">{insight.project.detail ?? "尚无项目成员"}</p>
          ) : (
            insight.roles.map((member) => (
              <article className="task-summary stack" key={member.agentId}>
                <h3>{`${member.role} · ${member.name}`}</h3>
                <p>{`完成 ${member.workItems.completed} · 进行中 ${member.workItems.inProgress}`}</p>
                <p className="muted">{`通过 ${member.reviews.passed} · 未通过 ${member.reviews.failed}`}</p>
                {member.evidence.length > 0 ? (
                  <ul className="stack">
                    {member.evidence.map((item) => (
                      <li key={`${item.kind}:${item.id}`}>
                        <NavLink
                          className="button-ghost"
                          href={projectId ? evidenceHref(projectId, item) : null}
                        >
                          {item.title}
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <NavLink href={taskHref}>打开任务</NavLink>
              </article>
            ))
          )}
          {insight.roles.length === 0 ? (
            <NavLink href={taskHref}>打开任务</NavLink>
          ) : null}
        </div>
      ) : error ? (
        <p className="state-message">无法加载贡献。</p>
      ) : (
        <p aria-busy="true" className="state-message">正在加载贡献…</p>
      )}
    </section>
  );
}

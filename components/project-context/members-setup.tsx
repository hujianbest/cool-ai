"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type { ApiError } from "@/src/shared/contracts";
import type {
  MembershipState,
  ProjectMember,
} from "@/src/shared/project-context-contracts";
import type { AgentProfile } from "@/src/shared/team-contracts";

type MemberError = Partial<ApiError> & {
  error?: ApiError["error"] & { agentIds?: string[] };
};

type MembersSetupProps = {
  projectId: string;
  projectVersion?: number;
  onVersionChange?: (version: number) => void;
};

function memberError(payload: MemberError, agents: AgentProfile[]): string {
  const code = payload.error?.code;
  if (code === "MEMBER_HAS_ASSIGNMENTS") {
    const names = (payload.error?.agentIds ?? []).map(
      (agentId) =>
        agents.find((agent) => agent.id === agentId)?.name ?? agentId,
    );
    return `${names.join("、")} 仍有已分配任务，请先重新分配或清空负责人。`;
  }
  if (code === "RESOURCE_CONFLICT") {
    return "项目已更新，请重新加载成员后再试。";
  }
  if (code === "AGENT_NOT_FOUND") {
    return "选择中包含已不存在的 Agent，请重新加载。";
  }
  if (code === "INVALID_INPUT") {
    return "成员选择无效，请至少选择 2 名不同成员。";
  }
  return "无法保存项目成员，请稍后重试。";
}

function permissionSummary(member: ProjectMember): string {
  const enabled = [
    member.permissions.readFiles ? "读取" : "",
    member.permissions.writeFiles ? "写入" : "",
    member.permissions.runCommands ? "命令" : "",
  ].filter(Boolean);
  return enabled.length > 0 ? enabled.join("、") : "无工具权限";
}

export function MembersSetup({
  projectId,
  projectVersion,
  onVersionChange,
}: MembersSetupProps) {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loadedVersion, setLoadedVersion] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assignedAgentIds, setAssignedAgentIds] = useState<string[]>([]);
  const [success, setSuccess] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const rosterHeadingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);
    setSuccess("");
    void Promise.allSettled([
      fetch("/api/agents").then(async (response) => {
        const payload = (await response.json()) as {
          agents?: AgentProfile[];
        } & Partial<ApiError>;
        if (!response.ok) throw new Error("agents");
        if (!Array.isArray(payload.agents)) throw new Error("agents");
        return payload.agents;
      }),
      fetch(`/api/projects/${projectId}/members`).then(async (response) => {
        const payload = (await response.json()) as MembershipState &
          Partial<ApiError>;
        if (!response.ok) throw new Error("members");
        if (
          !Array.isArray(payload.members) ||
          !Number.isInteger(payload.projectVersion)
        ) {
          throw new Error("members");
        }
        return payload;
      }),
    ]).then(([agentResult, memberResult]) => {
      if (!active) return;
      if (agentResult.status === "fulfilled") {
        setAgents(agentResult.value);
      } else {
        setError("无法加载 Agent 库，请重试。");
      }
      if (memberResult.status === "fulfilled") {
        setMembers(memberResult.value.members);
        setSelected(
          memberResult.value.members.map((member) => member.agentId),
        );
        setLoadedVersion(memberResult.value.projectVersion);
        onVersionChange?.(memberResult.value.projectVersion);
      } else {
        setError((current) => current ?? "无法加载项目成员，请重试。");
      }
      setIsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [onVersionChange, projectId, reloadKey]);

  function toggle(agentId: string) {
    setError(null);
    setSuccess("");
    setSelected((current) =>
      current.includes(agentId)
        ? current.filter((id) => id !== agentId)
        : [...current, agentId],
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected.length < 2 || isSaving) return;
    setError(null);
    setSuccess("");
    setIsSaving(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/members`, {
        body: JSON.stringify({
          agentIds: selected,
          expectedProjectVersion: projectVersion ?? loadedVersion,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json()) as MembershipState & MemberError;
      if (!response.ok) {
        const blockedIds = payload.error?.agentIds ?? [];
        if (payload.error?.code === "MEMBER_HAS_ASSIGNMENTS") {
          setAssignedAgentIds(blockedIds);
          setSelected((current) => [
            ...current,
            ...blockedIds.filter((agentId) => !current.includes(agentId)),
          ]);
        }
        throw new Error(memberError(payload, agents));
      }
      if (
        !Array.isArray(payload.members) ||
        !Number.isInteger(payload.projectVersion)
      ) {
        throw new Error("无法保存项目成员，请稍后重试。");
      }
      setMembers(payload.members);
      setSelected(payload.members.map((member) => member.agentId));
      setLoadedVersion(payload.projectVersion);
      onVersionChange?.(payload.projectVersion);
      setAssignedAgentIds([]);
      setSuccess("项目成员已保存。");
      queueMicrotask(() => rosterHeadingRef.current?.focus());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "无法保存项目成员，请稍后重试。",
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section aria-labelledby={`members-title-${projectId}`} className="stack">
      <h3 id={`members-title-${projectId}`}>项目成员</h3>
      {isLoading ? (
        <p aria-busy="true" className="muted">
          正在加载项目成员…
        </p>
      ) : (
        <>
          {agents.length === 0 ? (
            <p className="muted">
              Agent 库为空，请先<a href="/team">创建 Agent</a>。
            </p>
          ) : (
            <form className="stack" onSubmit={handleSubmit}>
              <fieldset
                aria-describedby={
                  selected.length < 2
                    ? `members-minimum-${projectId}`
                    : error
                      ? `members-error-${projectId}`
                      : undefined
                }
              >
                <legend>平等项目成员</legend>
                <div className="stack">
                  {agents.map((agent) => (
                    <label className="check-row" key={agent.id}>
                      <input
                        checked={selected.includes(agent.id)}
                        disabled={assignedAgentIds.includes(agent.id)}
                        onChange={() => toggle(agent.id)}
                        type="checkbox"
                      />
                      <span>
                        {agent.avatarText} · {agent.name} · {agent.role} ·{" "}
                        {agent.model}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {selected.length < 2 ? (
                <p className="muted" id={`members-minimum-${projectId}`}>
                  请至少选择 2 名成员。
                </p>
              ) : null}
              <button disabled={selected.length < 2 || isSaving} type="submit">
                {isSaving ? "正在保存成员…" : "保存成员"}
              </button>
            </form>
          )}
        </>
      )}
      {error ? (
        <div className="stack">
          <p
            className="error-text"
            id={`members-error-${projectId}`}
            role="alert"
          >
            {error}
            {assignedAgentIds.length > 0 ? (
              <>
                {" "}
                <a href="#mission-board">查看已分配任务</a>
              </>
            ) : null}
          </p>
          {error.startsWith("无法加载") ||
          error.startsWith("项目已更新") ||
          error.includes("已不存在") ? (
            <button
              onClick={() => setReloadKey((current) => current + 1)}
              type="button"
            >
              重试加载成员
            </button>
          ) : null}
        </div>
      ) : null}
      {success ? (
        <p aria-live="polite" aria-label="保存结果" role="status">
          {success}
        </p>
      ) : null}
      {members.length > 0 ? (
        <div className="stack">
          <h4 ref={rosterHeadingRef} tabIndex={-1}>
            成员名册
          </h4>
          <ul className="project-list">
            {members.map((member) => (
              <li data-accent={member.accentToken} key={member.agentId}>
                <strong>
                  {member.avatarText} · {member.name}
                </strong>
                <span>
                  {member.role} · {member.model}
                </span>
                <span>
                  技能：{member.skillNames.join("、") || "无"}；权限：
                  {permissionSummary(member)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : !isLoading && !error ? (
        <p className="muted">尚未组建项目成员。</p>
      ) : null}
    </section>
  );
}

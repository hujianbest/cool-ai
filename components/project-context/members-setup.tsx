"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type { ApiError } from "@/src/shared/contracts";
import type { ProjectMember } from "@/src/shared/project-context-contracts";
import type { AgentProfile } from "@/src/shared/team-contracts";
import {
  MembersOnboardingGuide,
  parseAgentGuideEnvelopes,
  type AgentGuideFacts,
} from "@/components/onboarding-guide";
import {
  parseMembershipGuideEnvelope,
  type MembershipGuideEnvelope,
} from "@/src/shared/onboarding-guide-machine";

type MemberError = Partial<ApiError> & {
  error?: ApiError["error"] & { agentIds?: string[] };
};

type MembersSetupProps = {
  projectId: string;
  projectVersion?: number;
  onVersionChange?: (version: number) => void;
  onGuideContinue?: () => void;
  onGuideSkip?: () => void;
  showGuide?: boolean;
};

class KnownMemberWriteError extends Error {}

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
  onGuideContinue,
  onGuideSkip,
  showGuide = false,
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
  const [guideFacts, setGuideFacts] = useState<AgentGuideFacts | null>(null);
  const [guideLoadError, setGuideLoadError] = useState(false);
  const [providerValue, setProviderValue] = useState<unknown>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const rosterHeadingRef = useRef<HTMLHeadingElement>(null);
  const memberGroupRef = useRef<HTMLFieldSetElement>(null);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);
    setSuccess("");
    setGuideFacts(null);
    setGuideLoadError(false);
    setNeedsReload(false);
    void Promise.allSettled([
      fetch("/api/agents").then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("agents");
        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          !Array.isArray((payload as { agents?: unknown }).agents)
        ) {
          throw new Error("agents");
        }
        return {
          agents: (payload as { agents: AgentProfile[] }).agents,
          value: payload,
        };
      }),
      fetch(`/api/projects/${projectId}/members`).then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("members");
        const parsed = parseMembershipGuideEnvelope(payload);
        if (parsed.kind !== "success") throw new Error("members-invalid");
        return { parsed, value: payload };
      }),
      showGuide
        ? fetch("/api/providers").then(async (response) => {
            const value: unknown = await response.json();
            if (!response.ok) throw new Error("providers");
            return value;
          })
        : Promise.resolve(null),
    ]).then(([agentResult, memberResult, providerResult]) => {
      if (!active) return;
      if (agentResult.status === "fulfilled") {
        setAgents(agentResult.value.agents);
      } else {
        setError("无法加载 Agent 库，请重试。");
      }
      if (memberResult.status === "fulfilled") {
        setMembers(memberResult.value.parsed.members);
        setSelected(
          memberResult.value.parsed.members.map((member) => member.agentId),
        );
        setLoadedVersion(memberResult.value.parsed.projectVersion);
        onVersionChange?.(memberResult.value.parsed.projectVersion);
      } else {
        setError((current) =>
          current ??
          (memberResult.reason instanceof Error &&
          memberResult.reason.message === "members-invalid"
            ? "成员响应无效，已失败关闭。"
            : "无法加载项目成员，请重试。"),
        );
      }
      if (showGuide) {
        if (
          agentResult.status === "fulfilled" &&
          memberResult.status === "fulfilled" &&
          providerResult.status === "fulfilled" &&
          providerResult.value !== null
        ) {
          setProviderValue(providerResult.value);
          setGuideFacts(
            parseAgentGuideEnvelopes(
              providerResult.value,
              agentResult.value.value,
              memberResult.value.value,
            ),
          );
        } else {
          setGuideLoadError(true);
        }
      }
      setIsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [onVersionChange, projectId, reloadKey, showGuide]);

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
    setNeedsReload(false);
    setIsSaving(true);
    const requestedAgentIds = [...selected];
    const expectedProjectVersion = projectVersion ?? loadedVersion;
    const applyState = (
      parsed: Extract<MembershipGuideEnvelope, { kind: "success" }>,
      notice: string,
    ) => {
      setMembers(parsed.members);
      setSelected(parsed.members.map((member) => member.agentId));
      setLoadedVersion(parsed.projectVersion);
      onVersionChange?.(parsed.projectVersion);
      setAssignedAgentIds([]);
      setSuccess(notice);
      if (showGuide && providerValue) {
        setGuideFacts(
          parseAgentGuideEnvelopes(
            providerValue,
            { agents },
            {
              members: parsed.members,
              projectVersion: parsed.projectVersion,
            },
          ),
        );
      }
      queueMicrotask(() => rosterHeadingRef.current?.focus());
    };
    const reconcileUnknownWrite = async () => {
      try {
        const response = await fetch(`/api/projects/${projectId}/members`);
        if (!response.ok) throw new Error("read");
        const parsed = parseMembershipGuideEnvelope(await response.json());
        const actualIds =
          parsed.kind === "success"
            ? parsed.members.map((member) => member.agentId).sort()
            : [];
        const requestedIds = [...requestedAgentIds].sort();
        if (
          parsed.kind !== "success" ||
          parsed.projectVersion !== expectedProjectVersion + 1 ||
          actualIds.length !== requestedIds.length ||
          actualIds.some((agentId, index) => agentId !== requestedIds[index])
        ) {
          throw new Error("unconfirmed");
        }
        applyState(parsed, "已通过事实核对确认项目成员已保存。");
      } catch {
        setError(
          "成员写入结果未知，且无法由 GET 唯一确认。请核对当前成员后再决定是否重试；不会自动重发。",
        );
        setNeedsReload(true);
        memberGroupRef.current?.focus();
      }
    };
    try {
      const response = await fetch(`/api/projects/${projectId}/members`, {
        body: JSON.stringify({
          agentIds: requestedAgentIds,
          expectedProjectVersion,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const apiError = payload as MemberError;
        const blockedIds = apiError.error?.agentIds ?? [];
        if (apiError.error?.code === "MEMBER_HAS_ASSIGNMENTS") {
          setAssignedAgentIds(blockedIds);
          setSelected((current) => [
            ...current,
            ...blockedIds.filter((agentId) => !current.includes(agentId)),
          ]);
        }
        if (apiError.error?.code === "RESOURCE_CONFLICT") {
          setNeedsReload(true);
        }
        throw new KnownMemberWriteError(memberError(apiError, agents));
      }
      const parsed = parseMembershipGuideEnvelope(payload);
      if (parsed.kind !== "success") {
        await reconcileUnknownWrite();
        return;
      }
      applyState(parsed, "项目成员已保存。");
    } catch (cause) {
      if (cause instanceof KnownMemberWriteError) {
        setError(
          cause.message,
        );
      } else {
        await reconcileUnknownWrite();
      }
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section aria-labelledby={`members-title-${projectId}`} className="stack">
      {showGuide ? (
        <MembersOnboardingGuide
          facts={guideFacts}
          loading={isLoading}
          loadError={guideLoadError}
          onContinue={onGuideContinue}
          onFocusMembers={() => {
            if (guideFacts?.kind === "success") rosterHeadingRef.current?.focus();
            else memberGroupRef.current?.focus();
          }}
          onRetry={() => setReloadKey((current) => current + 1)}
            onSkip={onGuideSkip}
        />
      ) : null}
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
                ref={memberGroupRef}
                tabIndex={-1}
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
          needsReload ||
          error.includes("已不存在") ? (
            <button
              onClick={() => setReloadKey((current) => current + 1)}
              type="button"
            >
              {needsReload ? "重新加载成员" : "重试加载成员"}
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

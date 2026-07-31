"use client";

import { useEffect, useState } from "react";

import type { ApiError } from "@/src/shared/contracts";
import type {
  MembershipState,
  ProjectContextSnapshot,
  ProjectMember,
} from "@/src/shared/project-context-contracts";

type Missing = "workspace" | "members" | "mission";
type ContextErrorPayload = Partial<ApiError> & {
  error?: ApiError["error"] & { missing?: Missing[] };
};

const MISSING_ORDER: Missing[] = ["workspace", "members", "mission"];
const MISSING_LABELS: Record<Missing, string> = {
  workspace: "工作区",
  members: "至少两名成员",
  mission: "使命",
};

function permissionsText(permissions: {
  readFiles: boolean;
  writeFiles: boolean;
  runCommands: boolean;
}): string {
  return [
    permissions.readFiles ? "读取" : "",
    permissions.writeFiles ? "写入" : "",
    permissions.runCommands ? "命令" : "",
  ]
    .filter(Boolean)
    .join("、") || "无工具权限";
}

export function ContextPreview({ projectId }: { projectId: string }) {
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [snapshot, setSnapshot] = useState<ProjectContextSnapshot | null>(null);
  const [missing, setMissing] = useState<Missing[]>([]);
  const [isLoadingMembers, setIsLoadingMembers] = useState(true);
  const [isLoadingContext, setIsLoadingContext] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [memberReloadKey, setMemberReloadKey] = useState(0);
  const [contextReloadKey, setContextReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setIsLoadingMembers(true);
    setError(null);
    void fetch(`/api/projects/${projectId}/members`)
      .then(async (response) => {
        const payload = (await response.json()) as MembershipState &
          Partial<ApiError>;
        if (!response.ok || !Array.isArray(payload.members)) {
          throw new Error("members");
        }
        return payload.members;
      })
      .then((loaded) => {
        if (!active) return;
        setMembers(loaded);
        setSelectedAgentId((current) =>
          loaded.some((member) => member.agentId === current)
            ? current
            : loaded[0]?.agentId ?? "",
        );
      })
      .catch(() => {
        if (active) setError("无法加载上下文成员，请重试。");
      })
      .finally(() => {
        if (active) setIsLoadingMembers(false);
      });
    return () => {
      active = false;
    };
  }, [memberReloadKey, projectId]);

  useEffect(() => {
    if (!selectedAgentId) {
      setSnapshot(null);
      setMissing([]);
      return;
    }
    let active = true;
    setIsLoadingContext(true);
    setError(null);
    setSnapshot(null);
    setMissing([]);
    void fetch(
      `/api/projects/${projectId}/context?agentId=${encodeURIComponent(
        selectedAgentId,
      )}`,
    )
      .then(async (response) => {
        const payload = (await response.json()) as
          | ProjectContextSnapshot
          | ContextErrorPayload;
        if (!response.ok) {
          const contextError = payload as ContextErrorPayload;
          if (contextError.error?.code === "CONTEXT_NOT_READY") {
            return {
              missing: MISSING_ORDER.filter((item) =>
                contextError.error?.missing?.includes(item),
              ),
            };
          }
          throw new Error("context");
        }
        return { snapshot: payload as ProjectContextSnapshot };
      })
      .then((result) => {
        if (!active) return;
        if ("snapshot" in result && result.snapshot) setSnapshot(result.snapshot);
        else setMissing(result.missing);
      })
      .catch(() => {
        if (active) setError("无法加载上下文预览，请重试。");
      })
      .finally(() => {
        if (active) setIsLoadingContext(false);
      });
    return () => {
      active = false;
    };
  }, [contextReloadKey, projectId, selectedAgentId]);

  const loading = isLoadingMembers || isLoadingContext;

  return (
    <section aria-labelledby={`context-preview-title-${projectId}`} className="stack">
      <h2 id={`context-preview-title-${projectId}`}>上下文预览</h2>
      {members.length > 0 ? (
        <div className="form-field">
          <label htmlFor={`context-member-${projectId}`}>预览成员</label>
          <select
            id={`context-member-${projectId}`}
            onChange={(event) => setSelectedAgentId(event.target.value)}
            value={selectedAgentId}
          >
            {members.map((member) => (
              <option key={member.agentId} value={member.agentId}>
                {member.name} · {member.role}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {loading ? (
        <p aria-busy="true" className="state-message">
          正在加载上下文预览…
        </p>
      ) : error ? (
        <div className="state-message stack">
          <p className="error-text" role="alert">
            {error}
          </p>
          <button
            onClick={() => {
              if (error.includes("成员"))
                setMemberReloadKey((current) => current + 1);
              else setContextReloadKey((current) => current + 1);
            }}
            type="button"
          >
            重试加载上下文
          </button>
        </div>
      ) : members.length === 0 ? (
        <p className="state-message">尚无可预览的项目成员。</p>
      ) : missing.length > 0 ? (
        <div className="state-message stack">
          <p>上下文尚未就绪，请先完成：</p>
          <ul aria-label="上下文缺失条件" className="stack">
            {missing.map((item) => (
              <li key={item}>{MISSING_LABELS[item]}</li>
            ))}
          </ul>
        </div>
      ) : snapshot ? (
        <>
          <section
            aria-label="共享项目上下文"
            className="stack context-preview-section"
            role="region"
          >
            <h3>{snapshot.shared.project.name}</h3>
            <p>
              工作区：<code>{snapshot.shared.project.workspacePath}</code>
            </p>
            <section className="stack">
              <h4>平等名册</h4>
              <ul aria-label="共享成员名册" className="stack">
                {snapshot.shared.roster.map((member) => (
                  <li key={member.agentId}>
                    {member.name} · {member.role} · {member.model} · 技能：
                    {member.skillNames.join("、") || "无"} · 权限：
                    {permissionsText(member.permissions)}
                  </li>
                ))}
              </ul>
            </section>
            <section className="stack">
              <h4>使命</h4>
              <p>{snapshot.shared.mission.title}</p>
              <p>{snapshot.shared.mission.goal}</p>
            </section>
            <section className="stack">
              <h4>任务</h4>
              <ul aria-label="共享任务" className="stack">
                {snapshot.shared.workItems.map((item) => (
                  <li key={item.id}>
                    {item.title} · {item.status}
                    {item.dependencyIds.length > 0
                      ? ` · 依赖：${item.dependencyIds.join("、")}`
                      : ""}
                  </li>
                ))}
              </ul>
            </section>
            <section className="stack">
              <h4>Active 记忆</h4>
              <ul aria-label="共享 Active 记忆" className="stack">
                {snapshot.shared.memories.map((memory) => (
                  <li key={memory.id}>
                    {memory.content} · 来源：{memory.sourceType} /{" "}
                    {memory.sourceRef}
                  </li>
                ))}
              </ul>
            </section>
          </section>
          <section
            aria-label="当前 Agent 私有配置"
            className="stack context-preview-section"
            role="region"
          >
            <h3>{snapshot.currentAgent.name}</h3>
            <p>{snapshot.currentAgent.role}</p>
            <h4>System prompt</h4>
            <p>{snapshot.currentAgent.systemPrompt}</p>
            <h4>技能指令</h4>
            <ul className="stack">
              {snapshot.currentAgent.skills.map((skill) => (
                <li key={skill.id}>
                  {skill.name}：{skill.instructions}
                </li>
              ))}
            </ul>
            <p>工具权限：{permissionsText(snapshot.currentAgent.permissions)}</p>
          </section>
          <details>
            <summary>查看结构化快照</summary>
            <pre className="structured-snapshot">
              {JSON.stringify(snapshot, null, 2)}
            </pre>
          </details>
        </>
      ) : null}
    </section>
  );
}

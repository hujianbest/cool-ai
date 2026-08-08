"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  completeOnboarding,
  dismissOnboarding,
  resetOnboarding,
  resumeOnboarding,
  skipOnboardingStep,
  updateOnboardingDrift,
  useOnboardingPreference,
} from "@/components/onboarding-preference-store";
import type { Project } from "@/src/shared/contracts";
import type {
  AgentProfile,
  Provider,
} from "@/src/shared/team-contracts";
import {
  parseCollaborationGuideEnvelope,
  parseMissionGuideEnvelope,
  parseWorkspaceGuideEnvelope,
  type GuideStep,
  type WorkspaceGuideEnvelope,
} from "@/src/shared/onboarding-guide-machine";

type Readiness =
  | "loading"
  | "mission"
  | "accepted"
  | "started"
  | "blocked"
  | "error";

type GuideRouteAnnouncerProps = {
  announcement: string;
  targetId: string;
  title: string;
};

function GuideRouteAnnouncer({
  announcement,
  targetId,
  title,
}: GuideRouteAnnouncerProps) {
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    let attempts = 0;
    document.title = `${title} · Cool AI 协作驾驶舱`;
    setMessage("");

    const focusAfterDialogs = () => {
      if (!active) return;
      const target = document.getElementById(targetId);
      const modal = document.querySelector<HTMLElement>(
        '[role="dialog"][aria-modal="true"]',
      );
      if (modal && (!target || !modal.contains(target))) {
        attempts += 1;
        if (attempts < 100) window.setTimeout(focusAfterDialogs, 50);
        return;
      }
      target?.focus();
    };

    queueMicrotask(() => {
      if (!active) return;
      setMessage(announcement);
      window.setTimeout(focusAfterDialogs, 0);
    });
    return () => {
      active = false;
    };
  }, [announcement, targetId, title]);

  return (
    <p
      aria-atomic="true"
      aria-live="polite"
      className="sr-only"
      role="status"
    >
      {message}
    </p>
  );
}

type OnboardingPreferenceControlsProps = {
  onResume?: () => void;
  onSkip?: () => void;
  step: GuideStep;
};

export function OnboardingPreferenceControls({
  onResume,
  onSkip,
  step,
}: OnboardingPreferenceControlsProps) {
  const snapshot = useOnboardingPreference();
  const [announcement, setAnnouncement] = useState("");
  const announcementRef = useRef<HTMLParagraphElement>(null);
  const resumeRef = useRef<HTMLButtonElement>(null);
  const dismissed = snapshot.preference.status.value === "dismissed";

  function report(message: string) {
    setAnnouncement(message);
    queueMicrotask(() => announcementRef.current?.focus());
  }

  useEffect(() => {
    if (!dismissed || !snapshot.hydrated) return;
    queueMicrotask(() => resumeRef.current?.focus());
  }, [dismissed, snapshot.hydrated]);

  function skip() {
    if (!skipOnboardingStep(step)) {
      report("未能跳过当前步骤；引导状态未改变。");
      return;
    }
    report("已跳过当前步骤。");
    onSkip?.();
  }

  function reset() {
    report(
      resetOnboarding(step)
        ? "已重置当前步骤并恢复引导。"
        : "未能重置当前步骤；引导状态未改变。",
    );
  }

  function dismiss() {
    report(
      dismissOnboarding()
        ? "已暂时关闭引导，可随时恢复。"
        : "未能关闭引导；引导状态未改变。",
    );
  }

  function resume(resetSkipped = false) {
    const resumed = resumeOnboarding({ resetSkipped });
    report(
      resumed
        ? "已恢复引导并保留跳过记录。"
        : "未能恢复引导；引导状态未改变。",
    );
    if (resumed) onResume?.();
  }

  return (
    <div aria-label="引导控制" className="onboarding-guide-controls" role="group">
      {snapshot.repair ? (
        <p aria-live="assertive" className="error-text" role="alert">
          已完成记录仍保留，但当前事实已漂移。请修复缺失事实，或由 owner
          明确重置引导。
        </p>
      ) : null}
      {dismissed ? (
        <button
          className="button-primary"
          disabled={!snapshot.hydrated}
          onClick={() => resume(false)}
          ref={resumeRef}
          type="button"
        >
          恢复引导
        </button>
      ) : (
        <>
          <button
            className="button-secondary"
            disabled={!snapshot.hydrated}
            onClick={skip}
            type="button"
          >
            跳过此步骤
          </button>
          <button
            className="button-secondary"
            disabled={!snapshot.hydrated}
            onClick={reset}
            type="button"
          >
            重置此步骤
          </button>
          <button
            className="button-ghost"
            disabled={!snapshot.hydrated}
            onClick={dismiss}
            type="button"
          >
            暂时关闭引导
          </button>
        </>
      )}
      <p
        aria-atomic="true"
        aria-live="polite"
        className="sr-only"
        ref={announcementRef}
        tabIndex={-1}
      >
        {announcement}
      </p>
      {snapshot.error ? (
        <p aria-live="assertive" className="error-text" role="alert">
          引导偏好未能安全保存；业务事实未受影响。
        </p>
      ) : null}
    </div>
  );
}

type OnboardingGuideSurfaceProps = {
  children: ReactNode;
  onResume?: () => void;
  onSkip?: () => void;
  step: GuideStep;
};

function OnboardingGuideSurface({
  children,
  onResume,
  onSkip,
  step,
}: OnboardingGuideSurfaceProps) {
  const snapshot = useOnboardingPreference();
  if (!snapshot.hydrated) return null;
  if (snapshot.preference.status.value === "dismissed") {
    return <OnboardingPreferenceControls onResume={onResume} step={step} />;
  }
  return (
    <>
      {children}
      <OnboardingPreferenceControls onSkip={onSkip} step={step} />
    </>
  );
}

const PROVIDER_KEYS = new Set([
  "apiKeyMask",
  "baseUrl",
  "createdAt",
  "defaultModel",
  "id",
  "name",
  "status",
  "updatedAt",
  "verifiedAt",
  "version",
]);
const PROVIDER_STATUSES = new Set([
  "verified",
  "key_unavailable",
  "key_corrupt",
]);

export type ProviderGuideFacts =
  | { kind: "empty"; providers: Provider[] }
  | { kind: "invalid"; providers: Provider[] }
  | { kind: "success"; providers: Provider[]; verifiedProviderId: string }
  | { kind: "unavailable"; providers: Provider[] };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function parseProvider(value: unknown): Provider | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !PROVIDER_KEYS.has(key)) ||
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.name) ||
    !isNonEmptyString(record.baseUrl) ||
    !isNonEmptyString(record.defaultModel) ||
    !isNonEmptyString(record.apiKeyMask) ||
    !PROVIDER_STATUSES.has(String(record.status)) ||
    !isTimestamp(record.verifiedAt) ||
    !Number.isInteger(record.version) ||
    (record.version as number) < 1 ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.updatedAt)
  ) {
    return null;
  }
  return {
    apiKeyMask: record.apiKeyMask,
    baseUrl: record.baseUrl,
    createdAt: record.createdAt,
    defaultModel: record.defaultModel,
    id: record.id,
    name: record.name,
    status: record.status as Provider["status"],
    updatedAt: record.updatedAt,
    verifiedAt: record.verifiedAt,
    version: record.version as number,
  };
}

export function parseProviderGuideEnvelope(value: unknown): ProviderGuideFacts {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "invalid", providers: [] };
  }
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).length !== 1 ||
    !Array.isArray(envelope.providers)
  ) {
    return { kind: "invalid", providers: [] };
  }
  const providers = envelope.providers.map(parseProvider);
  if (providers.some((provider) => provider === null)) {
    return { kind: "invalid", providers: [] };
  }
  const safeProviders = providers as Provider[];
  if (
    new Set(safeProviders.map((provider) => provider.id)).size !==
    safeProviders.length
  ) {
    return { kind: "invalid", providers: [] };
  }
  if (safeProviders.length === 0) return { kind: "empty", providers: [] };
  const verified = safeProviders.find(
    (provider) => provider.status === "verified",
  );
  return verified
    ? {
        kind: "success",
        providers: safeProviders,
        verifiedProviderId: verified.id,
      }
    : { kind: "unavailable", providers: safeProviders };
}

type ProviderOnboardingGuideProps = {
  facts: ProviderGuideFacts | null;
  loading: boolean;
  loadError: boolean;
  onContinue?: () => void;
  onFocusProvider: () => void;
  onRetry: () => void;
  onSkip?: () => void;
};

export function ProviderOnboardingGuide({
  facts,
  loading,
  loadError,
  onContinue,
  onFocusProvider,
  onRetry,
  onSkip,
}: ProviderOnboardingGuideProps) {
  const state = loading
    ? "loading"
    : loadError
      ? "error"
      : (facts?.kind ?? "invalid");

  return (
    <OnboardingGuideSurface
      onResume={state === "success" ? onContinue : undefined}
      onSkip={onSkip}
      step="provider"
    >
      <GuideRouteAnnouncer
        announcement="已进入 Provider 引导：连接模型服务"
        targetId="onboarding-provider-title"
        title="连接模型服务"
      />
      <section
      aria-busy={state === "loading"}
      aria-label="Provider 首次使用引导"
      className="onboarding-guide stack"
      role="region"
      >
      <div className="stack">
        <p className="eyebrow">首次使用引导 · Provider</p>
        <h2 id="onboarding-provider-title" tabIndex={-1}>
          连接模型服务
        </h2>
      </div>
      {state === "loading" ? (
        <p aria-busy="true" className="state-message">
          正在核对模型服务…
        </p>
      ) : state === "success" ? (
        <>
          <p className="onboarding-guide-success">
            已检测到 verified 模型服务，可以继续。
          </p>
          <p className="muted">
            <strong>状态：成功。</strong> 引导 ready 不等于 verified
            handle；执行期仍重新取得 handle、进入 sandbox 并遵守审批、审计和非
            executor 复核。
          </p>
          <div className="onboarding-guide-actions">
            {onContinue ? (
              <button className="button-primary" onClick={onContinue} type="button">
                继续
              </button>
            ) : null}
            <button className="button-secondary" onClick={onFocusProvider} type="button">
              聚焦已验证模型服务
            </button>
          </div>
        </>
      ) : state === "error" ? (
        <>
          <p aria-live="assertive" className="error-text" role="alert">
            无法核对模型服务，已停止引导前进。
          </p>
          <button className="button-secondary" onClick={onRetry} type="button">
            重新检测
          </button>
        </>
      ) : (
        <>
          <p aria-live="assertive" className="error-text" role="alert">
            {state === "empty"
              ? "尚无模型服务。请使用现有表面创建并验证连接。"
              : state === "unavailable"
                ? "模型服务凭据当前不可用。请使用现有表面修复后重新检测。"
                : "模型服务响应无效，已失败关闭。请核对现有表面。"}
          </p>
          <button className="button-secondary" onClick={onFocusProvider} type="button">
            {state === "empty"
              ? "创建模型服务"
              : state === "unavailable"
                ? "修复模型服务"
                : "核对模型服务"}
          </button>
        </>
      )}
      </section>
    </OnboardingGuideSurface>
  );
}

const AGENT_KEYS = new Set([
  "accentToken",
  "avatarText",
  "createdAt",
  "id",
  "maxHandoffs",
  "maxTokens",
  "model",
  "name",
  "permissions",
  "providerId",
  "reviewCapable",
  "role",
  "skillIds",
  "systemPrompt",
  "updatedAt",
  "version",
]);
const ACCENT_TOKENS = new Set([
  "sage",
  "terracotta",
  "gold",
  "slate",
  "rose",
  "olive",
]);
const MEMBER_KEYS = new Set([
  "accentToken",
  "agentId",
  "avatarText",
  "joinedAt",
  "model",
  "name",
  "permissions",
  "role",
  "skillNames",
]);
const PERMISSION_KEYS = new Set(["readFiles", "runCommands", "writeFiles"]);

function isBooleanPermissions(
  value: unknown,
): value is AgentProfile["permissions"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === PERMISSION_KEYS.size &&
    Object.keys(record).every((key) => PERMISSION_KEYS.has(key)) &&
    typeof record.readFiles === "boolean" &&
    typeof record.runCommands === "boolean" &&
    typeof record.writeFiles === "boolean"
  );
}

function parseAgent(value: unknown): AgentProfile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== AGENT_KEYS.size ||
    Object.keys(record).some((key) => !AGENT_KEYS.has(key)) ||
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.name) ||
    !isNonEmptyString(record.role) ||
    !isNonEmptyString(record.systemPrompt) ||
    !isNonEmptyString(record.providerId) ||
    !isNonEmptyString(record.model) ||
    !isNonEmptyString(record.avatarText) ||
    !ACCENT_TOKENS.has(String(record.accentToken)) ||
    !Array.isArray(record.skillIds) ||
    !record.skillIds.every(isNonEmptyString) ||
    new Set(record.skillIds).size !== record.skillIds.length ||
    !isBooleanPermissions(record.permissions) ||
    typeof record.reviewCapable !== "boolean" ||
    !Number.isInteger(record.maxTokens) ||
    (record.maxTokens as number) < 1 ||
    !Number.isInteger(record.maxHandoffs) ||
    (record.maxHandoffs as number) < 1 ||
    !Number.isInteger(record.version) ||
    (record.version as number) < 1 ||
    !isTimestamp(record.createdAt) ||
    !isTimestamp(record.updatedAt)
  ) {
    return null;
  }
  return record as AgentProfile;
}

function parseMemberAgentId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== MEMBER_KEYS.size ||
    Object.keys(record).some((key) => !MEMBER_KEYS.has(key)) ||
    !isNonEmptyString(record.agentId) ||
    !isTimestamp(record.joinedAt) ||
    !isNonEmptyString(record.name) ||
    !isNonEmptyString(record.role) ||
    !isNonEmptyString(record.model) ||
    !isNonEmptyString(record.avatarText) ||
    !isNonEmptyString(record.accentToken) ||
    !Array.isArray(record.skillNames) ||
    !record.skillNames.every(isNonEmptyString) ||
    !isBooleanPermissions(record.permissions)
  ) {
    return null;
  }
  return record.agentId;
}

export type AgentGuideFacts =
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "provider_unavailable" }
  | { kind: "members_insufficient" }
  | { kind: "reviewer_missing" }
  | { kind: "project_pending"; focusAgentId: string }
  | { kind: "success"; reviewerAgentId: string };

export function parseAgentGuideEnvelopes(
  providerValue: unknown,
  agentValue: unknown,
  membershipValue?: unknown,
): AgentGuideFacts {
  const providerFacts = parseProviderGuideEnvelope(providerValue);
  if (providerFacts.kind === "invalid") return { kind: "invalid" };
  if (!agentValue || typeof agentValue !== "object" || Array.isArray(agentValue)) {
    return { kind: "invalid" };
  }
  const agentEnvelope = agentValue as Record<string, unknown>;
  if (
    Object.keys(agentEnvelope).length !== 1 ||
    !Array.isArray(agentEnvelope.agents)
  ) {
    return { kind: "invalid" };
  }
  const parsedAgents = agentEnvelope.agents.map(parseAgent);
  if (parsedAgents.some((agent) => agent === null)) return { kind: "invalid" };
  const agents = parsedAgents as AgentProfile[];
  if (new Set(agents.map((agent) => agent.id)).size !== agents.length) {
    return { kind: "invalid" };
  }
  if (agents.length === 0) return { kind: "empty" };
  const verifiedProviderIds = new Set(
    providerFacts.providers
      .filter((provider) => provider.status === "verified")
      .map((provider) => provider.id),
  );
  const eligibleAgents = agents.filter((agent) =>
    verifiedProviderIds.has(agent.providerId),
  );
  if (eligibleAgents.length === 0) return { kind: "provider_unavailable" };
  if (membershipValue === undefined) {
    return { focusAgentId: eligibleAgents[0].id, kind: "project_pending" };
  }
  if (
    !membershipValue ||
    typeof membershipValue !== "object" ||
    Array.isArray(membershipValue)
  ) {
    return { kind: "invalid" };
  }
  const membershipEnvelope = membershipValue as Record<string, unknown>;
  if (
    Object.keys(membershipEnvelope).length !== 2 ||
    !Array.isArray(membershipEnvelope.members) ||
    !Number.isInteger(membershipEnvelope.projectVersion) ||
    (membershipEnvelope.projectVersion as number) < 1
  ) {
    return { kind: "invalid" };
  }
  const parsedMemberIds = membershipEnvelope.members.map(parseMemberAgentId);
  if (parsedMemberIds.some((id) => id === null)) return { kind: "invalid" };
  const memberIds = new Set(parsedMemberIds as string[]);
  if (memberIds.size < 2) return { kind: "members_insufficient" };
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const memberAgents = [...memberIds].map((id) => agentsById.get(id));
  if (
    memberAgents.some(
      (agent) => !agent || !verifiedProviderIds.has(agent.providerId),
    )
  ) {
    return { kind: "provider_unavailable" };
  }
  const reviewer = memberAgents.find((agent) => agent?.reviewCapable);
  return reviewer
    ? { kind: "success", reviewerAgentId: reviewer.id }
    : { kind: "reviewer_missing" };
}

type AgentOnboardingGuideProps = {
  facts: AgentGuideFacts | null;
  loading: boolean;
  loadError: boolean;
  onContinue?: () => void;
  onFocusAgent: () => void;
  onRetry: () => void;
  onSkip?: () => void;
};

export function AgentOnboardingGuide({
  facts,
  loading,
  loadError,
  onContinue,
  onFocusAgent,
  onRetry,
  onSkip,
}: AgentOnboardingGuideProps) {
  const state = loading ? "loading" : loadError ? "error" : (facts?.kind ?? "invalid");
  const success = state === "success";
  const projectPending = state === "project_pending";
  return (
    <OnboardingGuideSurface
      onResume={success || projectPending ? onContinue : undefined}
      onSkip={onSkip}
      step="agent"
    >
      <GuideRouteAnnouncer
        announcement="已进入 Agent 引导：连接 Agent 与未来复核资格"
        targetId="onboarding-agent-title"
        title="连接 Agent"
      />
      <section
        aria-busy={state === "loading"}
        aria-label="Agent 首次使用引导"
        className="onboarding-guide stack"
        role="region"
      >
        <div className="stack">
          <p className="eyebrow">首次使用引导 · Agent</p>
          <h2 id="onboarding-agent-title" tabIndex={-1}>
            连接 Agent 与未来复核资格
          </h2>
        </div>
        {state === "loading" ? (
          <p aria-busy="true" className="state-message">
            正在核对 Agent 与项目成员…
          </p>
        ) : success ? (
          <>
            <p className="onboarding-guide-success">
              当前项目已有两名合格成员，未来复核候选存在。
            </p>
            <p className="muted">
              <strong>状态：成功。</strong>{" "}
              正式运行时仍会动态排除 executor；这不表示已完成独立复核。
              accepted 也不等于 delivered。
            </p>
            <div className="onboarding-guide-actions">
              {onContinue ? (
                <button className="button-primary" onClick={onContinue} type="button">
                  继续
                </button>
              ) : null}
              <button className="button-secondary" onClick={onFocusAgent} type="button">
                聚焦未来复核候选
              </button>
            </div>
          </>
        ) : projectPending ? (
          <>
            <p className="onboarding-guide-success">
              已检测到引用 verified Provider 的 Agent。
            </p>
            <p className="muted">
              <strong>状态：成功。</strong>{" "}
              选择项目后才会核对两名成员与未来复核候选；不会提前宣称独立复核。
            </p>
            <div className="onboarding-guide-actions">
              {onContinue ? (
                <button className="button-primary" onClick={onContinue} type="button">
                  继续
                </button>
              ) : null}
              <button className="button-secondary" onClick={onFocusAgent} type="button">
                聚焦合格 Agent
              </button>
            </div>
          </>
        ) : state === "error" ? (
          <>
            <p aria-live="assertive" className="error-text" role="alert">
              无法核对 Agent 与项目成员，已停止引导前进。
            </p>
            <button className="button-secondary" onClick={onRetry} type="button">
              重新检测
            </button>
          </>
        ) : (
          <>
            <p aria-live="assertive" className="error-text" role="alert">
              {state === "empty"
                ? "尚无 Agent。请使用现有 Agent 表面创建。"
                : state === "members_insufficient"
                  ? "当前项目至少需要两名不同的合格 Agent，才能形成角色分离。"
                  : state === "reviewer_missing"
                    ? "当前项目还没有 reviewCapable 的未来复核候选。"
                    : state === "provider_unavailable"
                      ? "项目成员必须全部引用 verified Provider。"
                      : "Agent 或成员响应无效，已失败关闭。"}
            </p>
            <button className="button-secondary" onClick={onFocusAgent} type="button">
              修复 Agent 配置
            </button>
          </>
        )}
      </section>
    </OnboardingGuideSurface>
  );
}

type WorkspaceOnboardingGuideProps = {
  facts: WorkspaceGuideEnvelope | null;
  loading: boolean;
  loadError: boolean;
  onContinue?: () => void;
  onFocusWorkspace: () => void;
  onRetry: () => void;
  onSkip?: () => void;
};

export function WorkspaceOnboardingGuide({
  facts,
  loading,
  loadError,
  onContinue,
  onFocusWorkspace,
  onRetry,
  onSkip,
}: WorkspaceOnboardingGuideProps) {
  const state = loading
    ? "loading"
    : loadError
      ? "error"
      : (facts?.kind ?? "invalid");

  return (
    <OnboardingGuideSurface
      onResume={state === "success" ? onContinue : undefined}
      onSkip={onSkip}
      step="workspace"
    >
      <GuideRouteAnnouncer
        announcement="已进入 Workspace 引导：绑定项目工作区"
        targetId="onboarding-workspace-title"
        title="绑定项目工作区"
      />
      <section
      aria-busy={state === "loading"}
      aria-label="Workspace 首次使用引导"
      className="onboarding-guide stack"
      role="region"
      >
      <div className="stack">
        <p className="eyebrow">首次使用引导 · Workspace</p>
        <h3 id="onboarding-workspace-title" tabIndex={-1}>
          绑定项目工作区
        </h3>
      </div>
      {state === "loading" ? (
        <p aria-busy="true" className="state-message">
          正在核对工作区绑定…
        </p>
      ) : state === "success" ? (
        <>
          <p className="onboarding-guide-success">
            工作区已 bind ready：目录已规范化且当前可读。
          </p>
          <p className="muted">
            <strong>状态：成功。</strong> ready 不等于 verified handle。
          </p>
          <p className="muted">
            真实执行仍会重新取得 verified handle、进入 sandbox，并遵守审批与审计。
            独立复核仍由非 executor 的合格成员完成。
          </p>
          <div className="onboarding-guide-actions">
            {onContinue ? (
              <button className="button-primary" onClick={onContinue} type="button">
                继续
              </button>
            ) : null}
            <button
              className="button-secondary"
              onClick={onFocusWorkspace}
              type="button"
            >
              聚焦工作区绑定
            </button>
          </div>
        </>
      ) : state === "error" ? (
        <>
          <p aria-live="assertive" className="error-text" role="alert">
            无法核对工作区，已停止引导前进。
          </p>
          <button className="button-secondary" onClick={onRetry} type="button">
            重新检测
          </button>
        </>
      ) : (
        <>
          <p aria-live="assertive" className="error-text" role="alert">
            {state === "empty"
              ? "尚未绑定工作区。请使用现有 WorkspaceSetup 完成绑定。"
              : "工作区响应无效，已失败关闭。请核对现有 WorkspaceSetup。"}
          </p>
          <button
            className="button-secondary"
            onClick={onFocusWorkspace}
            type="button"
          >
            {state === "empty" ? "绑定工作区" : "核对工作区"}
          </button>
        </>
      )}
      </section>
    </OnboardingGuideSurface>
  );
}

type MembersOnboardingGuideProps = {
  facts: AgentGuideFacts | null;
  loading: boolean;
  loadError: boolean;
  onContinue?: () => void;
  onFocusMembers: () => void;
  onRetry: () => void;
  onSkip?: () => void;
};

export function MembersOnboardingGuide({
  facts,
  loading,
  loadError,
  onContinue,
  onFocusMembers,
  onRetry,
  onSkip,
}: MembersOnboardingGuideProps) {
  const state = loading
    ? "loading"
    : loadError
      ? "error"
      : (facts?.kind ?? "invalid");
  const action =
    state === "members_insufficient" || state === "empty"
      ? "选择更多项目成员"
      : state === "provider_unavailable"
        ? "修复成员 Provider"
        : state === "reviewer_missing"
          ? "选择未来复核候选"
          : "核对项目成员";

  return (
    <OnboardingGuideSurface
      onResume={state === "success" ? onContinue : undefined}
      onSkip={onSkip}
      step="members"
    >
      <GuideRouteAnnouncer
        announcement="已进入 Members 引导：组建可分离的成员角色"
        targetId="onboarding-members-title"
        title="配置项目成员"
      />
      <section
      aria-busy={state === "loading"}
      aria-label="Members 首次使用引导"
      className="onboarding-guide stack"
      role="region"
      >
      <div className="stack">
        <p className="eyebrow">首次使用引导 · Members</p>
        <h3 id="onboarding-members-title" tabIndex={-1}>
          组建可分离的成员角色
        </h3>
      </div>
      {state === "loading" ? (
        <p aria-busy="true" className="state-message">
          正在核对成员、Provider 与未来复核资格…
        </p>
      ) : state === "success" ? (
        <>
          <p className="onboarding-guide-success">
            两名合格成员与未来复核候选已就绪，无需重新保存。
          </p>
          <p className="muted">
            <strong>状态：成功。</strong>{" "}
            正式复核仍会动态排除 executor；引导资格不代表复核已经完成。
          </p>
          <div className="onboarding-guide-actions">
            {onContinue ? (
              <button className="button-primary" onClick={onContinue} type="button">
                继续
              </button>
            ) : null}
            <button
              className="button-secondary"
              onClick={onFocusMembers}
              type="button"
            >
              聚焦合格成员名册
            </button>
          </div>
        </>
      ) : state === "error" ? (
        <>
          <p aria-live="assertive" className="error-text" role="alert">
            无法核对项目成员，已停止引导前进。
          </p>
          <button className="button-secondary" onClick={onRetry} type="button">
            重新检测成员
          </button>
        </>
      ) : (
        <>
          <p aria-live="assertive" className="error-text" role="alert">
            {state === "empty" || state === "members_insufficient"
              ? "当前项目至少需要两名不同的合格成员，才能形成角色分离。"
              : state === "provider_unavailable"
                ? "成员 Agent 必须关联 verified Provider；请替换或修复不合格成员。"
                : state === "reviewer_missing"
                  ? "当前成员缺少 reviewCapable 的未来复核候选。"
                  : "成员、Agent 或 Provider 响应无效，已失败关闭。"}
          </p>
          <button
            className="button-secondary"
            onClick={onFocusMembers}
            type="button"
          >
            {action}
          </button>
        </>
      )}
      </section>
    </OnboardingGuideSurface>
  );
}

type OnboardingGuideProps = {
  onCreateProject: () => void;
  onFocusChat: () => void;
  onFocusMission: () => void;
  onSelectProject: (projectId: string) => void;
  onSkip?: () => void;
  projectId: string | null;
  projects: Project[];
  refreshKey?: number;
  step: "project-select" | "goal";
};

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("read");
  return response.json();
}

export function OnboardingGuide({
  onCreateProject,
  onFocusChat,
  onFocusMission,
  onSelectProject,
  onSkip,
  projectId,
  projects,
  refreshKey = 0,
  step,
}: OnboardingGuideProps) {
  const [readiness, setReadiness] = useState<Readiness>(
    step === "goal" ? "loading" : "mission",
  );
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (step !== "goal" || !projectId) return;
    let active = true;
    setReadiness("loading");
    void Promise.all([
      readJson("/api/providers"),
      readJson("/api/agents"),
      readJson(`/api/projects/${projectId}/workspace`),
      readJson(`/api/projects/${projectId}/members`),
      readJson(`/api/projects/${projectId}/mission`),
      readJson(`/api/projects/${projectId}/collaboration`),
    ])
      .then(([providerState, agentState, workspace, members, missionState, collaboration]) => {
        if (!active) return;
        const agentFacts = parseAgentGuideEnvelopes(
          providerState,
          agentState,
          members,
        );
        const workspaceFacts = parseWorkspaceGuideEnvelope(workspace);
        const missionFacts = parseMissionGuideEnvelope(missionState, projectId);
        const collaborationFacts = parseCollaborationGuideEnvelope(
          collaboration,
          projectId,
        );
        if (
          agentFacts.kind === "invalid" ||
          workspaceFacts.kind === "invalid" ||
          missionFacts.kind === "invalid" ||
          collaborationFacts.kind === "invalid"
        ) {
          setReadiness("error");
          return;
        }
        if (
          workspaceFacts.kind !== "success" ||
          agentFacts.kind !== "success"
        ) {
          setReadiness("blocked");
          return;
        }
        if (missionFacts.kind === "empty") {
          setReadiness("mission");
          return;
        }
        setReadiness(
          collaborationFacts.kind === "success" && collaborationFacts.started
            ? "started"
            : "accepted",
        );
      })
      .catch(() => {
        if (active) setReadiness("error");
      });
    return () => {
      active = false;
    };
  }, [projectId, refreshKey, reloadKey, step]);

  useEffect(() => {
    if (step !== "goal" || readiness === "loading") return;
    if (readiness === "started") {
      completeOnboarding(true);
      updateOnboardingDrift(true);
      return;
    }
    updateOnboardingDrift(false);
  }, [readiness, step]);

  const missionDisabled =
    readiness === "loading" ||
    readiness === "blocked" ||
    readiness === "error";
  const chatDisabled = missionDisabled || readiness === "mission";

  const routeTitle =
    step === "project-select" ? "选择项目" : "创建目标并启动协作";
  return (
    <OnboardingGuideSurface onSkip={onSkip} step={step}>
      <GuideRouteAnnouncer
        announcement={`已进入引导：${routeTitle}`}
        targetId="onboarding-guide-title"
        title={routeTitle}
      />
      <section
      aria-busy={step === "goal" && readiness === "loading"}
      aria-label="首次使用引导"
      className="onboarding-guide stack"
      role="region"
      >
      <div className="stack">
        <p className="eyebrow">首次使用引导</p>
        <h2 id="onboarding-guide-title" tabIndex={-1}>
          {routeTitle}
        </h2>
      </div>
      {step === "project-select" ? (
        <>
          <p>选择要开始引导的项目。当前任务不会替你静默选择。</p>
          {projects.length > 0 ? (
            <ul
              aria-label="可访问项目"
              className="onboarding-guide-actions project-list"
            >
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    className="button-secondary"
                    onClick={() => onSelectProject(project.id)}
                    type="button"
                  >
                    {project.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <p aria-live="assertive" className="state-message" role="alert">
                尚无可选项目。请先使用现有项目表面创建项目。
              </p>
              <button
                className="button-primary"
                onClick={onCreateProject}
                type="button"
              >
                使用现有表面创建项目
              </button>
            </>
          )}
        </>
      ) : (
        <>
          {readiness === "loading" ? (
            <p aria-busy="true" className="state-message">
              正在核对 Provider、Agent、工作区与成员…
            </p>
          ) : readiness === "mission" ? (
            <p className="onboarding-guide-success">
              资源已就绪，可以创建使命并启动协作。
            </p>
          ) : readiness === "accepted" ? (
            <p className="onboarding-guide-success">
              目标已受理。下一步可在项目群聊启动协作；尚未执行、复核或交付。
            </p>
          ) : readiness === "started" ? (
            <p className="onboarding-guide-success">
              协作已启动且 owner message 与 run_started 已对账；尚未执行、复核或交付。
            </p>
          ) : (
            <>
              <p aria-live="assertive" className="error-text" role="alert">
                {readiness === "blocked"
                  ? "资源尚未就绪。本阶段只支持资源已完整的路径，请先完成现有配置。"
                  : "无法核对资源，已停止引导写操作。"}
              </p>
              {readiness === "error" ? (
                <button
                  className="button-secondary"
                  onClick={() => setReloadKey((current) => current + 1)}
                  type="button"
                >
                  仅重新核对目标事实
                </button>
              ) : null}
            </>
          )}
          {!missionDisabled ? (
            <>
              <p className="muted">
                <strong>状态：成功。</strong> accepted 不等于 delivered。
              </p>
              <p className="muted">
                后续正式执行仍会取得 verified handle、进入 sandbox
                并遵守审批；独立复核必须由非 executor 的合格成员完成。
              </p>
            </>
          ) : null}
          <div className="onboarding-guide-actions">
            <button
              aria-describedby={
                missionDisabled ? "onboarding-disabled-reason" : undefined
              }
              className="button-primary"
              disabled={missionDisabled}
              onClick={onFocusMission}
              type="button"
            >
              {readiness === "accepted" || readiness === "started"
                ? "查看已受理使命"
                : "创建使命目标"}
            </button>
            <button
              aria-describedby={
                chatDisabled ? "onboarding-disabled-reason" : undefined
              }
              className="button-secondary"
              disabled={chatDisabled}
              onClick={onFocusChat}
              type="button"
            >
              {readiness === "started"
                ? "查看已启动协作"
                : "在项目群聊启动协作"}
            </button>
          </div>
          {missionDisabled || chatDisabled ? (
            <p className="muted" id="onboarding-disabled-reason">
              {missionDisabled
                ? "只有 verified Provider、合格项目成员和 ready 工作区全部存在时才能继续。"
                : "先在现有使命看板创建并确认 Mission，才能启动项目群聊协作。"}
            </p>
          ) : null}
        </>
      )}
      </section>
    </OnboardingGuideSurface>
  );
}

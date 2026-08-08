"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  trapModalFocus,
  useModalSurface,
  useNarrowMode,
} from "@/components/mobile-dialog";
import {
  AgentOnboardingGuide,
  parseAgentGuideEnvelopes,
  type AgentGuideFacts,
} from "@/components/onboarding-guide";
import type {
  AccentToken,
  AgentProfile,
  AgentTemplate,
  Provider,
  Skill,
  ToolPermissions,
} from "@/src/shared/team-contracts";

type AgentField =
  | "name"
  | "role"
  | "systemPrompt"
  | "providerId"
  | "model"
  | "reviewCapable"
  | "skillIds"
  | "permissions.readFiles"
  | "permissions.writeFiles"
  | "permissions.runCommands"
  | "maxTokens"
  | "maxHandoffs"
  | "avatarText"
  | "accentToken";

type ApiFailure = {
  error?: {
    code?: string;
    fields?: Array<{ field: string; code: string }>;
  };
};

const accents: Array<{ value: AccentToken; label: string }> = [
  { label: "鼠尾草", value: "sage" },
  { label: "陶土", value: "terracotta" },
  { label: "金色", value: "gold" },
  { label: "石板", value: "slate" },
  { label: "玫瑰", value: "rose" },
  { label: "橄榄", value: "olive" },
];

function errorCopy(code?: string): string {
  if (code === "RESOURCE_CONFLICT") return "Agent 已被更新，请重新加载后再编辑。";
  if (code === "AGENT_NOT_FOUND") return "未找到要编辑的 Agent。";
  if (code === "PROVIDER_NOT_VERIFIED") return "所选模型服务尚未验证。";
  if (code === "INVALID_SKILL_REFERENCE") return "所选技能已失效，请重新选择。";
  if (code === "INVALID_INPUT") return "Agent 内容无效，请检查标记的字段。";
  return "无法保存 Agent，请稍后重试。";
}

function fieldCopy(field: string, code: string): string {
  if (field === "maxTokens") return "Token 预算必须是 1–1000000 的整数。";
  if (field === "maxHandoffs") return "接力轮次必须是 1–100 的整数。";
  if (field === "avatarText") return "头像文字必须包含 1–4 个字符。";
  if (field === "skillIds") return "所选技能无效。";
  const labels: Partial<Record<AgentField, string>> = {
    accentToken: "强调色",
    model: "模型",
    name: "Agent 名称",
    providerId: "模型服务",
    role: "职责",
    systemPrompt: "系统提示",
    "permissions.readFiles": "读取文件权限",
    "permissions.runCommands": "运行命令权限",
    "permissions.writeFiles": "写入文件权限",
  };
  const label = labels[field as AgentField] ?? "此字段";
  if (code === "too_long") return `${label}超过长度限制。`;
  if (code === "required") return `${label}为必填项。`;
  return `${label}无效。`;
}

const AGENT_EDITOR_INERT = [".cockpit-sidebar", "#agent-resource-panel"];
class KnownAgentWriteError extends Error {}

const AGENT_FIELD_IDS: Record<AgentField, string> = {
  accentToken: "agent-accent",
  avatarText: "agent-avatar",
  maxHandoffs: "agent-max-handoffs",
  maxTokens: "agent-max-tokens",
  model: "agent-model",
  name: "agent-name",
  reviewCapable: "agent-review-capable",
  "permissions.readFiles": "agent-permission-readFiles",
  "permissions.runCommands": "agent-permission-runCommands",
  "permissions.writeFiles": "agent-permission-writeFiles",
  providerId: "agent-provider",
  role: "agent-role",
  skillIds: "agent-skills",
  systemPrompt: "agent-system-prompt",
};

function isAgentField(field: string): field is AgentField {
  return field in AGENT_FIELD_IDS;
}

function permissionText(permissions: ToolPermissions): string {
  const enabled = [
    permissions.readFiles ? "读取" : "",
    permissions.writeFiles ? "写入" : "",
    permissions.runCommands ? "命令" : "",
  ].filter(Boolean);
  return enabled.length > 0 ? enabled.join(" · ") : "无工具权限";
}

type AgentPanelProps = {
  guide?: "agent";
  onGuideContinue?: () => void;
  onGuideSkip?: () => void;
  projectId?: string;
};

export function AgentPanel({
  guide,
  onGuideContinue,
  onGuideSkip,
  projectId,
}: AgentPanelProps = {}) {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [templateId, setTemplateId] = useState("blank");
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [reviewCapable, setReviewCapable] = useState(false);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<ToolPermissions>({
    readFiles: true,
    runCommands: false,
    writeFiles: false,
  });
  const [maxTokens, setMaxTokens] = useState("16000");
  const [maxHandoffs, setMaxHandoffs] = useState("8");
  const [avatarText, setAvatarText] = useState("");
  const [accentToken, setAccentToken] = useState<AccentToken>("sage");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<AgentField, string>>
  >({});
  const [status, setStatus] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [guideFacts, setGuideFacts] = useState<AgentGuideFacts | null>(null);
  const [guideRequestError, setGuideRequestError] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null);
  const mobile = useNarrowMode();
  const errorRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const headingRefs = useRef(new Map<string, HTMLHeadingElement>());

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setLoadError(null);
    setGuideFacts(null);
    setGuideRequestError(false);
    void Promise.all([
      fetch("/api/agent-templates"),
      fetch("/api/providers"),
      fetch("/api/skills"),
      fetch("/api/agents"),
      projectId
        ? fetch(`/api/projects/${projectId}/members`)
        : Promise.resolve(null),
    ])
      .then(async ([
        templateResponse,
        providerResponse,
        skillResponse,
        agentResponse,
        memberResponse,
      ]) => {
        if (
          !templateResponse.ok ||
          !providerResponse.ok ||
          !skillResponse.ok ||
          !agentResponse.ok ||
          (memberResponse !== null && !memberResponse.ok)
        ) {
          throw new Error("agent resources unavailable");
        }
        return Promise.all([
          templateResponse.json() as Promise<unknown>,
          providerResponse.json() as Promise<unknown>,
          skillResponse.json() as Promise<unknown>,
          agentResponse.json() as Promise<unknown>,
          memberResponse?.json() as Promise<unknown> | undefined,
        ]);
      })
      .then(([
        templateValue,
        providerValue,
        skillValue,
        agentValue,
        memberValue,
      ]) => {
        if (!active) return;
        const templatePayload = templateValue as { templates?: AgentTemplate[] };
        const providerPayload = providerValue as { providers?: Provider[] };
        const skillPayload = skillValue as { skills?: Skill[] };
        const agentPayload = agentValue as { agents?: AgentProfile[] };
        if (guide === "agent") {
          setGuideFacts(
            parseAgentGuideEnvelopes(providerValue, agentValue, memberValue),
          );
        }
        setTemplates(Array.isArray(templatePayload.templates) ? templatePayload.templates : []);
        setProviders(Array.isArray(providerPayload.providers) ? providerPayload.providers : []);
        setSkills(Array.isArray(skillPayload.skills) ? skillPayload.skills : []);
        setAgents(Array.isArray(agentPayload.agents) ? agentPayload.agents : []);
      })
      .catch(() => {
        if (active) {
          setGuideRequestError(true);
          setLoadError("暂时无法加载 Agent，请稍后重试。");
        }
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [guide, projectId, reloadKey]);

  useEffect(() => {
    if (loadError || (formError && Object.keys(fieldErrors).length === 0)) {
      errorRef.current?.focus();
    }
  }, [fieldErrors, formError, loadError]);

  useEffect(() => {
    if (!focusAgentId) return;
    headingRefs.current.get(focusAgentId)?.focus();
    setFocusAgentId(null);
  }, [agents, focusAgentId]);

  useModalSurface(mobile && editorOpen, dialogRef, AGENT_EDITOR_INERT);

  const verifiedProviders = useMemo(
    () => providers.filter((provider) => provider.status === "verified"),
    [providers],
  );
  const selectedProvider = verifiedProviders.find(
    (provider) => provider.id === providerId,
  );
  const fieldsReady =
    name.trim() !== "" &&
    role.trim() !== "" &&
    systemPrompt.trim() !== "" &&
    providerId !== "" &&
    model !== "" &&
    avatarText.trim() !== "" &&
    Number(maxTokens) >= 1 &&
    Number(maxHandoffs) >= 1;

  function resetBlank() {
    setEditing(null);
    setTemplateId("blank");
    setName("");
    setRole("");
    setSystemPrompt("");
    setProviderId("");
    setModel("");
    setReviewCapable(false);
    setSkillIds([]);
    setPermissions({ readFiles: true, runCommands: false, writeFiles: false });
    setMaxTokens("16000");
    setMaxHandoffs("8");
    setAvatarText("");
    setAccentToken("sage");
    setFormError(null);
    setFieldErrors({});
    setStatus("");
  }

  function startCreate(event?: { currentTarget: EventTarget | null }) {
    openerRef.current =
      event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    resetBlank();
    setEditorOpen(true);
    if (!mobile) queueMicrotask(() => nameRef.current?.focus());
  }

  function startEdit(agent: AgentProfile, opener: HTMLElement) {
    openerRef.current = opener;
    setEditing(agent);
    setTemplateId("blank");
    setName(agent.name);
    setRole(agent.role);
    setSystemPrompt(agent.systemPrompt);
    setProviderId(agent.providerId);
    setModel(agent.model);
    setReviewCapable(agent.reviewCapable);
    setSkillIds(agent.skillIds);
    setPermissions(agent.permissions);
    setMaxTokens(String(agent.maxTokens));
    setMaxHandoffs(String(agent.maxHandoffs));
    setAvatarText(agent.avatarText);
    setAccentToken(agent.accentToken);
    setFormError(null);
    setFieldErrors({});
    setStatus("");
    setEditorOpen(true);
    if (!mobile) queueMicrotask(() => nameRef.current?.focus());
  }

  function closeEditor() {
    setEditorOpen(false);
    queueMicrotask(() => openerRef.current?.focus());
  }

  function selectTemplate(nextId: string) {
    setTemplateId(nextId);
    if (nextId === "blank") {
      setName("");
      setRole("");
      setSystemPrompt("");
      setAvatarText("");
      setAccentToken("sage");
      setReviewCapable(false);
      return;
    }
    const template = templates.find(({ id }) => id === nextId);
    if (!template) return;
    setName(template.name);
    setRole(template.role);
    setSystemPrompt(template.systemPrompt);
    setAvatarText(template.avatarText);
    setAccentToken(template.accentToken);
    setReviewCapable(template.reviewCapable);
  }

  function toggleSkill(skillId: string, checked: boolean) {
    setSkillIds((current) =>
      checked
        ? [...current, skillId]
        : current.filter((currentId) => currentId !== skillId),
    );
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fieldsReady || isSaving) return;
    setIsSaving(true);
    setFormError(null);
    setFieldErrors({});
    setStatus("");
    const body = {
      accentToken,
      avatarText,
      ...(editing ? { expectedVersion: editing.version } : {}),
      maxHandoffs: Number(maxHandoffs),
      maxTokens: Number(maxTokens),
      model,
      name,
      permissions,
      providerId,
      reviewCapable,
      role,
      skillIds,
      systemPrompt,
    };
    try {
      const response = await fetch(
        editing ? `/api/agents/${editing.id}` : "/api/agents",
        {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
          method: editing ? "PATCH" : "POST",
        },
      );
      const payload = (await response.json()) as ApiFailure & {
        agent?: AgentProfile;
      };
      if (!response.ok) {
        const nextErrors: Partial<Record<AgentField, string>> = {};
        for (const issue of payload.error?.fields ?? []) {
          if (isAgentField(issue.field)) {
            nextErrors[issue.field] = fieldCopy(issue.field, issue.code);
          }
        }
        setFieldErrors(nextErrors);
        const firstField = payload.error?.fields
          ?.map(({ field }) => field)
          .find(isAgentField);
        if (firstField) {
          queueMicrotask(() => document.getElementById(AGENT_FIELD_IDS[firstField])?.focus());
        }
        throw new KnownAgentWriteError(payload.error?.code ?? "SAVE_FAILED");
      }
      if (!payload.agent) throw new Error("uncertain response");
      const saved = payload.agent;
      applySavedAgent(saved, "Agent 已保存。");
    } catch (cause) {
      if (cause instanceof KnownAgentWriteError) {
        setFormError(errorCopy(cause.message));
      } else {
        await reconcileUncertainWrite(body);
      }
    } finally {
      setIsSaving(false);
    }
  }

  function applySavedAgent(saved: AgentProfile, message: string) {
    setAgents((current) =>
      current.some(({ id }) => id === saved.id)
        ? current.map((agent) => (agent.id === saved.id ? saved : agent))
        : [...current, saved],
    );
    setFocusAgentId(saved.id);
    setStatus(message);
    setEditing(saved);
    setFormError(null);
    if (mobile) setEditorOpen(false);
  }

  async function reconcileUncertainWrite(body: Record<string, unknown>) {
    try {
      const response = await fetch("/api/agents");
      if (!response.ok) throw new Error("reconciliation failed");
      const payload = (await response.json()) as { agents?: unknown };
      if (!Array.isArray(payload.agents)) throw new Error("reconciliation failed");
      if (editing) {
        const confirmed = (payload.agents as AgentProfile[]).find(
          (agent) =>
            agent.id === editing.id &&
            agent.version > editing.version &&
            agent.name === body.name &&
            agent.role === body.role &&
            agent.systemPrompt === body.systemPrompt &&
            agent.providerId === body.providerId &&
            agent.model === body.model &&
            agent.reviewCapable === body.reviewCapable &&
            agent.maxTokens === body.maxTokens &&
            agent.maxHandoffs === body.maxHandoffs &&
            agent.avatarText === body.avatarText &&
            agent.accentToken === body.accentToken &&
            JSON.stringify(agent.skillIds) === JSON.stringify(body.skillIds) &&
            JSON.stringify(agent.permissions) === JSON.stringify(body.permissions),
        );
        if (confirmed) {
          applySavedAgent(
            confirmed,
            "已通过事实核对确认 Agent 已保存。",
          );
          return;
        }
      }
    } catch {
      // Keep the original editor and draft when the write cannot be confirmed.
    }
    setFormError(
      "保存结果不确定，已核对 Agent 列表但无法确认。请保留当前表面并人工核对，不会自动重发。",
    );
  }

  const editor = (
    <aside
      aria-labelledby="agent-editor-title"
      aria-modal={mobile ? true : undefined}
      className="cockpit-context agent-editor"
      data-open={mobile && editorOpen ? "true" : undefined}
      onKeyDown={mobile ? (event) => trapModalFocus(event, closeEditor) : undefined}
      ref={dialogRef}
      role={mobile ? "dialog" : undefined}
    >
      <button
        aria-label="关闭 Agent 编辑器"
        className="drawer-close"
        data-dialog-close="true"
        onClick={closeEditor}
        type="button"
      >
        关闭
      </button>
      <div className="stack">
        <p className="eyebrow">角色配置</p>
        <h2 id="agent-editor-title">{editing ? "编辑 Agent" : "创建 Agent"}</h2>
      </div>
      <form className="stack" onSubmit={save}>
        <div className="form-field">
          <label htmlFor="agent-template">创建方式</label>
          <select
            id="agent-template"
            onChange={(event) => selectTemplate(event.target.value)}
            value={templateId}
          >
            <option value="blank">空白</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name}模板
              </option>
            ))}
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="agent-name">Agent 名称</label>
          <input
            aria-describedby={fieldErrors.name ? "agent-name-error" : undefined}
            aria-invalid={fieldErrors.name ? true : undefined}
            id="agent-name"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：代码审查助手"
            ref={nameRef}
            required
            value={name}
          />
          {fieldErrors.name ? (
            <p className="error-text" id="agent-name-error">{fieldErrors.name}</p>
          ) : null}
        </div>
        <div className="form-field">
          <label htmlFor="agent-role">职责</label>
          <textarea
            aria-describedby={fieldErrors.role ? "agent-role-error" : undefined}
            aria-invalid={fieldErrors.role ? true : undefined}
            id="agent-role"
            maxLength={160}
            onChange={(event) => setRole(event.target.value)}
            required
            value={role}
          />
          {fieldErrors.role ? (
            <p className="error-text" id="agent-role-error">{fieldErrors.role}</p>
          ) : null}
        </div>
        <div className="form-field">
          <label htmlFor="agent-system-prompt">系统提示</label>
          <textarea
            aria-describedby={
              fieldErrors.systemPrompt ? "agent-system-prompt-error" : undefined
            }
            aria-invalid={fieldErrors.systemPrompt ? true : undefined}
            id="agent-system-prompt"
            maxLength={20_000}
            onChange={(event) => setSystemPrompt(event.target.value)}
            required
            value={systemPrompt}
          />
          {fieldErrors.systemPrompt ? (
            <p className="error-text" id="agent-system-prompt-error">
              {fieldErrors.systemPrompt}
            </p>
          ) : null}
        </div>
        <div className="form-field">
          <label htmlFor="agent-provider">模型服务</label>
          <select
            aria-describedby={fieldErrors.providerId ? "agent-provider-error" : undefined}
            aria-invalid={fieldErrors.providerId ? true : undefined}
            id="agent-provider"
            onChange={(event) => {
              const nextProvider = verifiedProviders.find(
                ({ id }) => id === event.target.value,
              );
              setProviderId(event.target.value);
              setModel(nextProvider?.defaultModel ?? "");
            }}
            value={providerId}
          >
            <option value="">请选择已验证服务</option>
            {verifiedProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
          {fieldErrors.providerId ? (
            <p className="error-text" id="agent-provider-error">
              {fieldErrors.providerId}
            </p>
          ) : null}
          {verifiedProviders.length === 0 ? (
            <p className="muted">请先创建并验证模型服务。</p>
          ) : null}
        </div>
        <div className="form-field">
          <label htmlFor="agent-model">模型</label>
          <input
            aria-describedby={fieldErrors.model ? "agent-model-error" : undefined}
            aria-invalid={fieldErrors.model ? true : undefined}
            id="agent-model"
            placeholder="由所选服务自动填写"
            readOnly
            value={selectedProvider?.defaultModel ?? model}
          />
          {fieldErrors.model ? (
            <p className="error-text" id="agent-model-error">{fieldErrors.model}</p>
          ) : null}
        </div>
        <fieldset
          aria-describedby={fieldErrors.skillIds ? "agent-skills-error" : undefined}
          aria-invalid={fieldErrors.skillIds ? true : undefined}
          className="stack"
          id="agent-skills"
          tabIndex={-1}
        >
          <legend>技能</legend>
          {skills.length === 0 ? (
            <p className="muted">暂无技能，请先创建技能。</p>
          ) : (
            skills.map((skill) => (
              <label className="check-row" key={skill.id}>
                <input
                  checked={skillIds.includes(skill.id)}
                  onChange={(event) => toggleSkill(skill.id, event.target.checked)}
                  type="checkbox"
                />
                {skill.name}
              </label>
            ))
          )}
          {fieldErrors.skillIds ? (
            <p className="error-text" id="agent-skills-error">{fieldErrors.skillIds}</p>
          ) : null}
        </fieldset>
        <fieldset className="stack">
          <legend>复核能力</legend>
          <label className="check-row">
            <input
              aria-describedby="agent-review-capable-help"
              checked={reviewCapable}
              id="agent-review-capable"
              onChange={(event) => setReviewCapable(event.target.checked)}
              type="checkbox"
            />
            可独立复核结果
          </label>
          <p className="muted" id="agent-review-capable-help">
            仅明确开启后，且 Agent 当前属于项目并非结果执行者时，才可成为复核候选。
          </p>
        </fieldset>
        <fieldset
          aria-describedby={
            fieldErrors["permissions.readFiles"] ||
            fieldErrors["permissions.writeFiles"] ||
            fieldErrors["permissions.runCommands"]
              ? "agent-permissions-error"
              : undefined
          }
          aria-invalid={
            fieldErrors["permissions.readFiles"] ||
            fieldErrors["permissions.writeFiles"] ||
            fieldErrors["permissions.runCommands"]
              ? true
              : undefined
          }
          className="stack"
          id="agent-permissions"
          tabIndex={-1}
        >
          <legend>工具权限</legend>
          {[
            ["readFiles", "读取文件"],
            ["writeFiles", "写入文件"],
            ["runCommands", "运行命令"],
          ].map(([key, label]) => (
            <div className="stack" key={key}>
              <label className="check-row">
                <input
                  aria-describedby={
                    fieldErrors[`permissions.${key}` as AgentField]
                      ? `agent-permission-${key}-error`
                      : undefined
                  }
                  aria-invalid={
                    fieldErrors[`permissions.${key}` as AgentField] ? true : undefined
                  }
                  checked={permissions[key as keyof ToolPermissions]}
                  id={`agent-permission-${key}`}
                  onChange={(event) =>
                    setPermissions((current) => ({
                      ...current,
                      [key]: event.target.checked,
                    }))
                  }
                  type="checkbox"
                />
                {label}
              </label>
              {fieldErrors[`permissions.${key}` as AgentField] ? (
                <p className="error-text" id={`agent-permission-${key}-error`}>
                  {fieldErrors[`permissions.${key}` as AgentField]}
                </p>
              ) : null}
            </div>
          ))}
          {fieldErrors["permissions.readFiles"] ||
          fieldErrors["permissions.writeFiles"] ||
          fieldErrors["permissions.runCommands"] ? (
            <p className="error-text" id="agent-permissions-error">
              工具权限设置无效。
            </p>
          ) : null}
        </fieldset>
        <div className="form-field">
          <label htmlFor="agent-max-tokens">Token 预算</label>
          <input
            aria-describedby={
              fieldErrors.maxTokens
                ? "agent-max-tokens-error"
                : "agent-max-tokens-help"
            }
            aria-invalid={fieldErrors.maxTokens ? true : undefined}
            id="agent-max-tokens"
            max={1_000_000}
            min={1}
            onChange={(event) => setMaxTokens(event.target.value)}
            step={1}
            type="number"
            value={maxTokens}
          />
          <p className="muted" id="agent-max-tokens-help">
            每次运行 1–1000000 tokens。
          </p>
          {fieldErrors.maxTokens ? (
            <p className="error-text" id="agent-max-tokens-error">
              {fieldErrors.maxTokens}
            </p>
          ) : null}
        </div>
        <div className="form-field">
          <label htmlFor="agent-max-handoffs">接力轮次</label>
          <input
            aria-describedby={
              fieldErrors.maxHandoffs ? "agent-max-handoffs-error" : undefined
            }
            aria-invalid={fieldErrors.maxHandoffs ? true : undefined}
            id="agent-max-handoffs"
            max={100}
            min={1}
            onChange={(event) => setMaxHandoffs(event.target.value)}
            step={1}
            type="number"
            value={maxHandoffs}
          />
          {fieldErrors.maxHandoffs ? (
            <p className="error-text" id="agent-max-handoffs-error">
              {fieldErrors.maxHandoffs}
            </p>
          ) : null}
        </div>
        <div className="form-field">
          <label htmlFor="agent-avatar">头像文字</label>
          <input
            aria-describedby={fieldErrors.avatarText ? "agent-avatar-error" : undefined}
            aria-invalid={fieldErrors.avatarText ? true : undefined}
            id="agent-avatar"
            onChange={(event) => setAvatarText(event.target.value)}
            placeholder="例如：审"
            required
            value={avatarText}
          />
          {fieldErrors.avatarText ? (
            <p className="error-text" id="agent-avatar-error">{fieldErrors.avatarText}</p>
          ) : null}
        </div>
        <div className="form-field">
          <label htmlFor="agent-accent">强调色</label>
          <select
            aria-describedby={fieldErrors.accentToken ? "agent-accent-error" : undefined}
            aria-invalid={fieldErrors.accentToken ? true : undefined}
            id="agent-accent"
            onChange={(event) => setAccentToken(event.target.value as AccentToken)}
            value={accentToken}
          >
            {accents.map((accent) => (
              <option key={accent.value} value={accent.value}>
                {accent.label}
              </option>
            ))}
          </select>
          {fieldErrors.accentToken ? (
            <p className="error-text" id="agent-accent-error">{fieldErrors.accentToken}</p>
          ) : null}
        </div>
        <button disabled={!fieldsReady || isSaving} type="submit">
          {isSaving ? "正在保存 Agent…" : "保存 Agent"}
        </button>
        {formError ? (
          <div className="error-text" ref={errorRef} role="alert" tabIndex={-1}>
            {formError}
          </div>
        ) : null}
      </form>
    </aside>
  );

  return (
    <>
      <main
        aria-labelledby="agent-resource-tab"
        className="cockpit-flow"
        id="agent-resource-panel"
        role="tabpanel"
      >
        <header className="panel-heading">
          <div className="stack">
            <p className="eyebrow">团队资源</p>
            <h2>Agent</h2>
          </div>
          <button onClick={startCreate} ref={createButtonRef} type="button">
            创建 Agent
          </button>
        </header>
        {guide === "agent" ? (
          <AgentOnboardingGuide
            facts={guideFacts}
            loading={isLoading}
            loadError={guideRequestError}
            onContinue={onGuideContinue}
            onFocusAgent={() => {
              const focusId =
                guideFacts?.kind === "success"
                  ? guideFacts.reviewerAgentId
                  : guideFacts?.kind === "project_pending"
                    ? guideFacts.focusAgentId
                    : null;
              if (focusId) headingRefs.current.get(focusId)?.focus();
              else createButtonRef.current?.focus();
            }}
            onRetry={() => setReloadKey((current) => current + 1)}
            onSkip={onGuideSkip}
          />
        ) : null}
        {isLoading ? (
          <p aria-busy="true" className="muted">
            正在加载 Agent…
          </p>
        ) : loadError ? (
          <div className="stack error-text" ref={errorRef} role="alert" tabIndex={-1}>
            <p>{loadError}</p>
            <button
              onClick={() => setReloadKey((current) => current + 1)}
              type="button"
            >
              重试加载 Agent
            </button>
          </div>
        ) : agents.length === 0 ? (
          <div className="stack">
            <p className="muted">暂无 Agent。</p>
            {verifiedProviders.length === 0 ? (
              <p className="muted">请先创建并验证模型服务。</p>
            ) : null}
            <button
              onClick={() => setReloadKey((current) => current + 1)}
              type="button"
            >
              重试加载 Agent
            </button>
          </div>
        ) : (
          <ul className="timeline">
            {agents.map((agent) => (
              <li className="timeline-item" key={agent.id}>
                <article className="stack" data-accent={agent.accentToken}>
                  <div className="agent-identity">
                    <span aria-hidden="true" className="agent-avatar">
                      {agent.avatarText}
                    </span>
                    <h3
                      ref={(node) => {
                        if (node) headingRefs.current.set(agent.id, node);
                      }}
                      tabIndex={-1}
                    >
                      {agent.name}
                    </h3>
                  </div>
                  <p>{agent.role}</p>
                  <p className="muted">{agent.model}</p>
                  <p>
                    {agent.skillIds
                      .map((id) => skills.find((skill) => skill.id === id)?.name)
                      .filter(Boolean)
                      .join(" · ") || "无技能"}
                  </p>
                  <p className="muted">{permissionText(agent.permissions)}</p>
                  <p className="muted">
                    {agent.reviewCapable ? "可独立复核" : "未开启独立复核"}
                  </p>
                  <button
                    aria-label={`编辑 ${agent.name}`}
                    onClick={(event) => startEdit(agent, event.currentTarget)}
                    type="button"
                  >
                    编辑
                  </button>
                </article>
              </li>
            ))}
          </ul>
        )}
        {status ? (
          <p aria-live="polite" role="status">
            {status}
          </p>
        ) : null}
      </main>
      {(!mobile || editorOpen) && editor}
    </>
  );
}

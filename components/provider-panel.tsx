"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

import {
  trapModalFocus,
  useModalSurface,
  useNarrowMode,
} from "@/components/mobile-dialog";
import type { Provider, ProviderDraft } from "@/src/shared/team-contracts";

type ProviderField =
  | "name"
  | "baseUrl"
  | "defaultModel"
  | "apiKey"
  | "allowInsecureHttp";

type ApiFailure = {
  error?: {
    code?: string;
    fields?: Array<{ field: string; code: string }>;
  };
};

const errorCopy: Record<string, string> = {
  INSECURE_HTTP_CONFIRMATION_REQUIRED: "请先确认 HTTP 明文传输凭据的风险。",
  INTERNAL_ERROR: "服务暂时出现问题，请稍后重试。",
  INVALID_INPUT: "提交内容有误，请检查各字段。",
  MASTER_KEY_UNAVAILABLE: "凭据主密钥不可用，请先完成本机配置。",
  PROVIDER_CONFLICT: "服务已被其他操作更新，请重新加载后再试。",
  PROVIDER_INCOMPATIBLE: "服务响应不兼容或未提供所选模型。",
  PROVIDER_KEY_CORRUPT: "已保存的凭据已损坏，请输入新 API key 替换。",
  PROVIDER_KEY_UNAVAILABLE: "无法使用已保存的凭据，请输入新 API key 替换。",
  PROVIDER_RATE_LIMITED: "服务请求过于频繁，请稍后再试。",
  PROVIDER_REDIRECTED: "服务发生重定向，已为保护凭据而停止验证。",
  PROVIDER_REJECTED: "服务拒绝了验证请求。",
  PROVIDER_RESPONSE_TOO_LARGE: "服务返回的数据过大，无法验证。",
  PROVIDER_TIMEOUT: "服务验证超时，请检查地址后重试。",
  PROVIDER_UNAUTHORIZED: "API key 无效或没有访问权限。",
  PROVIDER_UNREACHABLE: "无法连接模型服务，请检查地址与网络。",
  PROVIDER_UPSTREAM_ERROR: "模型服务暂时不可用，请稍后重试。",
  VALIDATION_EXPIRED: "验证结果已过期，请重新验证。",
  VALIDATION_MISMATCH: "连接信息与验证结果不一致，请重新验证。",
  VALIDATION_REQUIRED: "请先验证当前连接信息。",
};

const providerFieldLabels: Record<ProviderField, string> = {
  allowInsecureHttp: "HTTP 风险确认",
  apiKey: "API key",
  baseUrl: "Base URL",
  defaultModel: "默认模型",
  name: "服务名称",
};

function providerFieldCopy(field: ProviderField, code: string): string {
  if (code === "too_long") return `${providerFieldLabels[field]}超过长度限制。`;
  if (code === "invalid_format") return `${providerFieldLabels[field]} 格式无效。`;
  if (code === "confirmation_required") return "请确认 HTTP 明文传输风险。";
  return `${providerFieldLabels[field]}为必填项。`;
}

function isProviderField(field: string): field is ProviderField {
  return field in providerFieldLabels;
}

const PROVIDER_EDITOR_INERT = [".cockpit-sidebar", "#provider-resource-panel"];

function responseCopy(payload: ApiFailure): string {
  const code = payload.error?.code;
  return (code && errorCopy[code]) || "请求失败，请稍后重试。";
}

export function ProviderPanel() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false);
  const [validationToken, setValidationToken] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [keyVisible, setKeyVisible] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [focusProviderId, setFocusProviderId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<ProviderField, { code: string; message: string }>>
  >({});
  const narrow = useNarrowMode();
  const errorRef = useRef<HTMLParagraphElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const defaultModelRef = useRef<HTMLInputElement>(null);
  const apiKeyRef = useRef<HTMLInputElement>(null);
  const insecureRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const providerHeadingRefs = useRef(new Map<string, HTMLHeadingElement>());

  useModalSurface(narrow && editorOpen, dialogRef, PROVIDER_EDITOR_INERT);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setLoadError(null);
    void fetch("/api/providers")
      .then(async (response) => {
        if (!response.ok) throw new Error("provider load failed");
        return response.json() as Promise<{ providers: Provider[] }>;
      })
      .then(({ providers: loaded }) => {
        if (active) setProviders(loaded);
      })
      .catch(() => {
        if (active) setLoadError("暂时无法加载模型服务，请稍后重试。");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (loadError || (formError && Object.keys(fieldErrors).length === 0)) {
      errorRef.current?.focus();
    }
  }, [fieldErrors, formError, loadError]);

  useEffect(() => {
    if (focusProviderId) {
      providerHeadingRefs.current.get(focusProviderId)?.focus();
      setFocusProviderId(null);
    }
  }, [focusProviderId, providers]);

  const isHttp = baseUrl.trim().toLowerCase().startsWith("http://");
  const connectionChanged =
    editing !== null &&
    (baseUrl.trim() !== editing.baseUrl || defaultModel.trim() !== editing.defaultModel);
  const replacement = editing !== null && apiKey.length > 0;
  const requiresVerification = editing === null || connectionChanged || replacement;
  const fieldsReady =
    name.trim() !== "" &&
    baseUrl.trim() !== "" &&
    defaultModel.trim() !== "" &&
    (editing !== null || apiKey.trim() !== "") &&
    (!isHttp || allowInsecureHttp);
  const canSave =
    fieldsReady &&
    !isVerifying &&
    !isSaving &&
    (!requiresVerification || validationToken !== null);

  function invalidateVerification() {
    if (validationToken) setStatusMessage("连接信息已变更，请重新验证。");
    setValidationToken(null);
    clearErrors();
  }

  function clearErrors() {
    setFormError(null);
    setFieldErrors({});
  }

  function startCreate(event?: { currentTarget: EventTarget | null }) {
    openerRef.current =
      event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    setEditing(null);
    setName("");
    setBaseUrl("");
    setDefaultModel("");
    setApiKey("");
    setAllowInsecureHttp(false);
    setValidationToken(null);
    setStatusMessage("");
    clearErrors();
    setKeyVisible(false);
    setEditorOpen(true);
    if (!narrow) queueMicrotask(() => nameRef.current?.focus());
  }

  function startEdit(provider: Provider, opener: HTMLElement) {
    openerRef.current = opener;
    setEditing(provider);
    setName(provider.name);
    setBaseUrl(provider.baseUrl);
    setDefaultModel(provider.defaultModel);
    setApiKey("");
    setAllowInsecureHttp(provider.baseUrl.startsWith("http://"));
    setValidationToken(null);
    setStatusMessage("");
    clearErrors();
    setKeyVisible(false);
    setEditorOpen(true);
    if (!narrow) queueMicrotask(() => nameRef.current?.focus());
  }

  function closeEditor() {
    setEditorOpen(false);
    queueMicrotask(() => openerRef.current?.focus());
  }

  function applyFailure(payload: ApiFailure): string {
    const nextErrors: Partial<
      Record<ProviderField, { code: string; message: string }>
    > = {};
    for (const issue of payload.error?.fields ?? []) {
      if (!isProviderField(issue.field)) continue;
      nextErrors[issue.field] = {
        code: issue.code,
        message: providerFieldCopy(issue.field, issue.code),
      };
    }
    setFieldErrors(nextErrors);
    const firstField = ([
      "name",
      "baseUrl",
      "defaultModel",
      "apiKey",
      "allowInsecureHttp",
    ] as ProviderField[]).find((field) => nextErrors[field]);
    if (firstField) {
      const refs = {
        allowInsecureHttp: insecureRef,
        apiKey: apiKeyRef,
        baseUrl: baseUrlRef,
        defaultModel: defaultModelRef,
        name: nameRef,
      };
      queueMicrotask(() => refs[firstField].current?.focus());
    }
    return responseCopy(payload);
  }

  function draft(): ProviderDraft {
    const connection = {
      allowInsecureHttp,
      baseUrl: baseUrl.trim(),
      defaultModel: defaultModel.trim(),
      name: name.trim(),
    };
    if (!editing) {
      return { ...connection, apiKey, mode: "create" };
    }
    if (apiKey) {
      return {
        ...connection,
        apiKey,
        expectedVersion: editing.version,
        mode: "replace",
        providerId: editing.id,
      };
    }
    return {
      ...connection,
      expectedVersion: editing.version,
      mode: "retain",
      providerId: editing.id,
    };
  }

  async function verify() {
    clearErrors();
    setStatusMessage("");
    setIsVerifying(true);
    try {
      const response = await fetch("/api/providers/verify", {
        body: JSON.stringify(draft()),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const result = (await response.json()) as ApiFailure & {
        validationToken: string;
        verifiedModel: string;
      };
      if (!response.ok) throw new Error(applyFailure(result));
      setValidationToken(result.validationToken);
      setStatusMessage(`已验证模型 ${result.verifiedModel}`);
    } catch (cause) {
      setValidationToken(null);
      setFormError(
        cause instanceof Error ? cause.message : "无法验证模型服务，请稍后重试。",
      );
    } finally {
      setIsVerifying(false);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) return;
    clearErrors();
    setIsSaving(true);
    try {
      const currentDraft = draft();
      const response = await fetch(
        editing ? `/api/providers/${editing.id}` : "/api/providers",
        {
          body: JSON.stringify({
            draft: currentDraft,
            ...(validationToken ? { validationToken } : {}),
          }),
          headers: { "content-type": "application/json" },
          method: editing ? "PATCH" : "POST",
        },
      );
      const payload = (await response.json()) as ApiFailure & { provider?: Provider };
      if (!response.ok || !payload.provider) throw new Error(applyFailure(payload));
      const provider = payload.provider;
      setProviders((current) => {
        const exists = current.some(({ id }) => id === provider.id);
        return exists
          ? current.map((item) => (item.id === provider.id ? provider : item))
          : [...current, provider];
      });
      setEditing(provider);
      setName(provider.name);
      setBaseUrl(provider.baseUrl);
      setDefaultModel(provider.defaultModel);
      setApiKey("");
      setAllowInsecureHttp(provider.baseUrl.startsWith("http://"));
      setValidationToken(null);
      setKeyVisible(false);
      setStatusMessage("模型服务已保存。");
      setFocusProviderId(provider.id);
      if (narrow) setEditorOpen(false);
    } catch (cause) {
      setFormError(
        cause instanceof Error ? cause.message : "无法保存模型服务，请稍后重试。",
      );
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <>
      <main
        aria-labelledby="provider-resource-tab"
        className="cockpit-flow"
        id="provider-resource-panel"
        role="tabpanel"
      >
        <header className="panel-heading">
          <div className="stack">
            <p className="eyebrow">团队资源</p>
            <h2 id="providers-title">模型服务</h2>
          </div>
          <button onClick={startCreate} type="button">
            创建模型服务
          </button>
        </header>
        {isLoading ? (
          <p aria-busy="true" className="muted">
            正在加载服务…
          </p>
        ) : loadError && providers.length === 0 ? (
          <div className="stack">
            <p className="error-text" ref={errorRef} role="alert" tabIndex={-1}>
              {loadError}
            </p>
            <button onClick={() => setReloadKey((current) => current + 1)} type="button">
              重试加载服务
            </button>
          </div>
        ) : providers.length === 0 ? (
          <p className="muted">暂无模型服务。</p>
        ) : (
          <ul className="timeline">
            {providers.map((provider) => (
              <li className="timeline-item" key={provider.id}>
                <article className="stack">
                  <h3
                    ref={(node) => {
                      if (node) providerHeadingRefs.current.set(provider.id, node);
                    }}
                    tabIndex={-1}
                  >
                    {provider.name}
                  </h3>
                  <p className="muted">{provider.defaultModel}</p>
                  <p>{provider.apiKeyMask}</p>
                  <button
                    aria-label={`编辑 ${provider.name}`}
                    onClick={(event) => startEdit(provider, event.currentTarget)}
                    type="button"
                  >
                    编辑
                  </button>
                </article>
              </li>
            ))}
          </ul>
        )}
      </main>

      {(!narrow || editorOpen) ? (
      <aside
        aria-labelledby="provider-editor-title"
        aria-modal={narrow ? true : undefined}
        className="cockpit-context"
        data-open={narrow && editorOpen ? "true" : undefined}
        onKeyDown={narrow ? (event) => trapModalFocus(event, closeEditor) : undefined}
        ref={dialogRef}
        role={narrow ? "dialog" : undefined}
      >
        <button
          aria-label="关闭模型服务编辑器"
          className="drawer-close"
          data-dialog-close="true"
          onClick={closeEditor}
          type="button"
        >
          关闭
        </button>
        <div className="stack">
          <p className="eyebrow">OpenAI-compatible</p>
          <h2 id="provider-editor-title">{editing ? "编辑模型服务" : "创建模型服务"}</h2>
        </div>
        <form className="stack" onSubmit={save}>
          <div className="form-field">
            <label htmlFor="provider-name">服务名称</label>
            <input
              aria-describedby={fieldErrors.name ? "provider-name-error" : undefined}
              aria-invalid={fieldErrors.name ? true : undefined}
              id="provider-name"
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：团队 OpenAI 网关"
              ref={nameRef}
              required
              value={name}
            />
            {fieldErrors.name ? (
              <p className="error-text" id="provider-name-error">
                {fieldErrors.name.message}
              </p>
            ) : null}
          </div>
          <div className="form-field">
            <label htmlFor="provider-base-url">Base URL</label>
            <input
              aria-describedby={fieldErrors.baseUrl ? "provider-base-url-error" : undefined}
              aria-invalid={fieldErrors.baseUrl ? true : undefined}
              id="provider-base-url"
              maxLength={2_048}
              onChange={(event) => {
                setBaseUrl(event.target.value);
                invalidateVerification();
              }}
              placeholder="例如：https://api.example.com/v1"
              required
              ref={baseUrlRef}
              value={baseUrl}
            />
            {fieldErrors.baseUrl ? (
              <p className="error-text" id="provider-base-url-error">
                {fieldErrors.baseUrl.message}
              </p>
            ) : null}
          </div>
          <div className="form-field">
            <label htmlFor="provider-model">默认模型</label>
            <input
              aria-describedby={fieldErrors.defaultModel ? "provider-model-error" : undefined}
              aria-invalid={fieldErrors.defaultModel ? true : undefined}
              id="provider-model"
              maxLength={120}
              onChange={(event) => {
                setDefaultModel(event.target.value);
                invalidateVerification();
              }}
              placeholder="例如：gpt-5"
              required
              ref={defaultModelRef}
              value={defaultModel}
            />
            {fieldErrors.defaultModel ? (
              <p className="error-text" id="provider-model-error">
                {fieldErrors.defaultModel.message}
              </p>
            ) : null}
          </div>
          <div className="form-field">
            <label htmlFor="provider-api-key">API key</label>
            {editing ? <p className="muted">已保存 {editing.apiKeyMask}</p> : null}
            <div className="form-row">
              <input
                aria-describedby={fieldErrors.apiKey ? "provider-api-key-error" : undefined}
                aria-invalid={fieldErrors.apiKey ? true : undefined}
                autoComplete="off"
                id="provider-api-key"
                maxLength={8_192}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  invalidateVerification();
                }}
                placeholder="粘贴服务端生成的访问密钥"
                ref={apiKeyRef}
                type={keyVisible ? "text" : "password"}
                value={apiKey}
              />
              <button
                aria-pressed={keyVisible}
                onClick={() => setKeyVisible((current) => !current)}
                type="button"
              >
                {keyVisible ? "隐藏 API key" : "显示 API key"}
              </button>
            </div>
            {fieldErrors.apiKey ? (
              <p className="error-text" id="provider-api-key-error">
                {fieldErrors.apiKey.message}
              </p>
            ) : null}
          </div>
          {isHttp ? (
            <label className="check-row">
              <input
                aria-describedby={
                  fieldErrors.allowInsecureHttp ? "provider-http-error" : undefined
                }
                aria-invalid={fieldErrors.allowInsecureHttp ? true : undefined}
                checked={allowInsecureHttp}
                onChange={(event) => {
                  setAllowInsecureHttp(event.target.checked);
                  invalidateVerification();
                }}
                ref={insecureRef}
                type="checkbox"
              />
              我了解 HTTP 会明文传输凭据的风险
              {fieldErrors.allowInsecureHttp ? (
                <span className="error-text" id="provider-http-error">
                  {fieldErrors.allowInsecureHttp.message}
                </span>
              ) : null}
            </label>
          ) : null}
          <div className="form-row">
            <button
              disabled={!fieldsReady || isVerifying || isSaving}
              onClick={verify}
              type="button"
            >
              {isVerifying ? "正在验证…" : "验证连接"}
            </button>
            <button disabled={!canSave} type="submit">
              {isSaving ? "正在保存…" : "保存服务"}
            </button>
          </div>
          {statusMessage ? (
            <p aria-live="polite" className="context-status" role="status">
              {statusMessage}
            </p>
          ) : null}
          {formError ? (
            <p className="error-text" ref={errorRef} role="alert" tabIndex={-1}>
              {formError}
            </p>
          ) : null}
        </form>
      </aside>
      ) : null}
    </>
  );
}

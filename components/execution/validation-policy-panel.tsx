"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  ApiDisplayError,
  apiErrorCopy,
  caughtApiErrorCopy,
} from "@/src/shared/api-error-copy";
import type { ApiError } from "@/src/shared/contracts";

type PolicyEntry = {
  args: string[];
  executable: string;
  required: boolean;
  workdir: string;
};

type ValidationPolicy = {
  classifierVersion: number;
  entries: PolicyEntry[];
  policyHash: string;
  projectId: string;
  revisionId: string;
  revisionNo: number;
  version: number;
  warningAccepted: boolean;
};

type DraftEntry = PolicyEntry & { key: string };
type Preview = {
  code: string | null;
  parseResult: "known" | "unknown_non_path" | "unknown_path_syntax";
};

const CONTROL_STYLE = { minHeight: "var(--control-min)" };
const SHELLS = new Set(["bash", "cmd", "cscript", "fish", "powershell", "pwsh", "sh", "wscript", "zsh"]);
const KNOWN = new Set(["git", "node", "npm", "npx", "pnpm", "python", "python3", "tsc", "vitest", "yarn"]);
const CONTROL_TOKENS = new Set(["|", "||", "&&", ">", ">>", "<", ";"]);
const HOSTILE_WARNING =
  "此 guardrail 不是 hostile OS sandbox。持续批准的本地程序仍可能产生平台无法隔离的本机、网络、进程或服务副作用，并可在未来 attempt 重复执行。";

function operationId(): string {
  return globalThis.crypto.randomUUID();
}

function draftEntry(entry?: PolicyEntry): DraftEntry {
  return {
    args: entry ? [...entry.args] : [],
    executable: entry?.executable ?? "",
    key: operationId(),
    required: entry?.required ?? false,
    workdir: entry?.workdir ?? ".",
  };
}

function executableBase(executable: string): string {
  const normalized = executable.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.exe$/i, "").toLowerCase();
}

function classify(entry: PolicyEntry): Preview {
  const base = executableBase(entry.executable);
  if (SHELLS.has(base)) return { code: "SHELL_EXECUTABLE_DENIED", parseResult: "known" };
  if (/\.(?:bat|cmd|ps1|sh)$/i.test(entry.executable)) {
    return { code: "SHELL_SCRIPT_DENIED", parseResult: "known" };
  }
  if (entry.args.some((argument) => CONTROL_TOKENS.has(argument))) {
    return { code: "SHELL_CONTROL_DENIED", parseResult: "known" };
  }
  if (entry.args.some((argument) => /\$\(|`[^`]*`/.test(argument))) {
    return { code: "COMMAND_SUBSTITUTION_DENIED", parseResult: "known" };
  }
  if (entry.args.some((argument) => /\$\{[^}]+\}|%[A-Za-z_][A-Za-z0-9_]*%/.test(argument))) {
    return { code: "ENV_EXPANSION_DENIED", parseResult: "known" };
  }
  const lowerArgs = entry.args.map((argument) => argument.toLowerCase());
  if (
    (base === "git" && ["push", "remote", "credential"].includes(lowerArgs[0] ?? ""))
    || (["npm", "pnpm", "yarn"].includes(base)
      && lowerArgs.some((argument) => ["deploy", "publish", "release"].includes(argument)))
  ) {
    return { code: "DEPLOY_PUBLISH_PUSH_DENIED", parseResult: "known" };
  }
  if (["scp", "sftp", "ssh"].includes(base)) {
    return { code: "REMOTE_TRANSFER_DENIED", parseResult: "known" };
  }
  if (
    !entry.workdir
    || entry.workdir.startsWith("/")
    || entry.workdir.startsWith("\\")
    || /^[A-Za-z]:/.test(entry.workdir)
    || entry.workdir.split(/[\\/]/).includes("..")
  ) {
    return { code: "PATH_ESCAPE_DENIED", parseResult: "unknown_path_syntax" };
  }
  return {
    code: null,
    parseResult: KNOWN.has(base) ? "known" : "unknown_non_path",
  };
}

export function ValidationPolicyPanel({ projectId }: { projectId: string }) {
  const [policy, setPolicy] = useState<ValidationPolicy | null>(null);
  const [history, setHistory] = useState<ValidationPolicy[]>([]);
  const [draft, setDraft] = useState<DraftEntry[]>([]);
  const [warningAccepted, setWarningAccepted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    void Promise.all([
      fetch(`/api/projects/${projectId}/validation-policy`),
      fetch(`/api/projects/${projectId}/validation-policy/revisions?limit=20`),
    ]).then(async ([activeResponse, historyResponse]) => {
      const activePayload = await activeResponse.json() as { policy?: ValidationPolicy } & Partial<ApiError>;
      const historyPayload = await historyResponse.json() as {
        items?: ValidationPolicy[];
      } & Partial<ApiError>;
      if (!activeResponse.ok || !activePayload.policy) {
        throw new ApiDisplayError(apiErrorCopy(activePayload, "无法加载验证政策。"));
      }
      if (!historyResponse.ok || !historyPayload.items) {
        throw new ApiDisplayError(apiErrorCopy(historyPayload, "无法加载验证政策历史。"));
      }
      if (!active) return;
      setPolicy(activePayload.policy);
      setHistory(historyPayload.items);
      setDraft(activePayload.policy.entries.map(draftEntry));
      setWarningAccepted(false);
    }).catch((cause: unknown) => {
      if (active) setLoadError(caughtApiErrorCopy(cause, "无法加载验证政策。"));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [projectId, reloadKey]);

  const previews = useMemo(
    () => draft.map((entry) => entry.executable ? classify(entry) : null),
    [draft],
  );
  const denialCode = previews.find((preview) => preview?.code)?.code ?? null;
  const hasIncompleteEntry = draft.some(({ executable, workdir }) => !executable.trim() || !workdir.trim());
  const canonicalBytes = new TextEncoder().encode(JSON.stringify(
    draft.map(({ key: _key, ...entry }) => entry),
  )).byteLength;
  const limitError = draft.length > 50
    ? "验证政策最多包含 50 项。"
    : canonicalBytes > 65_536
      ? "验证政策草稿超过 64 KiB。"
      : null;

  function updateEntry(index: number, patch: Partial<PolicyEntry>) {
    setDraft((current) => current.map((entry, position) =>
      position === index ? { ...entry, ...patch } : entry));
    setSaveError(null);
    setSuccess(null);
  }

  async function save() {
    if (!policy || saving || denialCode || limitError || hasIncompleteEntry || !warningAccepted) return;
    setSaving(true);
    setSaveError(null);
    setSuccess(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/validation-policy`, {
        body: JSON.stringify({
          entries: draft.map(({ key: _key, ...entry }) => entry),
          expectedVersion: policy.version,
          operationId: operationId(),
          warningAccepted,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = await response.json() as {
        outcome?: "rejected" | "saved";
        policy?: ValidationPolicy;
        reasonCode?: string | null;
      } & Partial<ApiError>;
      if (!response.ok) {
        const currentVersion = payload.error?.currentVersion;
        throw new ApiDisplayError(
          currentVersion
            ? `验证政策版本已变为 ${currentVersion}，草稿已保留，请刷新核对后重试。`
            : apiErrorCopy(payload, "无法保存验证政策，草稿已保留。"),
        );
      }
      if (payload.outcome !== "saved" || !payload.policy) {
        throw new ApiDisplayError(
          payload.reasonCode
            ? `机械分类拒绝保存：${payload.reasonCode}`
            : "无法保存验证政策，草稿已保留。",
        );
      }
      setPolicy(payload.policy);
      setHistory((current) => [...current, payload.policy!]);
      setDraft(payload.policy.entries.map(draftEntry));
      setWarningAccepted(false);
      setSuccess(`验证政策已保存为修订 #${payload.policy.revisionNo}。`);
      queueMicrotask(() => headingRef.current?.focus());
    } catch (cause: unknown) {
      setSaveError(caughtApiErrorCopy(cause, "无法保存验证政策，草稿已保留。"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby={`validation-policy-${projectId}`} className="stack">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">持续批准（standing approval）</p>
          <h4 id={`validation-policy-${projectId}`} ref={headingRef} tabIndex={-1}>
            验证政策
          </h4>
        </div>
        <button
          disabled={loading}
          onClick={() => setReloadKey((value) => value + 1)}
          style={CONTROL_STYLE}
          type="button"
        >
          刷新政策
        </button>
      </div>
      {loading ? (
        <p aria-busy="true">正在加载验证政策…</p>
      ) : loadError ? (
        <div>
          <p role="alert">{loadError}</p>
          <button onClick={() => setReloadKey((value) => value + 1)} style={CONTROL_STYLE} type="button">
            重试加载政策
          </button>
        </div>
      ) : policy ? (
        <>
          <p>
            <span>{`活动修订 #${policy.revisionNo}`}</span>
            {` · classifier v${policy.classifierVersion} · hash ${policy.policyHash.slice(0, 8)}`}
          </p>
          <div aria-label="不可变验证政策历史">
            {history.length === 0 ? (
              <p>暂无历史修订。</p>
            ) : (
              <ol>
                {history.map((revision) => (
                  <li key={revision.revisionId}>
                    <span>{`不可变修订 #${revision.revisionNo}`}</span>
                    {` · ${revision.entries.length} 项 · hash ${revision.policyHash.slice(0, 8)}`}
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div className="stack">
            {draft.length === 0 ? <p>当前政策为空；自动合入需要单次批准。</p> : null}
            {draft.map((entry, index) => {
              const preview = previews[index];
              return (
                <fieldset className="stack" key={entry.key}>
                  <legend>持续批准 #{index + 1}</legend>
                  <label>
                    可执行文件
                    <input
                      onChange={(event) => updateEntry(index, { executable: event.target.value })}
                      placeholder="例如：npm"
                      value={entry.executable}
                    />
                  </label>
                  <label>
                    参数（每行一项）
                    <textarea
                      onChange={(event) => updateEntry(index, {
                        args: event.target.value.split("\n").filter((argument) => argument.length > 0),
                      })}
                      value={entry.args.join("\n")}
                    />
                  </label>
                  <label>
                    工作目录
                    <input
                      onChange={(event) => updateEntry(index, { workdir: event.target.value })}
                      placeholder="例如：项目根目录"
                      value={entry.workdir}
                    />
                  </label>
                  <label>
                    <input
                      checked={entry.required}
                      onChange={(event) => updateEntry(index, { required: event.target.checked })}
                      type="checkbox"
                    />
                    必需验证
                  </label>
                  <p>
                    classifier outcome：
                    <span>{preview?.code ?? preview?.parseResult ?? "等待完整 tuple"}</span>
                    {preview?.parseResult === "unknown_non_path"
                      ? "（允许在接受警示后保存）"
                      : ""}
                  </p>
                  <button
                    onClick={() => setDraft((current) => current.filter((_, position) => position !== index))}
                    style={CONTROL_STYLE}
                    type="button"
                  >
                    删除持续批准 #{index + 1}
                  </button>
                </fieldset>
              );
            })}
            <button
              disabled={draft.length >= 50}
              onClick={() => setDraft((current) => [...current, draftEntry()])}
              style={CONTROL_STYLE}
              type="button"
            >
              添加持续批准
            </button>
          </div>
          <p>
            保存将创建新的不可变修订；exact tuple 包含 executable、ordered args、workdir 和 required。
            当前草稿 {draft.length}/50 项，{canonicalBytes}/65536 bytes。
          </p>
          <label>
            <input
              checked={warningAccepted}
              onChange={(event) => setWarningAccepted(event.target.checked)}
              type="checkbox"
            />
            {HOSTILE_WARNING}
          </label>
          {denialCode ? <p role="alert">机械分类拒绝：{denialCode}</p> : null}
          {limitError ? <p role="alert">{limitError}</p> : null}
          {saveError ? <p role="alert">{saveError}</p> : null}
          {success ? <p aria-live="polite">{success}</p> : null}
          <button
            disabled={
              saving || !warningAccepted || Boolean(denialCode || limitError || hasIncompleteEntry)
            }
            onClick={() => void save()}
            style={CONTROL_STYLE}
            type="button"
          >
            {saving ? "正在保存验证政策…" : "保存验证政策"}
          </button>
        </>
      ) : null}
    </section>
  );
}

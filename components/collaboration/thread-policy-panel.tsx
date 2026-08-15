"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { useTargetRequestGuard } from "@/components/collaboration/use-target-request-guard";
import { useModalSurface } from "@/components/mobile-dialog";
import type {
  CollaborationApiError,
  MemberPolicyDto,
  ThreadFactDto,
} from "@/src/shared/collaboration-contracts";
import type {
  MembershipState,
  ProjectMember,
} from "@/src/shared/project-context-contracts";
import {
  apiErrorCopy,
  caughtApiErrorCopy,
} from "@/src/shared/api-error-copy";

type ThreadDetail = {
  availability: "ready" | "repair_required";
  id: string;
  policy: MemberPolicyDto;
  policyVersion: number;
  projectId: string;
  title: string;
  version: number;
};

type PolicyUpdate = {
  fact: Extract<ThreadFactDto, { type: "policy_changed" }>;
  policy: MemberPolicyDto;
  thread: ThreadDetail;
};

type ThreadPolicyPanelProps = {
  canEdit?: boolean;
  modalBackgroundRef?: RefObject<HTMLElement | null>;
  onModalChange?: (open: boolean) => void;
  projectId: string;
  threadId: string;
};

type UnknownReceipt = {
  expectedVersion: number;
  memberAgentIds: string[];
  operationId: string;
};

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(
    value
      && typeof value === "object"
      && !Array.isArray(value)
      && Object.keys(value).length === keys.length
      && Object.keys(value).every((key) => keys.includes(key)),
  );
}

function validPolicy(value: unknown): value is MemberPolicyDto {
  if (!exactKeys(value, [
    "availability",
    "createdAt",
    "members",
    "revisionId",
    "unavailableMemberIds",
    "version",
  ])) return false;
  if (
    (value.availability !== "ready" && value.availability !== "repair_required")
    || typeof value.createdAt !== "string"
    || typeof value.revisionId !== "string"
    || !Number.isSafeInteger(value.version)
    || Number(value.version) < 1
    || !Array.isArray(value.members)
    || !Array.isArray(value.unavailableMemberIds)
    || !value.unavailableMemberIds.every((id) => typeof id === "string")
  ) return false;
  const positions = new Set<number>();
  const memberIds = new Set<string>();
  for (const member of value.members) {
    if (
      !exactKeys(member, [
        "agentId",
        "displayNameSnapshot",
        "live",
        "position",
      ])
      || typeof member.agentId !== "string"
      || typeof member.displayNameSnapshot !== "string"
      || (member.live !== "current" && member.live !== "removed")
      || !Number.isSafeInteger(member.position)
      || Number(member.position) < 0
      || positions.has(Number(member.position))
      || memberIds.has(member.agentId)
    ) return false;
    positions.add(Number(member.position));
    memberIds.add(member.agentId);
  }
  return value.members.length > 0
    && [...positions].sort((a, b) => a - b).every((position, index) => position === index);
}

function parseDetail(
  value: unknown,
  projectId: string,
  threadId: string,
): ThreadDetail {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !("thread" in value)
  ) throw new Error("Invalid thread policy envelope.");
  const thread = value.thread as Record<string, unknown> | null;
  if (
    !thread
    || typeof thread !== "object"
    || Array.isArray(thread)
    || thread.projectId !== projectId
    || thread.id !== threadId
    || typeof thread.title !== "string"
    || !Number.isSafeInteger(thread.version)
    || Number(thread.version) < 1
    || !Number.isSafeInteger(thread.policyVersion)
    || Number(thread.policyVersion) < 1
    || (thread.availability !== "ready" && thread.availability !== "repair_required")
    || !validPolicy(thread.policy)
    || thread.policy.version !== thread.policyVersion
    || thread.policy.availability !== thread.availability
  ) throw new Error("Invalid thread policy envelope.");
  return thread as ThreadDetail;
}

function parseMembers(value: unknown): ProjectMember[] {
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || !Array.isArray((value as MembershipState).members)
  ) throw new Error("Invalid project roster.");
  const members = (value as MembershipState).members;
  if (
    members.some((member) =>
      !member
      || typeof member !== "object"
      || typeof member.agentId !== "string"
      || typeof member.name !== "string"
    )
    || new Set(members.map((member) => member.agentId)).size !== members.length
  ) throw new Error("Invalid project roster.");
  return members;
}

function parseUpdate(
  value: unknown,
  projectId: string,
  threadId: string,
): PolicyUpdate {
  if (!exactKeys(value, ["fact", "policy", "thread"])) {
    throw new Error("Invalid policy update envelope.");
  }
  const thread = parseDetail({ thread: value.thread }, projectId, threadId);
  if (
    !validPolicy(value.policy)
    || value.policy.revisionId !== thread.policy.revisionId
    || value.policy.version !== thread.policyVersion
  ) throw new Error("Invalid policy update envelope.");
  const fact = value.fact as Partial<ThreadFactDto>;
  if (
    !fact
    || fact.type !== "policy_changed"
    || fact.projectId !== projectId
    || fact.threadId !== threadId
    || fact.policyRevisionId !== value.policy.revisionId
    || fact.payload?.policyVersion !== value.policy.version
  ) throw new Error("Invalid policy update envelope.");
  return value as PolicyUpdate;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

export function ThreadPolicyPanel({
  canEdit = true,
  modalBackgroundRef,
  onModalChange,
  projectId,
  threadId,
}: ThreadPolicyPanelProps) {
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [receipt, setReceipt] = useState<UnknownReceipt | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstCheckboxRef = useRef<HTMLInputElement>(null);
  const requestEpochRef = useRef(0);
  const targetGuard = useTargetRequestGuard(`${projectId}|${threadId}|`);
  const closeDialog = useCallback(() => {
    if (!submitting) setDialogOpen(false);
  }, [submitting]);
  const modalOptions = useMemo(() => ({
    active: dialogOpen,
    dialogRef,
    hideBackground: true,
    inertRootRefs: modalBackgroundRef ? [modalBackgroundRef] : [],
    initialFocusRef: firstCheckboxRef,
    restoreFocusRef: editButtonRef,
    onClose: closeDialog,
  }), [closeDialog, dialogOpen, modalBackgroundRef]);
  useModalSurface(modalOptions);

  useEffect(() => {
    onModalChange?.(dialogOpen);
    return () => {
      if (dialogOpen) onModalChange?.(false);
    };
  }, [dialogOpen, onModalChange]);

  useEffect(() => {
    if (status) headingRef.current?.focus();
  }, [status]);

  const load = useCallback(async (
    preserveChoices?: string[],
  ): Promise<ThreadDetail | null> => {
    const epoch = requestEpochRef.current;
    const request = targetGuard.capture();
    setLoading(true);
    setLoadError(null);
    try {
      const base = `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`;
      const [detailResponse, membersResponse] = await Promise.all([
        fetch(base, { signal: request.signal }),
        fetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
          signal: request.signal,
        }),
      ]);
      if (!detailResponse.ok || !membersResponse.ok) {
        const failed = !detailResponse.ok ? detailResponse : membersResponse;
        const payload = await readJson(failed);
        throw new Error(
          apiErrorCopy(
            payload as Partial<CollaborationApiError>,
            "无法加载对话成员策略。",
          ),
        );
      }
      const nextThread = parseDetail(await readJson(detailResponse), projectId, threadId);
      const nextMembers = parseMembers(await readJson(membersResponse));
      if (epoch !== requestEpochRef.current || !request.isCurrent()) return null;
      setThread(nextThread);
      setMembers(nextMembers);
      if (preserveChoices) {
        const currentIds = new Set(nextMembers.map((member) => member.agentId));
        setSelectedIds(preserveChoices.filter((id) => currentIds.has(id)));
      }
      return nextThread;
    } catch (cause) {
      if (epoch === requestEpochRef.current && request.isCurrent()) {
        setLoadError(caughtApiErrorCopy(cause, "无法加载对话成员策略。"));
      }
      return null;
    } finally {
      if (epoch === requestEpochRef.current && request.isCurrent()) setLoading(false);
    }
  }, [projectId, targetGuard, threadId]);

  useEffect(() => {
    requestEpochRef.current += 1;
    setThread(null);
    setMembers([]);
    setDialogOpen(false);
    setSelectedIds([]);
    setWriteError(null);
    setStatus("");
    setReceipt(null);
    void load();
    return () => {
      requestEpochRef.current += 1;
    };
  }, [load]);

  function openEditor() {
    if (!thread || !canEdit) return;
    const currentIds = new Set(members.map((member) => member.agentId));
    setSelectedIds(
      [...thread.policy.members]
        .sort((left, right) => left.position - right.position)
        .map((member) => member.agentId)
        .filter((id) => currentIds.has(id)),
    );
    setWriteError(null);
    setReceipt(null);
    setDialogOpen(true);
  }

  function finish(update: PolicyUpdate, reconciled: boolean) {
    setThread(update.thread);
    setSelectedIds(update.policy.members.map((member) => member.agentId));
    setDialogOpen(false);
    setWriteError(null);
    setReceipt(null);
    setStatus(
      `${reconciled ? "已通过操作核对确认" : "已更新"}对话成员策略，策略版本 ${update.policy.version}，事实 ${update.fact.id}。`,
    );
  }

  async function reconcile(unknown: UnknownReceipt): Promise<boolean> {
    const request = targetGuard.capture();
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(
          threadId,
        )}/operations/${encodeURIComponent(unknown.operationId)}`,
        { signal: request.signal },
      );
      if (!request.isCurrent()) return false;
      if (!response.ok) return false;
      const payload = await readJson(response);
      if (
        !exactKeys(payload, [
          "httpStatus",
          "kind",
          "operationId",
          "response",
          "status",
        ])
        || payload.operationId !== unknown.operationId
        || payload.kind !== "policy_update"
        || payload.status !== "completed"
        || payload.httpStatus !== 200
      ) return false;
      if (!request.isCurrent()) return false;
      finish(parseUpdate(payload.response, projectId, threadId), true);
      return true;
    } catch {
      return false;
    }
  }

  async function submitPolicy(
    input: UnknownReceipt,
  ): Promise<void> {
    const request = targetGuard.capture();
    setSubmitting(true);
    setWriteError(null);
    setReceipt(null);
    let responseReceived = false;
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(
          threadId,
        )}/policy`,
        {
          body: JSON.stringify(input),
          headers: { "content-type": "application/json" },
          method: "PATCH",
          signal: request.signal,
        },
      );
      responseReceived = true;
      const payload = await readJson(response);
      if (!request.isCurrent()) return;
      if (!response.ok) {
        const error = payload as {
          error?: { code?: string; currentVersion?: number };
        };
        if (response.status === 409 && error.error?.code === "VERSION_CONFLICT") {
          await Promise.all([
            load(input.memberAgentIds),
            fetch(
              `/api/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(
                threadId,
              )}/facts`,
              { signal: request.signal },
            ).catch(() => null),
          ]);
          if (!request.isCurrent()) return;
          setWriteError(
            "策略已被其他操作更新。已重新加载最新版本和事实，并保留仍有效的选择，请确认后再次提交。",
          );
          return;
        }
        setWriteError(
          apiErrorCopy(
            payload as Partial<CollaborationApiError>,
            "无法更新对话成员策略。",
          ),
        );
        return;
      }
      finish(parseUpdate(payload, projectId, threadId), false);
      return;
    } catch (cause) {
      if (!request.isCurrent()) return;
      if (responseReceived) {
        setWriteError(caughtApiErrorCopy(cause, "策略响应无效，已安全停止更新。"));
        return;
      }
      if (await reconcile(input)) return;
      setReceipt(input);
      setWriteError(
        `无法确认策略是否已更新。operation receipt：${input.operationId}。不会自动重发。`,
      );
    } finally {
      if (request.isCurrent()) setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!thread || selectedIds.length < 2 || submitting) return;
    void submitPolicy({
      expectedVersion: thread.version,
      memberAgentIds: selectedIds,
      operationId: crypto.randomUUID(),
    });
  }

  const orderedPolicy = [...(thread?.policy.members ?? [])].sort(
    (left, right) => left.position - right.position,
  );
  const rosterById = new Map(members.map((member) => [member.agentId, member]));
  const disabledReason = !canEdit
    ? "只有项目所有者可以修改对话成员策略。"
    : selectedIds.length < 2
      ? "至少选择 2 名不同的当前项目成员。"
      : submitting
        ? "策略更新请求处理中，表单暂不可用。"
        : "";

  return (
    <section
      aria-labelledby={`thread-policy-title-${threadId}`}
      className="stack thread-policy-panel"
      role="region"
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">选中对话</p>
          <h3
            id={`thread-policy-title-${threadId}`}
            ref={headingRef}
            tabIndex={-1}
          >
            对话成员策略
          </h3>
        </div>
        {thread ? <span className="status-label">策略版本 {thread.policy.version}</span> : null}
      </div>
      {loading && !thread ? (
        <p aria-busy="true" className="state-message">正在加载对话成员策略…</p>
      ) : loadError ? (
        <div className="state-message stack">
          <p className="error-text" role="alert">{loadError}</p>
          <button onClick={() => void load()} type="button">重试加载成员策略</button>
        </div>
      ) : thread ? (
        <>
          <p>
            此策略是不可变的对话版本快照；项目当前成员是实时名单，两者不会自动同步。
          </p>
          <div className="stack">
            <p className="context-label">对话策略成员（按协作顺序）</p>
            <ol className="policy-member-list">
              {orderedPolicy.map((member) => {
                const current = rosterById.get(member.agentId);
                const unavailable = thread.policy.unavailableMemberIds.includes(member.agentId);
                return (
                  <li className="policy-member-item" key={member.agentId}>
                    <span className="status-label">{member.position + 1}</span>
                    <span>
                      <strong>{member.displayNameSnapshot}</strong>
                      {current ? (
                        <span className="muted">
                          当前名称：{current.name}
                          {current.name !== member.displayNameSnapshot
                            ? "（快照名称已保留）"
                            : ""}
                        </span>
                      ) : (
                        <span className="error-text">已移出项目，快照仍保留</span>
                      )}
                    </span>
                    {unavailable ? (
                      <span className="status-label status-failed">Provider 不可用</span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </div>
          <div className="stack">
            <p className="context-label">项目当前成员（实时名单）</p>
            <p className="muted">新加入项目的成员不会自动加入对话策略。</p>
            {members.length ? (
              <ul className="policy-roster-list">
                {members.map((member) => <li key={member.agentId}>{member.name}</li>)}
              </ul>
            ) : null}
            {members.length < 2 ? (
              <p className="error-text" role="alert">
                当前项目不足两名成员，暂时无法修复策略。
              </p>
            ) : null}
          </div>
          {thread.policy.availability === "repair_required" ? (
            <div className="state-message stack">
              <p className="error-text" role="alert">
                需要修复：策略包含已移出项目或无效的成员，Agent 续接已停止。
              </p>
              <button
                className="button-primary"
                disabled={!canEdit || members.length < 2}
                onClick={openEditor}
                ref={editButtonRef}
                type="button"
              >
                修复对话成员策略
              </button>
              {!canEdit || members.length < 2 ? <p className="muted">{disabledReason}</p> : null}
            </div>
          ) : (
            <>
              <button
                disabled={!canEdit || members.length < 2}
                onClick={openEditor}
                ref={editButtonRef}
                type="button"
              >
                编辑对话成员策略
              </button>
              {!canEdit || members.length < 2 ? <p className="muted">{disabledReason}</p> : null}
            </>
          )}
        </>
      ) : (
        <div className="state-message stack">
          <p className="error-text" role="alert">对话策略缺失或损坏，已停止自动操作。</p>
          <button onClick={() => void load()} type="button">重新读取对话策略</button>
        </div>
      )}
      <p aria-atomic="true" aria-live="polite" className="muted" role="status">
        {status}
      </p>
      {dialogOpen
        ? createPortal(
            <div
              aria-describedby={`thread-policy-help-${threadId}`}
              aria-labelledby={`thread-policy-dialog-title-${threadId}`}
              aria-modal="true"
              className="modal-surface policy-edit-dialog"
              ref={dialogRef}
              role="dialog"
            >
              <div className="panel-heading">
                <h3 id={`thread-policy-dialog-title-${threadId}`}>
                  编辑对话成员策略
                </h3>
                <button
                  aria-label="关闭成员策略编辑"
                  className="button-ghost"
                  data-dialog-close="true"
                  disabled={submitting}
                  onClick={closeDialog}
                  type="button"
                >
                  关闭
                </button>
              </div>
              <p id={`thread-policy-help-${threadId}`}>
                选择至少 2 名当前项目成员。名单按选择顺序保存；项目以后新增成员不会自动加入。
              </p>
              <form className="stack" onSubmit={handleSubmit}>
                <fieldset disabled={submitting}>
                  <legend>当前项目成员</legend>
                  <div className="stack">
                    {members.map((member, index) => (
                      <label className="check-row" key={member.agentId}>
                        <input
                          checked={selectedIds.includes(member.agentId)}
                          onChange={(event) => {
                            setSelectedIds((current) =>
                              event.target.checked
                                ? [...current.filter((id) => id !== member.agentId), member.agentId]
                                : current.filter((id) => id !== member.agentId),
                            );
                            setWriteError(null);
                          }}
                          ref={index === 0 ? firstCheckboxRef : undefined}
                          type="checkbox"
                        />
                        <span>{member.name}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {disabledReason ? <p className="muted">{disabledReason}</p> : null}
                <div className="form-row">
                  <button
                    className="button-primary"
                    disabled={selectedIds.length < 2 || submitting}
                    type="submit"
                  >
                    {submitting ? "正在更新策略…" : "保存成员策略"}
                  </button>
                  <button disabled={submitting} onClick={closeDialog} type="button">
                    取消
                  </button>
                </div>
                {writeError ? <p className="error-text" role="alert">{writeError}</p> : null}
                {receipt ? (
                  <div className="form-row">
                    <button
                      disabled={submitting}
                      onClick={async () => {
                        const request = targetGuard.capture();
                        setSubmitting(true);
                        setWriteError(null);
                        const reconciled = await reconcile(receipt);
                        if (!request.isCurrent()) return;
                        if (!reconciled) {
                          setWriteError(
                            `仍无法确认策略是否已更新。operation receipt：${receipt.operationId}。不会自动重发。`,
                          );
                        }
                        setSubmitting(false);
                      }}
                      type="button"
                    >
                      仅重新核对策略操作
                    </button>
                    <button
                      disabled={submitting}
                      onClick={() => void submitPolicy(receipt)}
                      type="button"
                    >
                      使用同一 operation 明确重试
                    </button>
                  </div>
                ) : null}
              </form>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}

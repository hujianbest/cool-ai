"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import type { ApiError } from "@/src/shared/contracts";
import { MissionDeliverySurface } from "@/components/review/review-product-surface";
import type {
  MembershipState,
  Mission,
  MissionState,
  ProjectMember,
  WorkItem,
  WorkItemStatus,
} from "@/src/shared/project-context-contracts";

type ErrorPayload = Partial<ApiError> & {
  error?: {
    code: string;
    message: string;
    fields?: Array<{ field: string; code: string }>;
    currentVersion?: number;
  };
};
type MissionDraft = { title: string; goal: string };
type WorkItemDraft = {
  title: string;
  description: string;
  assigneeAgentId: string;
  dependencyIds: string[];
};

const EMPTY_MISSION: MissionDraft = { title: "", goal: "" };
const EMPTY_WORK_ITEM: WorkItemDraft = {
  title: "",
  description: "",
  assigneeAgentId: "",
  dependencyIds: [],
};
const JSON_HEADERS = { "content-type": "application/json" };
const STATUS_GROUPS: Array<{
  status: WorkItemStatus;
  label: string;
}> = [
  { status: "todo", label: "待办" },
  { status: "in_progress", label: "进行中" },
  { status: "blocked", label: "阻塞" },
  { status: "done", label: "完成" },
];
const TRANSITIONS: Record<
  WorkItemStatus,
  Array<{ status: WorkItemStatus; label: string }>
> = {
  todo: [
    { status: "in_progress", label: "开始" },
    { status: "blocked", label: "标记阻塞" },
  ],
  in_progress: [
    { status: "blocked", label: "标记阻塞" },
    { status: "done", label: "完成" },
  ],
  blocked: [
    { status: "todo", label: "返回待办" },
    { status: "in_progress", label: "开始" },
  ],
  done: [{ status: "in_progress", label: "重新打开" }],
};

function apiMessage(payload: ErrorPayload): string {
  switch (payload.error?.code) {
    case "RESOURCE_CONFLICT":
      return "数据已更新，请刷新后重试。";
    case "DEPENDENCY_NOT_READY":
      return "前置依赖尚未完成，当前操作无法执行。";
    case "DEPENDENCY_CYCLE":
      return "前置依赖形成循环，请调整选择。";
    case "DEPENDENCY_SCOPE":
      return "前置依赖必须属于当前使命。";
    case "ASSIGNEE_NOT_MEMBER":
      return "负责人必须是当前项目成员。";
    case "INVALID_TRANSITION":
      return "当前任务状态不允许此操作。";
    case "MISSION_EXISTS":
      return "当前项目已经存在使命，请刷新后编辑。";
    case "INVALID_INPUT": {
      const field = payload.error.fields?.[0]?.field;
      if (field === "title") return "标题格式无效，请检查长度。";
      if (field === "goal") return "使命目标格式无效，请检查长度。";
      if (field === "description") return "任务说明格式无效，请检查长度。";
      if (field === "assigneeAgentId") return "负责人选择无效。";
      if (field === "dependencyIds") return "前置依赖选择无效。";
      return "表单内容无效，请检查后重试。";
    }
    default:
      return "操作失败，请稍后重试。";
  }
}

function isConflict(payload: ErrorPayload): boolean {
  return payload.error?.code === "RESOURCE_CONFLICT";
}

function memberName(members: ProjectMember[], agentId: string | null): string {
  if (!agentId) return "未分配";
  return members.find((member) => member.agentId === agentId)?.name ?? agentId;
}

function dependencyNames(items: WorkItem[], ids: string[]): string {
  return ids
    .map((id) => items.find((item) => item.id === id)?.title ?? id)
    .join("、");
}

export function MissionBoard({ projectId }: { projectId: string }) {
  const errorId = `mission-board-error-${projectId}`;
  const [mission, setMission] = useState<Mission | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [success, setSuccess] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [missionDraft, setMissionDraft] =
    useState<MissionDraft>(EMPTY_MISSION);
  const [editingMission, setEditingMission] = useState(false);
  const [workItemDraft, setWorkItemDraft] =
    useState<WorkItemDraft>(EMPTY_WORK_ITEM);
  const [editingWorkItemId, setEditingWorkItemId] = useState<string | null>(
    null,
  );
  const [editDraft, setEditDraft] =
    useState<WorkItemDraft>(EMPTY_WORK_ITEM);
  const missionTitleInputRef = useRef<HTMLInputElement>(null);
  const missionGoalInputRef = useRef<HTMLTextAreaElement>(null);
  const missionHeadingRef = useRef<HTMLHeadingElement>(null);
  const workItemTitleRef = useRef<HTMLInputElement>(null);
  const editTitleRef = useRef<HTMLInputElement>(null);
  const workItemHeadingRefs = useRef(new Map<string, HTMLHeadingElement>());
  const [focusMission, setFocusMission] = useState(false);
  const [focusWorkItemId, setFocusWorkItemId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    setError(null);
    setConflict(false);
    setSuccess("");
    void Promise.all([
      fetch(`/api/projects/${projectId}/mission`).then(async (response) => {
        const payload = (await response.json()) as MissionState & ErrorPayload;
        if (!response.ok) throw new Error("mission");
        if (!Array.isArray(payload.workItems) || !("mission" in payload)) {
          throw new Error("mission");
        }
        return payload;
      }),
      fetch(`/api/projects/${projectId}/members`).then(async (response) => {
        const payload = (await response.json()) as MembershipState &
          ErrorPayload;
        if (!response.ok || !Array.isArray(payload.members)) {
          throw new Error("members");
        }
        return payload.members;
      }),
    ])
      .then(([state, loadedMembers]) => {
        if (!active) return;
        setMission(state.mission);
        setWorkItems(state.workItems);
        setMembers(loadedMembers);
        setMissionDraft(
          state.mission
            ? { title: state.mission.title, goal: state.mission.goal }
            : EMPTY_MISSION,
        );
      })
      .catch(() => {
        if (active) setError("无法加载使命看板，请重试。");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, reloadKey]);

  useEffect(() => {
    if (!focusMission) return;
    missionHeadingRef.current?.focus();
    setFocusMission(false);
  }, [focusMission, mission]);

  useEffect(() => {
    if (!focusWorkItemId) return;
    workItemHeadingRefs.current.get(focusWorkItemId)?.focus();
    setFocusWorkItemId(null);
  }, [focusWorkItemId, workItems]);

  function resetOperationState() {
    setError(null);
    setConflict(false);
    setSuccess("");
  }

  async function saveMission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resetOperationState();
    if (!missionDraft.title.trim()) {
      setError("请输入使命标题。");
      missionTitleInputRef.current?.focus();
      return;
    }
    if (!missionDraft.goal.trim()) {
      setError("请输入使命目标。");
      missionGoalInputRef.current?.focus();
      return;
    }
    setIsSaving(true);
    try {
      const response = await fetch(
        mission
          ? `/api/missions/${mission.id}`
          : `/api/projects/${projectId}/mission`,
        {
          body: JSON.stringify({
            title: missionDraft.title,
            goal: missionDraft.goal,
            ...(mission ? { expectedVersion: mission.version } : {}),
          }),
          headers: JSON_HEADERS,
          method: mission ? "PATCH" : "POST",
        },
      );
      const payload = (await response.json()) as { mission?: Mission } &
        ErrorPayload;
      if (!response.ok || !payload.mission) {
        setConflict(isConflict(payload));
        throw new Error(apiMessage(payload));
      }
      setMission(payload.mission);
      setMissionDraft({
        title: payload.mission.title,
        goal: payload.mission.goal,
      });
      setEditingMission(false);
      setSuccess(mission ? "使命已保存。" : "使命已创建。");
      setFocusMission(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
      missionTitleInputRef.current?.focus();
    } finally {
      setIsSaving(false);
    }
  }

  async function createWorkItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mission || isSaving) return;
    resetOperationState();
    if (!workItemDraft.title.trim()) {
      setError("请输入任务标题。");
      workItemTitleRef.current?.focus();
      return;
    }
    setIsSaving(true);
    try {
      const response = await fetch(
        `/api/missions/${mission.id}/work-items`,
        {
          body: JSON.stringify({
            title: workItemDraft.title,
            description: workItemDraft.description,
            assigneeAgentId: workItemDraft.assigneeAgentId || null,
            dependencyIds: workItemDraft.dependencyIds,
          }),
          headers: JSON_HEADERS,
          method: "POST",
        },
      );
      const payload = (await response.json()) as { workItem?: WorkItem } &
        ErrorPayload;
      if (!response.ok || !payload.workItem) {
        setConflict(isConflict(payload));
        throw new Error(apiMessage(payload));
      }
      setWorkItems((current) => [...current, payload.workItem!]);
      setWorkItemDraft(EMPTY_WORK_ITEM);
      setSuccess("任务已创建。");
      setFocusWorkItemId(payload.workItem.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
      workItemTitleRef.current?.focus();
    } finally {
      setIsSaving(false);
    }
  }

  function beginEdit(item: WorkItem) {
    resetOperationState();
    setEditingWorkItemId(item.id);
    setEditDraft({
      title: item.title,
      description: item.description,
      assigneeAgentId: item.assigneeAgentId ?? "",
      dependencyIds: item.dependencyIds,
    });
    queueMicrotask(() => editTitleRef.current?.focus());
  }

  async function saveWorkItem(
    event: FormEvent<HTMLFormElement>,
    item: WorkItem,
  ) {
    event.preventDefault();
    resetOperationState();
    if (!editDraft.title.trim()) {
      setError("请输入任务标题。");
      editTitleRef.current?.focus();
      return;
    }
    setIsSaving(true);
    try {
      const response = await fetch(`/api/work-items/${item.id}`, {
        body: JSON.stringify({
          title: editDraft.title,
          description: editDraft.description,
          assigneeAgentId: editDraft.assigneeAgentId || null,
          dependencyIds: editDraft.dependencyIds,
          expectedVersion: item.version,
        }),
        headers: JSON_HEADERS,
        method: "PATCH",
      });
      const payload = (await response.json()) as { workItem?: WorkItem } &
        ErrorPayload;
      if (!response.ok || !payload.workItem) {
        setConflict(isConflict(payload));
        throw new Error(apiMessage(payload));
      }
      setWorkItems((current) =>
        current.map((candidate) =>
          candidate.id === item.id ? payload.workItem! : candidate,
        ),
      );
      setEditingWorkItemId(null);
      setSuccess("任务已保存。");
      setFocusWorkItemId(item.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
      editTitleRef.current?.focus();
    } finally {
      setIsSaving(false);
    }
  }

  async function transitionWorkItem(
    item: WorkItem,
    toStatus: WorkItemStatus,
  ) {
    resetOperationState();
    setIsSaving(true);
    try {
      const response = await fetch(
        `/api/work-items/${item.id}/transition`,
        {
          body: JSON.stringify({
            toStatus,
            expectedVersion: item.version,
          }),
          headers: JSON_HEADERS,
          method: "POST",
        },
      );
      const payload = (await response.json()) as { workItem?: WorkItem } &
        ErrorPayload;
      if (!response.ok || !payload.workItem) {
        setConflict(isConflict(payload));
        throw new Error(apiMessage(payload));
      }
      setWorkItems((current) =>
        current.map((candidate) =>
          candidate.id === item.id ? payload.workItem! : candidate,
        ),
      );
      setSuccess("任务状态已更新。");
      setFocusWorkItemId(item.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
    } finally {
      setIsSaving(false);
    }
  }

  function dependencyFieldset(
    draft: WorkItemDraft,
    update: (dependencyIds: string[]) => void,
    excludedId?: string,
    label = "前置依赖",
  ) {
    const options = workItems.filter((item) => item.id !== excludedId);
    return (
      <fieldset aria-describedby={error ? errorId : undefined}>
        <legend>{label}</legend>
        {options.length === 0 ? (
          <p className="muted">暂无可选前置任务。</p>
        ) : (
          <div className="stack">
            {options.map((item) => (
              <label className="check-row" key={item.id}>
                <input
                  checked={draft.dependencyIds.includes(item.id)}
                  onChange={() =>
                    update(
                      draft.dependencyIds.includes(item.id)
                        ? draft.dependencyIds.filter((id) => id !== item.id)
                        : [...draft.dependencyIds, item.id],
                    )
                  }
                  type="checkbox"
                />
                <span>{item.title}</span>
              </label>
            ))}
          </div>
        )}
      </fieldset>
    );
  }

  function assigneeSelect(
    value: string,
    update: (value: string) => void,
    label: string,
  ) {
    return (
      <div className="form-field">
        <label>
          {label}
          <select
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => update(event.target.value)}
            value={value}
          >
            <option value="">未分配</option>
            {members.map((member) => (
              <option key={member.agentId} value={member.agentId}>
                {member.name} · {member.role}
              </option>
            ))}
          </select>
        </label>
      </div>
    );
  }

  const missionForm = (
    <form className="stack mission-form" onSubmit={saveMission}>
      <div className="form-field">
        <label htmlFor={`mission-title-${projectId}`}>使命标题</label>
        <input
          aria-describedby={error ? errorId : undefined}
          id={`mission-title-${projectId}`}
          onChange={(event) =>
            setMissionDraft((current) => ({
              ...current,
              title: event.target.value,
            }))
          }
          placeholder="例如：发布首个可用版本"
          ref={missionTitleInputRef}
          value={missionDraft.title}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`mission-goal-${projectId}`}>使命目标</label>
        <textarea
          aria-describedby={error ? errorId : undefined}
          id={`mission-goal-${projectId}`}
          onChange={(event) =>
            setMissionDraft((current) => ({
              ...current,
              goal: event.target.value,
            }))
          }
          ref={missionGoalInputRef}
          value={missionDraft.goal}
        />
      </div>
      <div className="form-row">
        {mission ? (
          <button onClick={() => setEditingMission(false)} type="button">
            取消
          </button>
        ) : null}
        <button disabled={isSaving} type="submit">
          {isSaving
            ? "正在保存使命…"
            : mission
              ? "保存使命"
              : "创建使命"}
        </button>
      </div>
    </form>
  );

  return (
    <section
      aria-labelledby={`mission-board-title-${projectId}`}
      className="stack mission-board"
      id="mission-board"
    >
      <h2 id={`mission-board-title-${projectId}`}>使命看板</h2>
      {isLoading ? (
        <p aria-busy="true" className="state-message">
          正在加载使命看板…
        </p>
      ) : error?.startsWith("无法加载") ? (
        <div className="state-message stack">
          <p className="error-text" role="alert">
            {error}
          </p>
          <button
            onClick={() => setReloadKey((current) => current + 1)}
            type="button"
          >
            重试加载使命看板
          </button>
        </div>
      ) : !mission ? (
        <div className="stack">
          <p className="state-message">尚未创建使命。</p>
          {missionForm}
        </div>
      ) : (
        <>
          <header className="stack mission-summary">
            <h3 ref={missionHeadingRef} tabIndex={-1}>
              {mission.title}
            </h3>
            <p>{mission.goal}</p>
            <button
              onClick={() => {
                resetOperationState();
                setMissionDraft({
                  title: mission.title,
                  goal: mission.goal,
                });
                setEditingMission(true);
                queueMicrotask(() => missionTitleInputRef.current?.focus());
              }}
              type="button"
            >
              编辑使命
            </button>
          </header>
          {editingMission ? missionForm : null}

          <section
            aria-labelledby={`new-work-item-${projectId}`}
            className="stack"
          >
            <h3 id={`new-work-item-${projectId}`}>创建任务</h3>
            <form className="stack work-item-form" onSubmit={createWorkItem}>
              <div className="form-field">
                <label htmlFor={`work-item-title-${projectId}`}>任务标题</label>
                <input
                  aria-describedby={error ? errorId : undefined}
                  id={`work-item-title-${projectId}`}
                  onChange={(event) =>
                    setWorkItemDraft((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                  placeholder="例如：补齐发布检查清单"
                  ref={workItemTitleRef}
                  value={workItemDraft.title}
                />
              </div>
              <div className="form-field">
                <label htmlFor={`work-item-description-${projectId}`}>
                  任务说明
                </label>
                <textarea
                  aria-describedby={error ? errorId : undefined}
                  id={`work-item-description-${projectId}`}
                  onChange={(event) =>
                    setWorkItemDraft((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  value={workItemDraft.description}
                />
              </div>
              {assigneeSelect(
                workItemDraft.assigneeAgentId,
                (assigneeAgentId) =>
                  setWorkItemDraft((current) => ({
                    ...current,
                    assigneeAgentId,
                  })),
                "负责人",
              )}
              {dependencyFieldset(workItemDraft, (dependencyIds) =>
                setWorkItemDraft((current) => ({
                  ...current,
                  dependencyIds,
                })),
              )}
              <button disabled={isSaving} type="submit">
                {isSaving ? "正在创建任务…" : "创建任务"}
              </button>
            </form>
          </section>

          <div
            aria-label="使命任务看板"
            className="mission-board-grid"
            role="region"
          >
            {STATUS_GROUPS.map(({ status, label }) => (
              <section
                aria-labelledby={`status-${status}-${projectId}`}
                className={`mission-status status-${status}`}
                key={status}
                role="region"
              >
                <h3 id={`status-${status}-${projectId}`}>{label}</h3>
                <ul aria-label={`${label}任务`} className="stack">
                  {workItems
                    .filter((item) => item.status === status)
                    .map((item) => (
                      <li className="task-summary stack" key={item.id}>
                        <h4
                          ref={(element) => {
                            if (element)
                              workItemHeadingRefs.current.set(item.id, element);
                            else workItemHeadingRefs.current.delete(item.id);
                          }}
                          tabIndex={-1}
                        >
                          {item.title}
                        </h4>
                        <p>{item.description || "暂无说明。"}</p>
                        <p>负责人：{memberName(members, item.assigneeAgentId)}</p>
                        {item.dependencyIds.length > 0 ? (
                          <p>
                            等待:{" "}
                            {dependencyNames(workItems, item.dependencyIds)}
                          </p>
                        ) : null}
                        {editingWorkItemId === item.id ? (
                          <form
                            className="stack"
                            onSubmit={(event) => saveWorkItem(event, item)}
                          >
                            <label>
                              {`编辑任务标题 ${item.title}`}
                              <input
                                aria-describedby={error ? errorId : undefined}
                                onChange={(event) =>
                                  setEditDraft((current) => ({
                                    ...current,
                                    title: event.target.value,
                                  }))
                                }
                                placeholder="输入更新后的简短标题"
                                ref={editTitleRef}
                                value={editDraft.title}
                              />
                            </label>
                            <label>
                              {`编辑任务说明 ${item.title}`}
                              <textarea
                                aria-describedby={error ? errorId : undefined}
                                onChange={(event) =>
                                  setEditDraft((current) => ({
                                    ...current,
                                    description: event.target.value,
                                  }))
                                }
                                value={editDraft.description}
                              />
                            </label>
                            {assigneeSelect(
                              editDraft.assigneeAgentId,
                              (assigneeAgentId) =>
                                setEditDraft((current) => ({
                                  ...current,
                                  assigneeAgentId,
                                })),
                              `编辑任务负责人 ${item.title}`,
                            )}
                            {dependencyFieldset(
                              editDraft,
                              (dependencyIds) =>
                                setEditDraft((current) => ({
                                  ...current,
                                  dependencyIds,
                                })),
                              item.id,
                              `编辑任务前置依赖 ${item.title}`,
                            )}
                            <div className="form-row">
                              <button
                                onClick={() => setEditingWorkItemId(null)}
                                type="button"
                              >
                                取消编辑
                              </button>
                              <button disabled={isSaving} type="submit">
                                {`保存任务 ${item.title}`}
                              </button>
                            </div>
                          </form>
                        ) : (
                          <>
                            <button
                              onClick={() => beginEdit(item)}
                              type="button"
                            >
                              {`编辑任务 ${item.title}`}
                            </button>
                            <div
                              aria-label={`${item.title} 状态操作`}
                              className="form-row"
                              role="group"
                            >
                              {TRANSITIONS[item.status].map((transition) => (
                                <button
                                  disabled={isSaving}
                                  key={transition.status}
                                  onClick={() =>
                                    void transitionWorkItem(
                                      item,
                                      transition.status,
                                    )
                                  }
                                  type="button"
                                >
                                  {`${transition.label}任务 ${item.title}`}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </li>
                    ))}
                  {workItems.every((item) => item.status !== status) ? (
                    <li className="muted">暂无{label}任务。</li>
                  ) : null}
                </ul>
              </section>
            ))}
          </div>
          <MissionDeliverySurface missionId={mission.id} />
        </>
      )}
      {error && !error.startsWith("无法加载") ? (
        <div className="state-message stack">
          <p className="error-text" id={errorId} role="alert">
            {error}
          </p>
          {conflict ? (
            <button
              onClick={() => setReloadKey((current) => current + 1)}
              type="button"
            >
              刷新使命看板
            </button>
          ) : null}
        </div>
      ) : null}
      {success ? (
        <p aria-live="polite" aria-label="保存结果" role="status">
          {success}
        </p>
      ) : null}
    </section>
  );
}

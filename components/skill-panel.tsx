"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

import {
  trapModalFocus,
  useModalSurface,
  useNarrowMode,
} from "@/components/mobile-dialog";
import type { Skill } from "@/src/shared/team-contracts";

type FieldName = "description" | "instructions" | "name";

type ErrorPayload = {
  error?: {
    code?: string;
    fields?: Array<{ field: string; code: string }>;
  };
};

const fieldLabels: Record<FieldName, string> = {
  description: "技能说明",
  instructions: "指令正文",
  name: "技能名称",
};
const SKILL_EDITOR_INERT = [".cockpit-sidebar", "#skill-resource-panel"];

function isFieldName(value: string): value is FieldName {
  return value === "name" || value === "description" || value === "instructions";
}

function saveErrorCopy(code?: string): string {
  if (code === "RESOURCE_CONFLICT") return "技能已被更新，请重新加载后再编辑。";
  if (code === "SKILL_NOT_FOUND") return "未找到要编辑的技能。";
  if (code === "INVALID_INPUT") return "技能内容无效，请检查标记的字段。";
  return "无法保存技能，请稍后重试。";
}

export function SkillPanel() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [editingSkill, setEditingSkill] = useState<Skill | null>(null);
  const [editorActivated, setEditorActivated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const [focusedSkillId, setFocusedSkillId] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const loadErrorRef = useRef<HTMLDivElement>(null);
  const formErrorRef = useRef<HTMLDivElement>(null);
  const successHeadingRef = useRef<HTMLHeadingElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const narrow = useNarrowMode();

  useModalSurface(narrow && editorActivated, dialogRef, SKILL_EDITOR_INERT);

  const loadSkills = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await fetch("/api/skills");
      if (!response.ok) throw new Error("skills unavailable");
      const payload = (await response.json()) as { skills: Skill[] };
      setSkills(payload.skills);
    } catch {
      setLoadError("暂时无法加载技能，请稍后重试。");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    if (loadError) loadErrorRef.current?.focus();
  }, [loadError]);

  useEffect(() => {
    if (formError) formErrorRef.current?.focus();
  }, [formError]);

  useEffect(() => {
    if (focusedSkillId) successHeadingRef.current?.focus();
  }, [focusedSkillId]);

  function startCreate(event?: { currentTarget: EventTarget | null }) {
    openerRef.current =
      event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    setEditingSkill(null);
    setEditorActivated(true);
    setName("");
    setDescription("");
    setInstructions("");
    setFormError(null);
    setFieldErrors({});
    setSuccess(null);
    if (!narrow) queueMicrotask(() => nameRef.current?.focus());
  }

  function startEdit(skill: Skill, opener: HTMLElement) {
    openerRef.current = opener;
    setEditingSkill(skill);
    setEditorActivated(true);
    setName(skill.name);
    setDescription(skill.description);
    setInstructions(skill.instructions);
    setFormError(null);
    setFieldErrors({});
    setSuccess(null);
    if (!narrow) queueMicrotask(() => nameRef.current?.focus());
  }

  function closeEditor() {
    setEditorActivated(false);
    queueMicrotask(() => openerRef.current?.focus());
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors({});
    setSuccess(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(
        editingSkill ? `/api/skills/${editingSkill.id}` : "/api/skills",
        {
          body: JSON.stringify({
            description,
            ...(editingSkill ? { expectedVersion: editingSkill.version } : {}),
            instructions,
            name,
          }),
          headers: { "content-type": "application/json" },
          method: editingSkill ? "PATCH" : "POST",
        },
      );
      const payload = (await response.json()) as ErrorPayload & { skill?: Skill };
      if (!response.ok || !payload.skill) {
        const nextFieldErrors: Partial<Record<FieldName, string>> = {};
        for (const field of payload.error?.fields ?? []) {
          if (isFieldName(field.field)) {
            nextFieldErrors[field.field] =
              field.code === "too_long"
                ? `${fieldLabels[field.field]}超过长度限制。`
                : `${fieldLabels[field.field]}无效。`;
          }
        }
        setFieldErrors(nextFieldErrors);
        throw new Error(payload.error?.code ?? "SAVE_FAILED");
      }

      const saved = payload.skill;
      setSkills((current) => {
        const exists = current.some((skill) => skill.id === saved.id);
        return exists
          ? current.map((skill) => (skill.id === saved.id ? saved : skill))
          : [...current, saved].sort(
              (left, right) =>
                left.createdAt.localeCompare(right.createdAt) ||
                left.id.localeCompare(right.id),
            );
      });
      setFocusedSkillId(saved.id);
      setSuccess("技能已保存。");
      setEditingSkill(null);
      setEditorActivated(false);
      setName("");
      setDescription("");
      setInstructions("");
    } catch (error) {
      setFormError(saveErrorCopy(error instanceof Error ? error.message : undefined));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <main
        aria-labelledby="skill-resource-tab"
        className="cockpit-flow"
        id="skill-resource-panel"
        role="tabpanel"
      >
        <header className="stack">
          <p className="eyebrow">团队资源</p>
          <h2>技能</h2>
          <button onClick={startCreate} type="button">
            创建新技能
          </button>
        </header>
        {isLoading ? (
          <p aria-busy="true" className="muted">
            正在加载技能…
          </p>
        ) : loadError ? (
          <div
            className="stack error-text"
            ref={loadErrorRef}
            role="alert"
            tabIndex={-1}
          >
            <p>{loadError}</p>
            <button onClick={() => void loadSkills()} type="button">
              重试加载技能
            </button>
          </div>
        ) : skills.length === 0 ? (
          <p className="muted">暂无技能。</p>
        ) : (
          <ul className="timeline">
            {skills.map((skill) => (
              <li className="timeline-item" key={skill.id}>
                <article className="stack">
                  <h3
                    ref={skill.id === focusedSkillId ? successHeadingRef : undefined}
                    tabIndex={skill.id === focusedSkillId ? -1 : undefined}
                  >
                    {skill.name}
                  </h3>
                  {skill.description ? <p>{skill.description}</p> : null}
                  <div className="muted">
                    {skill.instructions.split("\n").map((line, index) => (
                      <p key={`${skill.id}-${index}`}>{line || "\u00a0"}</p>
                    ))}
                  </div>
                  <button
                    aria-label={`编辑 ${skill.name}`}
                    onClick={(event) => startEdit(skill, event.currentTarget)}
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

      {(!narrow || editorActivated) ? (
      <aside
        aria-labelledby="skill-editor-title"
        aria-modal={narrow ? true : undefined}
        className="cockpit-context"
        data-open={narrow && editorActivated ? "true" : undefined}
        onKeyDown={narrow ? (event) => trapModalFocus(event, closeEditor) : undefined}
        ref={dialogRef}
        role={narrow ? "dialog" : undefined}
      >
        <button
          aria-label="关闭技能编辑器"
          className="drawer-close"
          data-dialog-close="true"
          onClick={closeEditor}
          type="button"
        >
          关闭
        </button>
        <div className="stack">
          <p className="eyebrow">文本技能</p>
          <h2 id="skill-editor-title">{editingSkill ? "编辑技能" : "创建技能"}</h2>
        </div>
        <form className="stack" onSubmit={handleSubmit}>
          <div className="form-field">
            <label htmlFor="skill-name">技能名称</label>
            <input
              aria-describedby={fieldErrors.name ? "skill-name-error" : undefined}
              id="skill-name"
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：发布说明审校"
              ref={nameRef}
              required
              value={name}
            />
            {fieldErrors.name ? (
              <p className="error-text" id="skill-name-error">
                {fieldErrors.name}
              </p>
            ) : null}
          </div>
          <div className="form-field">
            <label htmlFor="skill-description">技能说明</label>
            <textarea
              aria-describedby={
                fieldErrors.description ? "skill-description-error" : undefined
              }
              id="skill-description"
              maxLength={280}
              onChange={(event) => setDescription(event.target.value)}
              value={description}
            />
            {fieldErrors.description ? (
              <p className="error-text" id="skill-description-error">
                {fieldErrors.description}
              </p>
            ) : null}
          </div>
          <div className="form-field">
            <label htmlFor="skill-instructions">指令正文</label>
            <textarea
              aria-describedby={
                fieldErrors.instructions ? "skill-instructions-error" : undefined
              }
              id="skill-instructions"
              maxLength={20_000}
              onChange={(event) => setInstructions(event.target.value)}
              required
              value={instructions}
            />
            {fieldErrors.instructions ? (
              <p className="error-text" id="skill-instructions-error">
                {fieldErrors.instructions}
              </p>
            ) : null}
          </div>
          <button disabled={isSubmitting} type="submit">
            {isSubmitting
              ? "正在保存技能…"
              : editorActivated
                ? "保存技能"
                : "创建技能"}
          </button>
          {formError ? (
            <div
              className="error-text"
              ref={formErrorRef}
              role="alert"
              tabIndex={-1}
            >
              {formError}
            </div>
          ) : null}
          {success ? <p role="status">{success}</p> : null}
        </form>
      </aside>
      ) : null}
    </>
  );
}

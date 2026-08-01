"use client";

type SourceType = "task" | "result" | "review" | "validation" | "artifact"
  | "memory" | "execution";

export type ReviewPublicContent = {
  chunks: Array<{ bytes: number; offset: number; sha256: string; text: string }>;
  includedBytes: number;
  mediaType: "text/plain" | "text/x-diff" | "application/json";
  originalBytes: number | null;
  reasonCode: null | "SOURCE_MISSING" | "SOURCE_UNREADABLE"
    | "SOURCE_REDACTED" | "MATERIAL_BUDGET_EXHAUSTED";
  sha256: string | null;
  source: { id: string; type: SourceType; version: string };
  status: "complete" | "truncated" | "missing" | "unreadable";
};

export type ReviewMaterialView = {
  artifacts?: Array<{
    content: ReviewPublicContent;
    id: string;
    name?: string;
    required?: boolean;
  }>;
  auditEvents?: Array<{
    payload: ReviewPublicContent;
    type?: string;
  }>;
  changes?: {
    observations?: Array<{
      path?: string;
      publicDiff: ReviewPublicContent;
      required?: boolean;
    }>;
  };
  validations?: Array<{
    id?: string;
    required: boolean;
    stderr: ReviewPublicContent;
    stdout: ReviewPublicContent;
    succeeded: boolean;
  }>;
};

type MaterialEntry = {
  content: ReviewPublicContent;
  key: string;
  label: string;
  required: boolean;
};

const statusCopy: Record<ReviewPublicContent["status"], string> = {
  complete: "正文完整",
  missing: "正文缺失",
  truncated: "正文已截断",
  unreadable: "正文不可读取",
};

const reasonCopy: Record<Exclude<ReviewPublicContent["reasonCode"], null>, string> = {
  MATERIAL_BUDGET_EXHAUSTED: "公开材料预算已用尽",
  SOURCE_MISSING: "来源不存在",
  SOURCE_REDACTED: "来源包含不可公开内容",
  SOURCE_UNREADABLE: "来源不可读取",
};

function body(content: ReviewPublicContent): string {
  return content.chunks.map(({ text }) => text).join("");
}

function entryIsIncomplete(entry: MaterialEntry): boolean {
  if (!entry.required) return false;
  return entry.content.status !== "complete"
    || (entry.content.originalBytes !== 0 && body(entry.content).length === 0);
}

function entries(material: ReviewMaterialView): MaterialEntry[] {
  return [
    ...(material.changes?.observations ?? []).map((observation, index) => ({
      content: observation.publicDiff,
      key: `diff-${observation.publicDiff.source.id}-${index}`,
      label: `变更 ${observation.path ?? index + 1}`,
      required: observation.required
        ?? (observation.publicDiff.originalBytes ?? 0) > 0,
    })),
    ...(material.validations ?? []).flatMap((validation, index) => [{
      content: validation.stdout,
      key: `validation-stdout-${validation.stdout.source.id}-${index}`,
      label: `验证 ${validation.id ?? index + 1} · stdout`,
      required: validation.required,
    }, {
      content: validation.stderr,
      key: `validation-stderr-${validation.stderr.source.id}-${index}`,
      label: `验证 ${validation.id ?? index + 1} · stderr`,
      required: false,
    }]),
    ...(material.artifacts ?? []).map((artifact, index) => ({
      content: artifact.content,
      key: `artifact-${artifact.id}-${index}`,
      label: `产物 ${artifact.name ?? artifact.id}`,
      required: artifact.required ?? false,
    })),
    ...(material.auditEvents ?? []).map((event, index) => ({
      content: event.payload,
      key: `event-${event.payload.source.id}-${index}`,
      label: `事件 ${event.type ?? index + 1}`,
      required: false,
    })),
  ];
}

function MaterialBody({ entry }: { entry: MaterialEntry }) {
  const { content } = entry;
  const text = body(content);
  const source = content.source;
  return (
    <article aria-labelledby={`${entry.key}-title`} className="stack">
      <div className="panel-heading">
        <h5 id={`${entry.key}-title`}>{entry.label}</h5>
        <span className="status-label">{statusCopy[content.status]}</span>
      </div>
      <p>
        source · {source.type} · {source.id} · v{source.version}
        {entry.required ? " · required" : " · optional"}
      </p>
      {text.length > 0 ? (
        <pre><code>{text.split("\n").map((line, index, lines) => (
          <span key={`${entry.key}-line-${index}`}>
            {line}{index < lines.length - 1 ? "\n" : ""}
          </span>
        ))}</code></pre>
      ) : (
        <p>{content.reasonCode ? reasonCopy[content.reasonCode] : "正文为空"}</p>
      )}
      <p>
        status · {content.status}
        {content.sha256 ? ` · sha256 ${content.sha256.slice(0, 12)}` : ""}
      </p>
    </article>
  );
}

export function ReviewMaterialPanel({ material }: { material: ReviewMaterialView }) {
  const materialEntries = entries(material);
  const incomplete = materialEntries.filter(entryIsIncomplete);
  const reasonId = "review-material-pass-reason";

  return (
    <section aria-labelledby="review-material-title" className="stack">
      <div className="panel-heading">
        <h4 id="review-material-title">冻结公开材料</h4>
        <span className="status-label">
          {incomplete.length === 0 ? "可形成通过裁决" : "必需正文不完整"}
        </span>
      </div>
      {materialEntries.length === 0 ? <p>没有可显示的公开材料正文。</p> : (
        materialEntries.map((entry) => <MaterialBody entry={entry} key={entry.key} />)
      )}
      <p id={reasonId}>
        {incomplete.length === 0
          ? "所有必需公开材料正文完整。"
          : "REVIEW_CONTENT_INCOMPLETE：必需材料仅有 hash/header 或正文不完整，不能通过。"}
      </p>
      <button
        aria-describedby={reasonId}
        disabled={incomplete.length > 0}
        style={{ minHeight: "var(--control-min)" }}
        type="button"
      >
        通过复核
      </button>
    </section>
  );
}

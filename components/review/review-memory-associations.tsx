"use client";

export type ReviewMemoryAssociation = {
  candidateId: string;
  decisionId: string;
  memoryId: string;
  memoryVersion: number;
  outcome: "created" | "reused" | "superseded";
};

export type ReviewMemoryAssociationsProps = {
  associations: ReviewMemoryAssociation[];
  projectId?: string;
};

const OUTCOME_COPY: Record<ReviewMemoryAssociation["outcome"], string> = {
  created: "已创建",
  reused: "精确去重，复用既有记忆",
  superseded: "已创建后继版本",
};

export function ReviewMemoryAssociations({
  associations,
  projectId,
}: ReviewMemoryAssociationsProps) {
  if (associations.length === 0) {
    return <p>本次通过裁决没有 memory candidate。</p>;
  }
  return (
    <section aria-labelledby={`review-memory-${projectId ?? "attempt"}`} className="stack">
      <h5 id={`review-memory-${projectId ?? "attempt"}`}>Memory 沉淀结果</h5>
      <ul className="stack">
        {associations.map((association) => (
          <li className="task-summary" key={association.candidateId}>
            <a
              href={`${projectId
                ? `/projects/${encodeURIComponent(projectId)}`
                : ""}/memories/${encodeURIComponent(association.memoryId)}?version=${
                association.memoryVersion
              }`}
            >
              {OUTCOME_COPY[association.outcome]} · {association.memoryId}
              {" · v"}{association.memoryVersion}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

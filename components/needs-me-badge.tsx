"use client";

import { BellRinging } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { z } from "zod";

import { approvalCenterItemDtoSchema } from "@/src/shared/approval-center-contracts";

const pageSchema = z
  .object({
    approvals: z.array(approvalCenterItemDtoSchema),
  })
  .strict();

export function pendingNeedsMeCount(payload: unknown): number {
  const parsed = pageSchema.safeParse(payload);
  if (!parsed.success) return 0;
  return parsed.data.approvals.filter(
    (item) => item.status === "pending" && item.decisionHint === null,
  ).length;
}

export function usePendingApprovalCount(projectId: string | null): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!projectId) {
      setCount((current) => (current === 0 ? current : 0));
      return;
    }

    const id = projectId;
    const controller = new AbortController();
    let epoch = true;

    async function load() {
      try {
        const response = await fetch(
          `/api/projects/${encodeURIComponent(id)}/approvals/pending`,
          { signal: controller.signal },
        );
        if (!epoch || !response.ok) return;
        const payload: unknown = await response.json();
        if (!epoch) return;
        setCount(pendingNeedsMeCount(payload));
      } catch {
        if (epoch) setCount(0);
      }
    }

    void load();
    return () => {
      epoch = false;
      controller.abort();
    };
  }, [projectId]);

  return count;
}

export function NeedsMeBadge({
  count,
  onOpen,
}: {
  count: number;
  onOpen: () => void;
}) {
  if (count < 1) return null;
  return (
    <button
      aria-label={`Needs Me，${count} 项待处理`}
      className="needs-me-badge"
      onClick={onOpen}
      type="button"
    >
      <BellRinging aria-hidden="true" size={16} weight="bold" />
      <span>Needs Me ({count})</span>
    </button>
  );
}

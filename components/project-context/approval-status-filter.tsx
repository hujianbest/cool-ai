"use client";

import type { ApprovalCenterItemStatus } from "@/src/shared/approval-center-contracts";

/**
 * UCD §9.2.5 顶栏状态筛选：`状态: [全部 (N) ▼]` 位于治理视图顶栏（返回对话 + 标题
 * 同一行），选项顺序待裁决在前；计数为面板上报的当前列表实况。
 */
export const APPROVAL_STATUS_FILTER_ORDER: ApprovalCenterItemStatus[] = [
  "pending",
  "expired",
  "replaced",
  "revoked",
];

export const APPROVAL_STATUS_COPY: Record<ApprovalCenterItemStatus, string> = {
  expired: "已过期",
  pending: "待裁决",
  replaced: "已被取代",
  revoked: "已撤销",
};

export type ApprovalStatusFilterValue = ApprovalCenterItemStatus | "all";

export type ApprovalStatusSummary = {
  counts: Partial<Record<ApprovalCenterItemStatus, number>>;
  total: number;
};

export const EMPTY_APPROVAL_STATUS_SUMMARY: ApprovalStatusSummary = {
  counts: {},
  total: 0,
};

export function ApprovalStatusFilterSelect({
  id,
  onChange,
  summary,
  value,
}: {
  id: string;
  onChange: (value: ApprovalStatusFilterValue) => void;
  summary: ApprovalStatusSummary;
  value: ApprovalStatusFilterValue;
}) {
  return (
    <div className="form-field approval-status-filter">
      <label htmlFor={id}>状态</label>
      <select
        id={id}
        onChange={(event) =>
          onChange(event.target.value as ApprovalStatusFilterValue)
        }
        value={value}
      >
        <option value="all">{`全部 (${summary.total})`}</option>
        {APPROVAL_STATUS_FILTER_ORDER.map((status) => (
          <option key={status} value={status}>
            {`${APPROVAL_STATUS_COPY[status]} (${summary.counts[status] ?? 0})`}
          </option>
        ))}
      </select>
    </div>
  );
}

---
type: ui
title: Execution UI
description: Execution run panel, execution review, manual recovery surface, and shared validation-policy panel.
tags: [ui, execution]
---

# Execution UI

Consumes the [Execution API](/openwiki/http-api/execution.md) family for running the two-lane
sandboxed executor.

## Components
- `execution-panel.tsx` — the execution run surface: status, staged results, validations, approvals.
- `execution-review.tsx` — post-merge review of execution output.
- `manual-recovery-surface.tsx` — resolves `manual_recovery_required` conflicts via
  `.../recovery/resolve`.
- `validation-policy-panel.tsx` — validation policy revision management (shared with project-context).

## Behavioral notes
At most two active executions per project and one per agent; approvals are presented for exact
commands and staged merges; validation results stream via `validations/.../chunks`.

Tests: `tests/modules/safe-execution/*` + browser `execution-browser-smoke.mjs`.

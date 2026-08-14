---
type: ui
title: Project Context UI
description: Panels for project landing/home, setup, workspace binding and browsing, membership, mission board, policy, approval center, audit, memory, and context preview.
tags: [ui, project]
---

# Project Context UI

The project landing and mission-board surface; primary consumer of the
[Project and Workspace API](/openwiki/http-api/project-workspace.md) and
[Mission API](/openwiki/http-api/mission.md).

## Panels (`components/project-context/`)
- `project-panel.tsx` — the home/landing shell (also renders the shared `ActivityBar` and the
  legacy `task-panel.tsx`, the task-executor panel).
- `project-setup-panel.tsx`, `workspace-setup.tsx`, `members-setup.tsx` — create/bind/join surface
  (project → workspace → members).
- `workspace-file-tree.tsx`, `workspace-file-preview.tsx` — read-only workspace browser.
- `mission-board.tsx`, `mission-dependency-insight.tsx` — task DAG board + dependency insight.
- `validation-policy-panel.tsx` (shared with execution), `approval-center-panel.tsx`,
  `audit-panel.tsx`, `memory-panel.tsx`, `context-preview.tsx`.

## Key relationships
Mission board status writes are the unique `mission-work` surface. Approvals list
(`approval-center-panel`) reads the Governance [unified approval center](/openwiki/modules/governance.md).
Audit panel reads the [Operations Projection](/openwiki/modules/operations-projection.md) projection.

Tests: `tests/modules/project-workspace/*`, `tests/modules/mission-work/mission-crud.test.ts`,
`tests/browser/context-browser-smoke.mjs`.

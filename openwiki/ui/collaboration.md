---
type: ui
title: Collaboration and Threads UI
description: Project-thread navigation shell, collaboration panel, structured message rendering, input history, attachments, and thread policy UI.
tags: [ui, collaboration]
---

# Collaboration and Threads UI

The largest UI family, driving the project resource route
`app/projects/[projectId]/[[...resource]]/page.tsx`.

## Components
- `project-thread-navigation.tsx` — the shell that maps the `[[...resource]]` path to thread/run
  sections (ThreadDetail, ThreadQueue, messages, decisions).
- `collaboration-panel.tsx` (≈140 KB) — project chat/run panel: owner messages, agent turns,
  decisions, handoffs, timeline.
- `structured-message-block.tsx` — renders `PublicStructuredBlockEnvelope` blocks + state revisions
  and inline decisions.
- `input-history-panel.tsx` — stored owner input history.
- `thread-policy-panel.tsx` — per-thread membership/review policy revisions.
- `attachment-upload.ts`, `use-target-request-guard.ts` — attachment upload and target-guard hooks.

## Data flow
Reads via [Collaboration API](/openwiki/http-api/collaboration.md); structured blocks persist to
`structured_message_blocks` + `structured_message_state_*`; inline decisions are posted via
`decideInline`.

Tests: the entire `tests/modules/public-collaboration/` suite plus
`tests/browser/collaboration-browser-smoke.mjs` and `tests/browser/persistent-threads-browser-smoke.mjs`.

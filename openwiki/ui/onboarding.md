---
type: ui
title: Onboarding Guide UI
description: The progressive onboarding guide component and its routing machine in src/shared/onboarding-guide-machine.
tags: [ui, onboarding]
---

# Onboarding Guide UI

## Component
`onboarding-guide.tsx` renders the progressive six-step guide
(`provider → agent → project-select → workspace → members → goal`) shown on `/team` and project pages.

## Machine (`src/shared/onboarding-guide-machine.ts`)
- `GUIDE_STEPS` — the ordered step names.
- `parseGuideUrl(href)` — parses a `/team?...` or project URL into a `{kind:"guide",route}` result,
  or an `error`/`none` result (`GuideUrlResult`). Used by `app/team/page.tsx` to drive the current guide step.
- Envelope types `ProjectGuideEnvelope`, `WorkspaceGuideEnvelope`, etc. model incremental readiness.

Note: `parseReturnTo`/`parseSettingsSection` used for settings deep-linking live in
`components/settings-navigation.ts` (see [Client State Stores and Routing](stores.md)).

Tests: `tests/shared/onboarding-guide-machine.test.ts`, `tests/workflows/onboarding/...`
(coverage of governance linkage), browser `tests/browser/onboarding-browser-smoke.mjs`.

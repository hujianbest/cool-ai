---
type: ui
title: Team and Settings UI
description: Panels composing the /team page — provider, skill, and agent configuration plus settings navigation and theme prefs.
tags: [ui, team]
---

# Team and Settings UI

Backs the `/team` route (`app/team/page.tsx`), which parses `returnTo`/`section`/guide query params
and renders `TeamPanel`.

## Panels
- `team-panel.tsx` — top level, hosts the settings tabs and the shared `ActivityBar` shell chrome.
- `provider-panel.tsx` — Provider configuration (create/verify/update/delete), including the
  credential-vault save flow and `POST /api/providers/verify`.
- `skill-panel.tsx` — reusable text skills CRUD.
- `agent-panel.tsx` — Agents with roles, models, permissions (read/write/execute), budgets, skills.

## Settings & theme
- `settings-navigation.ts` — `parseReturnTo` / `parseSettingsSection` for deep links.
- `settings-preferences-store.ts`, `theme-preference-store.ts` — persisted prefs.
- `onboarding-guide.tsx` — inline guide (see [Onboarding Guide UI](onboarding.md)).

Hooks into [Identity and Team API](/openwiki/http-api/identity.md). Tests:
`tests/modules/identity-capability/*.api.test.ts`; browser smoke `team-browser-smoke.mjs`
and `settings-navigation-browser-smoke.mjs`.

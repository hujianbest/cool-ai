---
type: ui
title: Web UI (React Cockpit)
description: The browser cockpit panels grouped by domain (team/settings, project-context, collaboration, execution, review, onboarding) plus shared client state stores and app-route shells.
tags: [ui]
---

# Web UI (React Cockpit)

The browser cockpit is a React 19 single-page surface rendered under three App Router shells:
`app/page.tsx` (`ProjectPanel`), `app/team/page.tsx` (`TeamPanel`), and
`app/projects/[projectId]/[[...resource]]/page.tsx` (project-scoped resource routing driven by
`ProjectThreadNavigation`). Both the project and team shells render the shared `ActivityBar`
(`components/activity-bar.tsx`), the cockpit navigation/theme chrome. Panels never access SQLite,
Provider credentials, or host files directly — they call the [HTTP API families](/openwiki/http-api/index.md).

- [Team and Settings UI](team-settings.md) — provider/skill/agent panels and theme/settings prefs.
- [Project Context UI](project-context.md) — setup, workspace, members, mission board, policy, audit, memory.
- [Collaboration and Threads UI](collaboration.md) — thread detail, collaboration panel, structured messages.
- [Execution UI](execution.md) — execution run, review, recovery, validation policy.
- [Review and Delivery UI](review-delivery.md) — review product/attempt surfaces and delivery.
- [Onboarding Guide UI](onboarding.md) — progressive guide + machine.
- [Client State Stores and Routing](stores.md) — shared stores + navigation utilities.

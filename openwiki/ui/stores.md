---
type: ui
title: Client State Stores and Routing
description: Shared input-history record store, persistent preference stores, settings navigation, and mobile dialog utilities.
tags: [ui, state]
---

# Client State Stores and Routing

## Stores
- `input-history-recording-store.ts` — owner input-history recording (search/clear).
- `onboarding-preference-store.ts` — persisted onboarding progress.
- `settings-preferences-store.ts` — settings tab preference.
- `theme-preference-store.ts` — light/dark theme preference.

## Utilities
- `settings-navigation.ts` — `parseReturnTo` / `parseSettingsSection`. (Note: `parseGuideUrl`
  lives in `src/shared/onboarding-guide-machine.ts`, not here.)
- `mobile-dialog.ts` — mobile responsive dialog.

Tests: `tests/adapters/inbound/` — `input-history-recording-store.test.ts`,
`onboarding-preference-store.test.ts`, `theme-preference-store.test.ts`.

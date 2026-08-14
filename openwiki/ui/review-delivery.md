---
type: ui
title: Review and Delivery UI
description: Review access/product/attempt/material/slice/workspace/outcomes surfaces plus the delivery panel.
tags: [ui, review]
---

# Review and Delivery UI

Consumes the [Review and Delivery API](/openwiki/http-api/review-delivery.md).

## Panels (`components/review/`)
- `review-access-surface.tsx` / `review-product-surface.tsx` — eligibility and entry to review.
- `review-attempt-panel.tsx`, `review-material-panel.tsx`, `review-workspace.tsx`,
  `review-slice.tsx` — the reviewer's frozen material, workspace, and per-slice views.
- `review-outcomes-panel.tsx`, `review-memory-associations.tsx` — verdicts and committed memory.
- `delivery-panel.tsx` — final delivery summary + manifest.

## Vending
The reviewer is an eligible, non-executing, `review_capable` agent. The platform freezes public
material and calls that agent's Provider; it cannot invent a verdict (see
[Review and Delivery](/openwiki/modules/review-delivery.md) and shared `reviewOutputSchema`).

Tests: `tests/modules/review-delivery/*` + browser `review-browser-smoke.mjs`.

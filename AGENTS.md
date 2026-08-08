# AGENTS.md

This file defines repository-wide instructions for coding agents working in Cool AI.
It applies recursively from the repository root. A nearer `AGENTS.md` may add or
override instructions for its subtree.

## Project

Cool AI is a local-first, single-owner multi-Agent collaboration cockpit.

- Stack: Next.js 16 App Router, React 19, strict TypeScript, SQLite (`node:sqlite`).
- UI: desktop-first responsive cockpit with light/dark design tokens.
- Tests: Vitest, Testing Library, Playwright, and axe.
- Runtime: Node.js 24.x and npm 11.x.
- Security model: trusted local machine, no authentication, fail-closed APIs and
  guarded Windows workspace execution.

Key locations:

- `app/`: pages, layouts, route handlers, and global styles.
- `components/`: React product surfaces.
- `src/server/`: domain services, persistence, migrations, Providers, execution,
  review, and delivery.
- `src/shared/`: strict cross-boundary contracts.
- `tests/`: unit, integration, component, fixture, and browser smoke tests.
- `product/`: product definition, backlog, assumptions, and decisions.
- `features/`: feature specifications, architecture, tickets, reviews, and progress.
- `.agents/skills/`: current HarnessFlow and domain skills.

## Start Every Development Task

1. Read `.agents/skills/hf-workflow/SKILL.md`; skills on disk are authoritative.
2. Run:

   ```powershell
   python ".agents/skills/hf-workflow/scripts/hf_gate.py" status
   ```

3. Read only the current feature's `progress.md`, `spec.md`, `architecture.md`,
   `tickets.md`, relevant reviews, and `CONTEXT.md` when present.
4. Enter a stage only after its feature-specific gate passes.
5. Load only the current stage skill and matching `ext-*` skills.

Do not infer workflow state from chat history. Do not restart historical features
merely because old artifacts predate the current HarnessFlow format; reconcile the
active feature deliberately.

## Delivery Workflow

Use the current chain:

`grill-with-docs → to-spec → to-architecture → to-tickets → implement → ship`

- Work on one unblocked frontier ticket at a time.
- Product implementation and ticket work must be delegated to a subagent.
- Reviews must use a different subagent or a fresh session.
- Auto mode may advance after independent approval and a passing gate.
- User-visible work requires a real browser demo and persisted acceptance before ship.
- Record defaults in `product/assumptions.md`; never silently invent scope.

## Speed Without Lowering Quality

- Read `CONTEXT.md` or the feature architecture before searching broadly.
- Search narrowly by module, contract, or symbol; avoid repeated repository scans.
- Batch independent read-only tool calls.
- Do not start a duplicate dev server; reuse a healthy existing process.
- Keep tickets vertical, independently verifiable, and small enough for one context
  window. Split work that spans unrelated domains or more than one coherent seam.
- For wide migrations use explicit expand-contract batches, not dozens of accidental
  downstream fixes.
- Establish shared fixture builders at the start of schema or API migrations. Tests
  must not duplicate large direct-SQL graphs across files.
- Update all callers and fixtures for a contract in one planned migration wave.
- Run targeted tests during RED/GREEN. Run typechecking/build at meaningful
  milestones and the full suite once at final integration, not after every tiny edit.
- Preserve a concrete failure inventory during large regression repairs.
- Avoid opportunistic refactors, formatting churn, and generated-file noise.

### Subagent Continuity

- Adjacent frontier tickets in the same module and pre-agreed test seam should
  normally resume the previous implementation subagent.
- Reuse one implementation subagent for a short coherent batch, typically 2–5
  related tickets, while keeping each ticket's RED/GREEN and checkbox independent.
- Start a fresh implementation subagent when crossing domains, changing architecture,
  context becomes saturated, or the previous agent formed a wrong assumption.
- Never reuse an implementation author as an independent reviewer.
- When handing off, provide paths to source-of-truth artifacts instead of pasting
  their full contents.

## TDD and Testing

- Follow `.agents/skills/hf-tdd/SKILL.md`.
- Test behavior through approved public seams; do not test private implementation.
- One cycle is one failing behavior test followed by the minimum passing change.
- A valid RED fails because behavior is missing, not because code does not compile.
- Do not weaken assertions, skip tests, or mock the subject under test.
- Keep refactoring out of the RED/GREEN loop; perform it under review discipline.
- Prefer shared deterministic fixtures over ad hoc database inserts.

Common commands:

```powershell
npm test
npm run build
npm run smoke
npm run smoke:team
npm run smoke:context
npm run smoke:collaboration
npm run smoke:execution
npm run smoke:review
npm run smoke:settings
npm run smoke:onboarding
npm run smoke:threads
```

Use focused Vitest files while implementing:

```powershell
npm test -- tests/<target>.test.ts
```

## Code and Contract Standards

- TypeScript is strict. Do not use unsafe casts or non-null assertions to bypass
  domain validation.
- Route handlers validate path, query, content type, body size, and strict DTO shape
  before invoking services.
- Public errors use stable sanitized envelopes. Never return raw exceptions, Provider
  responses, prompts, credentials, host paths, or hidden reasoning.
- Persistent writes use existing operation/version/lease semantics and transactions.
  Retries must replay facts or fail clearly; never duplicate business actions.
- Project/thread/run and other ownership tuples must be validated together, preferably
  with composite database constraints and tuple-scoped queries.
- Migrations are atomic, idempotent on reopen, exact-schema validated, and fail closed
  on drift or invalid legacy data.
- Preserve immutable history, source identity, and frozen provenance. Never substitute
  a “latest” entity for an explicitly selected or frozen source.
- Browser code must not access SQLite, Provider credentials, or host files directly.

## UI Standards

- Reuse `app/tokens.css` and existing cockpit primitives; no hardcoded colors,
  spacing, radii, typography, shadows, or breakpoints.
- Every key interaction covers loading, empty, error, disabled, success, and focus
  behavior as applicable.
- Use semantic HTML, visible focus, keyboard operation, accessible names, and
  controls at least 44×44px.
- Maintain WCAG AA text contrast and verify affected surfaces with axe.
- Support desktop and the existing narrow-screen drawer model.
- Avoid unrequested gradients, glow, glass effects, decorative animation, emoji
  icons, generic AI callouts, and copied brand assets or copy.
- Protect project/thread/run switches from stale reads, polls, writes, and focus
  updates using canonical target identity plus abort/epoch checks.

## Security and Local Data

- Never commit `.env` files, keys, credentials, private workspace content, `.data/`,
  sandbox contents, or unredacted browser evidence.
- `COCKPIT_MASTER_KEY` must remain outside the repository.
- Do not expose the dev server or APIs to untrusted networks.
- Workspace/file/process behavior must preserve verified-handle, sandbox, approval,
  limits, validation, and conflict boundaries.
- Do not claim arbitrary local executables are safely sandboxed.

## Git and Generated Files

- Do not reset, checkout, overwrite, or delete unrelated user changes.
- Commit or push only when the user or active delivery flow explicitly requests it.
- One shipped product slice should have one focused commit and push.
- Before committing, inspect status, complete diff, untracked files, and recent commit
  style. Exclude secrets and generated noise.
- Do not commit `.next/`, `node_modules/`, caches, `__pycache__/`, temporary databases,
  or generated `next-env.d.ts` churn.
- Browser evidence must be generated by the test/smoke runner, never hand-authored.

## Definition of Done

A feature is done only when:

- all tickets are checked;
- focused and full tests pass;
- production build and required browser smokes pass;
- affected UI has real-render and accessibility verification;
- independent Standards and Spec reviews pass;
- demo acceptance is recorded for user-visible work;
- the ship gate passes;
- product/context/assumption records are updated;
- the working tree contains no accidental artifacts;
- requested commit and push have succeeded.

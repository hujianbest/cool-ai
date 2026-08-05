# Verification Protocol Reference

The init workflow uses three subagents to enforce quality. This reference
documents their invocation patterns, input/output contracts, and batching rules.

All subagents are defined in `.claude/agents/` and invoked with `@<name>` in
Claude Code. Their full system prompts live in those files; this reference
covers **how to orchestrate** them.

## Subagent Overview

| Subagent | Mode | Read scope | Write | Purpose |
|----------|------|------------|-------|---------|
| `skeleton-critic` | init only | source + tests + `openwiki/_skeleton.md` | NO | Reviews skeleton before drafting |
| `wiki-question-finder` | init only | source + tests (never `openwiki/`) | NO | Generates source-grounded QA questions |
| `wiki-answer-verifier` | init only | `openwiki/` only (never source) | NO | Verifies wiki answers the questions |

All three are **read-only**. They never modify files.

---

## Skeleton Critic

### When to invoke

Init mode, **after** the skeleton (`openwiki/_skeleton.md`) is complete but
**before** writing wiki prose.

### How to invoke

```
@skeleton-critic Review the wiki skeleton at openwiki/_skeleton.md against the
repository. <If repeat:> Prior requests: <list>. Changes made: <list>.
```

### Invocation limit

- **Initial review:** 1 invocation. Must return all material gaps in one response.
- **Repeat review:** exactly 1 more, with the prior-request ledger and resolutions.
- **Do not invoke a third time.** If items remain unresolved, address them directly
  in the skeleton yourself.

### What it returns

```xml
<review status="PASS | CHANGES_REQUESTED">
  <prior_requests>
    <item id="RQ-01" status="VERIFIED | UNRESOLVED">
      <evidence>...</evidence>
    </item>
  </prior_requests>
  <new_requests>
    <item id="RQ-02">
      <gap>...</gap>
      <evidence>...</evidence>
      <required_change>...</required_change>
    </item>
  </new_requests>
</review>
```

### How to handle the response

1. Create one TODO per RQ item.
2. Resolve each by editing `openwiki/_skeleton.md`.
3. Re-invoke once with the ledger. Verify VERIFIED items yourself — don't trust
   that they were addressed just because the main agent said so.
4. Mark `PASS` only when `new_requests` is empty and all prior items are VERIFIED.

### What it looks for

Areas shallow discovery misses: registration/export chains, upstream/downstream
consumers, data lifecycle/migrations, auth boundaries, config precedence,
retries/partial failure, concurrency/cleanup, background jobs, generated
artifacts, operational workflows, test-only evidence of important behavior.

---

## Wiki Question Finder

### When to invoke

Init mode, **after** all wiki pages are written (Step 7 of init workflow).

### How to invoke

```
@wiki-question-finder Inspect the repository source and tests (NOT openwiki/).
Generate 8-10 source-grounded questions that a future agent should be able to
answer using only the wiki. Each question needs an ID (Q-NN), 3-5 acceptance
criteria, and source evidence (path:symbol).
```

### What it returns

```
[Q-01]: <question>
Acceptance criteria:
- <criterion>
Source evidence:
- <path>:<symbol> — <motivation>
```

### Question quality

- Must require more than a README/directory listing to answer.
- Must exercise understanding across meaningful boundaries.
- Must be answerable from inspected source evidence.
- At most 10 questions; target 8 for large repos, fewer for small.
- Consolidate questions that exercise the same workflow or wiki pages.

### How to handle the response

1. Create one TODO per question ID (Q-01 through Q-NN).
2. Plan batches before verifying (next section).

---

## Wiki Answer Verifier

### When to invoke

Init mode, **after** wiki-question-finder returns questions. Used in waves:
initial verification, then retries for PARTIAL/FAIL.

### Batching rules (CRITICAL)

1. Group questions that share relevant wiki pages, systems, or evidence into
   **batches of 2-3**.
2. A question may run alone only when no other question in the wave has
   meaningful overlap. Do NOT use one verifier per question by default.
3. Launch all batches for a wave together in one parallel tool-call message.
4. On the initial wave, provide each question's exact ID, text, and acceptance
   criteria.

### How to invoke (per batch)

```
@wiki-answer-verifier Verify this batch of questions using ONLY openwiki/ pages
(NOT source files):
[Q-01]: <question text>
Acceptance criteria: <criteria>
[Q-03]: <question text>
Acceptance criteria: <criteria>
```

### What it returns

```xml
<results>
  <result id="Q-01" status="PASS | PARTIAL | FAIL">
    <missing>None | concise missing facts and relevant wiki pages</missing>
  </result>
</results>
```

### Status rules

- **PASS** — every criterion is answered accurately and specifically by `openwiki/`.
- **PARTIAL** — at least one criterion answered, but material details missing.
- **FAIL** — the wiki cannot provide a useful answer.
- A documented evidence limit may satisfy a criterion when the wiki explicitly
  establishes that the source provides no guarantee/behavior/test.

### Retry protocol

1. For every PARTIAL or FAIL, update the canonical wiki pages with the missing
   details.
2. **Complete all documentation repairs for the wave** before retrying. Do not
   launch verifier calls incrementally as individual questions are repaired.
3. Re-invoke wiki-answer-verifier **only** for PARTIAL/FAIL IDs. Provide only:
   the unchanged question ID + text, its prior missing-items list, and the wiki
   pages changed to resolve it. Do NOT resend acceptance criteria or source evidence.
4. Mark a question's TODO complete only after PASS. Repeat only for IDs that
   still don't pass.

---

## Orchestration Summary

```
INIT FLOW:
  1. Inventory + skeleton → openwiki/_skeleton.md
  2. @skeleton-critic (initial) → resolve all RQ items
  3. @skeleton-critic (repeat, once) → resolve remaining items directly
  4. Write all wiki pages
  5. @wiki-question-finder → Q-01..Q-NN
  6. Batch Q-items → @wiki-answer-verifier (parallel) → repair PARTIAL/FAIL
  7. @wiki-answer-verifier (retry, unresolved only) → until all PASS
  8. Write quickstart.md → cleanup → .last-update.json
```

The subagents are tools for catching gaps, not gatekeepers to wait on. Use them
to find what you missed, then fix it directly.

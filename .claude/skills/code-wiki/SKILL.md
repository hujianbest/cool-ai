---
name: code-wiki
description: >-
  Generate and maintain a source-grounded code wiki under openwiki/. Use when the
  user asks to "generate wiki", "document the codebase", "init/update openwiki",
  or create a navigable architecture knowledge base for humans and agents.
version: 1.0.0
---

# Code Wiki Generator

Generate and maintain a source-grounded code wiki under `openwiki/` in the
repository root. The wiki lets humans and coding agents understand and safely
change the codebase by reading markdown instead of reverse-engineering source.

This skill reproduces OpenWiki's code-mode capability natively in Claude Code —
no external CLI, no provider/model compatibility issues.

## When to Use

- User says: "generate/initialize/build the wiki", "document the codebase",
  "create openwiki docs", "init openwiki", or similar.
- User says: "update the wiki", "refresh the docs", "what changed since last
  doc update" → run **Update** mode.
- User asks a question and you should answer "based on the wiki" → run **Chat**
  mode (read `openwiki/` first, source only as fallback).
- User asks to add/improve a specific wiki page → targeted edit under `openwiki/`.

**Don't use for:** one-off code questions (answer directly), generating API
reference from JSDoc (use a doc generator), or writing user-facing product docs
(this is an engineering knowledge base).

## Output Location

ALL generated content lives under `openwiki/` in the repository root. Never
write wiki files anywhere else. Never modify source code during wiki runs.

- Entrypoint: `openwiki/quickstart.md`
- Sections: `openwiki/<section>/<page>.md` (e.g. `openwiki/architecture/overview.md`)
- Metadata: `openwiki/.last-update.json` (tracks the last-documented git commit)
- Brief (user-authored, read-only during runs): `openwiki/INSTRUCTIONS.md`

## Three Modes

### 1. Init (`--init` equivalent)

Build the wiki from scratch. Follow the **Init Workflow** below exactly.

### 2. Update (`--update` equivalent)

Refresh an existing wiki against source changes. Follow the **Update Workflow**.

### 3. Chat

Answer questions using the existing `openwiki/` as the primary source. Only
fall back to source files when the wiki cannot answer.

---

## Init Workflow

Follow these steps **in order**. Do not skip or reorder.

### Step 1 — Build the inventory map

Before writing any prose, deeply research the repository. Inspect:

- Package/manifest files (`package.json`, `pyproject.toml`, `Cargo.toml`, etc.)
- Runtime/build entrypoints (servers, CLIs, main modules)
- Public surfaces (exports, API routes, plugin registration)
- Major domains and cross-system workflows
- Data/schema ownership (models, migrations, DB schemas)
- Existing docs (README, `docs/`, runbooks)
- Representative focused tests
- `openwiki/INSTRUCTIONS.md` if present (user scope brief)

**Technique:** Use `Glob` and `Grep` for targeted discovery, not broad scans.
Read complete functions and adjacent tests — filenames alone are discovery
evidence, not implementation evidence. Follow calls/data across at least one
boundary in each direction.

### Step 2 — Rank components

Rank by: runtime importance, dependency centrality, change activity (git log),
public surface, test ownership. Ranking controls exploration order, not whether
a substantial component is covered.

### Step 3 — Create the skeleton

Write `openwiki/_skeleton.md` tracking the planned wiki structure. For each
planned file, include a one-sentence description of what it will document.

Every substantial service, API family, and major workflow must be in the
skeleton. If a human or agent can't understand the repo from the wiki alone,
the skeleton is insufficient.

### Step 4 — Skeleton critic review

Invoke the **skeleton-critic** subagent:

```
@skeleton-critic Review the wiki skeleton at openwiki/_skeleton.md against the
repository. Return PASS or specific evidence-backed change requests.
```

For each returned request (RQ-NN), create a TODO and resolve it. Then invoke the
critic **exactly once more** with the prior-request ledger and your resolutions.
Do not invoke a third time — address remaining items directly.

### Step 5 — Write all pages

After the skeleton passes, write the full content for every page. See
**references/wiki-conventions.md** for page structure, frontmatter, and
diagram rules.

A page must explain: what the system does, why it exists, owning
entrypoints/symbols, dependencies/data flow, invariants, extension points,
focused tests, validation commands, and scope boundaries. A directory listing
or source-map row is NOT substantive coverage.

### Step 6 — Unknown-unknown pass

Review uncovered manifest-backed clusters, uncited one-hop dependencies, and
cross-system workflows revealed during writing. Expand the wiki for real gaps.

### Step 7 — QA verification

Invoke the QA subagents to verify the wiki answers realistic engineering
questions:

1. Invoke **wiki-question-finder** to generate 8-10 source-grounded questions.
2. Create a TODO for each question ID (Q-NN).
3. Batch questions that share wiki pages (2-3 per batch), then invoke
   **wiki-answer-verifier** for all batches in parallel.
4. For every PARTIAL or FAIL, update the canonical wiki pages with the missing
   details. Complete all repairs before retrying.
5. Re-invoke wiki-answer-verifier only for unresolved IDs. Mark TODOs done only
   after PASS.

### Step 8 — Write quickstart

Write `openwiki/quickstart.md` last — it's the entrypoint and must link every
major concept. Include a task-routing table: change area → wiki page → source
entrypoints → symbols → focused tests → validation command. Add a `## Backlog`
section for any deferred area with a source anchor and reason.

### Step 9 — Cleanup and metadata

- Delete `openwiki/_skeleton.md`.
- Write `openwiki/.last-update.json`:
  ```json
  {
    "updatedAt": "<ISO 8601>",
    "command": "init",
    "gitHead": "<output of git rev-parse HEAD>",
    "model": "claude",
    "status": "complete"
  }
  ```

---

## Update Workflow

### Step 1 — Diff against last documented commit

```bash
cat openwiki/.last-update.json   # note the gitHead
git rev-parse HEAD               # current commit
git log <gitHead>..HEAD --name-status --oneline   # changes since last doc
git diff <gitHead>..HEAD -- <changed-file>        # relevant diffs
```

If `.last-update.json` is absent, inspect recent history selectively.

### Step 2 — Build a docs impact plan

Create `openwiki/_plan.md` (temporary, deleted after run). For each changed
source area, map: source change → docs affected → edit needed → why. If a page
can't be tied to a real source/workflow change, do NOT edit it.

### Step 3 — Update affected pages

- Update every page needed to keep the wiki accurate. No preset page limit.
- Preserve useful existing structure/wording when still accurate.
- Do NOT make formatting-only edits (no reformatting tables, normalizing blanks,
  polishing prose) unless the content is already changing for accuracy.
- Add pages for newly documented components/workflows exposed by the changes.
- Keep each concept in one canonical page; link instead of duplicating.
- Adding a diagram to a flow/lifecycle page that lacks one is a valuable change.

### Step 4 — Verify and cleanup

- Reconcile edits against the changed inventory.
- Delete `openwiki/_plan.md`.
- Update `openwiki/.last-update.json` with new `gitHead` and `updatedAt`.
- If nothing changed (wiki already current), say so — don't force edits.

**No-op is valid:** If there are no relevant changes and the wiki is accurate,
do not edit files. Report that the wiki is current.

---

## Chat Mode

1. Read `openwiki/` pages first (quickstart, index pages, targeted grep).
2. Assume the wiki has the answer most of the time.
3. Only read source files when the wiki cannot support the answer.
4. Do not create or update wiki pages unless the user explicitly asks.

---

## Core Discipline Rules

These apply to all modes.

### Source grounding

- Ground every important claim in inspected source, tests, docs, or git evidence.
- Never invent files, modules, APIs, or behavior.
- Manifests/READMEs/directory-listings are discovery evidence, NOT implementation
  evidence. Read the actual code and tests.
- Prefer stable paths and symbol names over line numbers.

### Security

- Never read or document secrets, credentials, tokens, `.env` files.
- `.env.example` with placeholders is OK to read; `.env` with live secrets is not.
- If a secret-bearing file seems relevant, document only that it exists and where
  non-sensitive setup is described.

### Concision

- "Concise" means dense and non-redundant, NOT short. Do not omit important
  domains, components, or relationships for brevity.
- Give each concept one canonical home. Link related concepts in the sentence
  that explains their relationship.
- Do not target a page count or page length.

### Scope

- Write generated content only under `openwiki/`.
- Do not modify source code, `AGENTS.md`, `CLAUDE.md`, or `openwiki/INSTRUCTIONS.md`.
- Directory `index.md` files are generated after the run — do not create them
  manually unless asked.

For detailed conventions (OKF frontmatter, page structure, diagrams, metadata
extension), see **references/wiki-conventions.md**.

For the full verification protocol (skeleton critic + QA subagent prompts and
batching rules), see **references/verification-protocol.md**.

## Common Pitfalls

1. **Starting prose before the evidence gate is satisfied.** Writing quickstart
   while major components only have manifest-level understanding. Fix: complete
   the inventory and skeleton first.

2. **Treating directory listings as documentation.** A source-map row or file
   list is not coverage. Fix: explain responsibilities, symbols, relationships,
   and tests.

3. **Skipping the critic/QA subagents to save time.** These catch real gaps.
   Fix: always run them in init mode.

4. **Formatting-only churn on updates.** Reformatting tables or polishing prose
   that isn't otherwise changing. Fix: only edit content that needs accuracy fixes.

5. **Inventing diagram participants.** Mermaid nodes not grounded in source.
   Fix: every participant/state/entity must come from inspected code.

6. **Modifying source code during a wiki run.** This is a documentation skill.
   Fix: if source is wrong, note it in the wiki or tell the user — don't edit it.

## Verification Checklist

- [ ] `openwiki/quickstart.md` exists and links every major concept
- [ ] Every substantial component/workflow has a dedicated page or substantive section
- [ ] Each page has OKF frontmatter (`type` required minimum)
- [ ] Claims are grounded in inspected source (not invented)
- [ ] Focused tests are referenced where they exist
- [ ] Mermaid diagrams (if any) are grounded in source
- [ ] No secrets/credentials documented anywhere
- [ ] `openwiki/_skeleton.md` (init) or `openwiki/_plan.md` (update) deleted
- [ ] `openwiki/.last-update.json` written with current `gitHead`
- [ ] skeleton-critic invoked (init only); all RQ items resolved
- [ ] wiki-question-finder + wiki-answer-verifier run (init only); all Q items PASS

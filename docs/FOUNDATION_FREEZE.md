# Foundation Freeze

Status as of v1.4.3 (zero known defects, two independent audit passes — see CHANGELOG 1.4.2/1.4.3).
This document freezes **contracts**, not implementations — internals may still be refactored
freely as long as everything below stays true.

## Frozen public APIs (MCP tools)

Nine tools, names and input schemas fixed: `delegate_task`, `delegate_submit`,
`delegate_status`, `delegate_history`, `delegate_models`, `delegate_cancel`, `delegate_replay`
(added in `ADR-0007`), `delegate_metrics` (added in `ADR-0008`), `delegate_snapshot` (added in
`ADR-0009`) — each a **minor**, additive change per this document's own versioning policy
below, not a break of anything above. Field
names, types, defaults, and enum values in
`src/models/schemas.js`'s `DelegateTaskInputShape` are frozen. Tool *descriptions* (prose shown
via `tools/list`) may be corrected for accuracy without being a breaking change.

## Frozen MCP schemas

`DelegateTaskInputShape` (shared by `delegate_task`/`delegate_submit`), the `job_id`-keyed
input shapes of `delegate_status`/`delegate_cancel`, and `delegate_history`'s
`{limit, status}` shape. Any field removal, type change, or default change is breaking.
Adding a new *optional* field with a default is not.

## Frozen execution contract

`delegate_task` is synchronous (blocks until terminal, returns the CLI result shape:
`{isError, content, structuredContent}` or the raw-text fallback). `delegate_submit` is
non-blocking (`{success, job_id, status}` immediately). Both submit through
`services/delegationService.js`'s `submitDelegation()` — the single path into `JobManager`.

## Frozen Job lifecycle

`queued → starting → running → {completed | failed | cancelled}` (`src/models/job.js`'s
`JOB_STATUS`). Terminal states are immutable — `cancelJob()` on a terminal job always
returns `false`. `startedAt` is set once (at `starting`) and never reset. `runtimeMs` is
live-computed for non-terminal jobs, frozen once terminal.

## Frozen ExecutionContext contract

`src/models/executionContext.js`'s `createExecutionContext(input, config)` returns
`{model, effort, timeoutMs, workingDirectory, allowedTools, trustAll, maxBudgetUsd,
metadata, environment}`. `claudeCliService.buildArgs()`/`invoke()` consume only this object
(plus `prompt` and `config.claudeBin`) — never raw tool-input field names. This shape is
frozen; new execution parameters get added here, not threaded through handlers.

## Compatibility guarantees

- `JobManager` is the single source of truth for job state — no other component may claim
  authority over a job's status/result. Persistence layers (e.g. the workspace layer) mirror
  it; they do not replace it.
- `config.claudeBin` must always be spawned with no shell (`shell` option never set to
  `true`) — see `docs/ARCHITECTURE.md`'s security note. This is a frozen security invariant,
  not just a current implementation detail.
- Adding a `DelegateConfig` field (`src/config/index.js`) with a safe default is backward
  compatible; removing or renaming one that's actually read anywhere is not.

## Extension points

- `services/jobStore.js`'s `InMemoryJobStore` implements a 4-method interface
  (`create`/`get`/`update`/`list`) — a persistent store swaps in via
  `new JobManager({ store })` without touching `JobManager` itself.
- `JobManager.submit(taskFn, metadata)` accepts any `(signal, markRunning) => Promise` —
  not tied to `claudeCliService` specifically.
- New MCP tools may be added (as `delegate_submit` was) without touching existing ones, as
  long as they reuse `JobManager`/`delegationService` rather than duplicating job logic.

## Versioning policy

Semver against this document, not against `package.json`'s patch history. A change is:
- **patch**: internal fix, doc correction, dead-code removal, non-behavioral refactor.
- **minor**: new tool, new optional field, new config option with a safe default.
- **major**: anything that breaks a guarantee in this document.

## Breaking-change policy

No entry in "Frozen" sections above changes without an ADR documenting why, and a version
bump that reflects it. `delegate_task`'s blocking behavior and response shape are the
highest-scrutiny surface — any change there requires explicit user sign-off (established
precedent: Sprints 1–4 repeatedly re-verified this via Inspector schema diffs).

## Deprecation policy

No tool or field has been deprecated yet. When one is: it stays functional for at least one
minor version, is marked `deprecated` in its description, and its removal is itself a major
version / breaking change requiring an ADR.

## Release quality gates

A change may not be called complete until:
1. Full test suite passes (`npm test`).
2. `delegate_task`'s schema is Inspector-diffed against the last known-good snapshot.
3. A live end-to-end call succeeds (or the reason it can't in this environment is stated).
4. CHANGELOG/README/ARCHITECTURE reflect the change.
5. No known Critical/High-severity defect remains open.

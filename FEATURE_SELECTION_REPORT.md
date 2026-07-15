# Feature Selection Report — Delegate-as-Implementer Sprint (2026-07-15)

**Objective of this document:** rank every remaining candidate feature against this
sprint's explicit criteria (implementable in one sprint, measurable, independent,
production valuable, exercises Delegate as an *implementer*, not documentation-only, not
cleanup-only), backed by direct repository evidence, and select exactly one.

## Sources read in full

`ROADMAP.md`, `docs/releases/ROADMAP_v1.1.md`, `docs/releases/KNOWN_LIMITATIONS.md`,
`docs/releases/SUPPORTED_FEATURES.md`, `CHANGELOG.md` (all 18 version entries, 1.0.0
through 2.2.2), `docs/FOUNDATION_FREEZE.md`, `docs/OBSERVABILITY_FREEZE.md`, and all four
ADRs (`ADR-0001` workspace/artifacts, `ADR-0002` streaming/events, `ADR-0003`
observability, `ADR-0004` server-instance-lifecycle). Cross-checked against the actual
source (`src/services/jobStore.js`, `src/services/jobManager.js`, `src/services/`
directory listing) to confirm claims below aren't guessed from docs alone.

## Candidates considered and rejected outright

Per `ROADMAP.md` and `docs/releases/ROADMAP_v1.1.md`, every item there — **Dashboard, REST
API, Plugin SDK, VS Code Extension, Prometheus Exporter, Grafana Adapter** — is explicitly
marked "no transport/framework decided" and "each item still needs its own ADR before
implementation, per this project's established discipline." Implementing any of these
this sprint would mean making a first-time production-dependency decision (an HTTP
framework, a metrics-exposition library) *and* writing its ADR *and* implementing it in
one sprint — three sprints' worth of established precedent (Workspace, Streaming,
Observability) all shipped architecture-first in their own dedicated wave, never bundled
with a new dependency choice under time pressure. Rejected as **not implementable within
one sprint** per this project's own conventions, not because they lack value.

## Ranked candidates (real, in-scope work)

### 1. Persistent `JobStore` implementation — **selected**

**Evidence it's real, scoped, and ready:**
- `docs/FOUNDATION_FREEZE.md`, Extension points: *"`services/jobStore.js`'s
  `InMemoryJobStore` implements a 4-method interface (`create`/`get`/`update`/`list`) — a
  persistent store swaps in via `new JobManager({ store })` without touching `JobManager`
  itself."* The extension point is already designed and frozen — not a new decision.
- `docs/releases/KNOWN_LIMITATIONS.md`, Current scope boundaries: *"In-memory job store
  by default (`JobManager({store})` extension point exists but has no shipped persistent
  implementation)."* A named, standing gap.
- Read `src/services/jobStore.js` directly: the interface is exactly 5 synchronous
  methods (`create`, `get`, `update`, `list`, plus `delete` used by
  `jobManager.js:_trimHistory()`) — small enough to fully re-implement, not merely wrap.
- `src/services/jobManager.js` calls every store method **synchronously, unawaited**
  (`this.store.create(...)`, `this.store.update(...)`) — a real, binding design constraint
  a persistent implementation must respect (synchronous disk I/O or a write-through
  in-memory cache), not a detail to discover mid-implementation.

**Production value:** today, a server restart loses all job history — `delegate_history`
after a restart returns nothing for jobs that ran before it, even though
`workspace/jobs/<id>/metadata.json` still has the data on disk. This is a real, currently
open gap, not a hypothetical one.

**Scope check:** self-contained (one new file implementing an already-frozen interface,
swapped in at one constructor call site); zero MCP schema change; no new dependency
needed — Node's `fs` plus the existing `workspace/`-style per-job file pattern this
project already uses (`ADR-0001`) covers it.

**Bonus evidence, found this sprint:** the last sprint's `ponytail-audit`
(`DOGFOODING_METRICS.md`, prior sprint) flagged `InMemoryJobStore`'s interface framing as
a `yagni:` finding — *"framed as a swappable storage interface... but has exactly one
implementation and one instantiation site."* Implementing a second, real implementation
is the direct, evidence-backed resolution of that finding: it turns a speculative
abstraction into a justified one, rather than deleting it.

### 2. Durable full-fidelity replay (`events.jsonl` per job)

**Evidence:** `docs/releases/KNOWN_LIMITATIONS.md` #1: *"Replay fidelity degrades to
'coarse' once a job's timeline leaves `TimelineStore`'s retained window."*
`ADR-0003`'s `ReplayEngine` section: *"a future ADR could add an append-only
`events.jsonl` per job workspace if durable full-fidelity replay becomes a real
requirement. Not designed here."*

**Why ranked below #1:** real value, but the ADR itself says this needs **its own ADR
amendment** before implementation ("not designed here") — meaning this sprint would need
to write that design decision *and* implement it, more scope than the already-designed
persistent store. It also touches the Observability Freeze surface (`ReplayEngine`,
`workspaceEventBridge`) more broadly than #1 touches Foundation, and risks unbounded
per-job disk growth if pruning isn't integrated carefully — a real design risk the
persistent-store candidate doesn't share (its data volume mirrors existing job count,
not existing job count × ticks-per-job).

### 3. `ConsumerRegistry.pruneStale()` scheduled sweep

**Evidence:** `docs/releases/KNOWN_LIMITATIONS.md` — Resolved-since-v1.0.0 section notes
`pruneStale(maxAgeMs)` exists (added 2.2.0) but *"no consumer calls it yet... wiring it
into a scheduled sweep is still future work."*

**Why ranked lowest:** smallest, most mechanical of the three (wire one `setInterval`
calling an already-implemented method) — but **zero current production value**: per
`docs/releases/SUPPORTED_FEATURES.md`, `ObservabilityService` has *no external consumer
at all yet* (no Dashboard, no REST API, no MCP tool reads from it). Scheduling cleanup
for a registry nothing currently registers into doesn't move any real user-facing needle
today. Good candidate for a *small, cheap, native-`Agent`-appropriate* task if one is
needed later, not for this sprint's flagship implementer trial.

## Selection

**Persistent `JobStore` implementation.** Highest production value of the three, fully
pre-designed extension point (no new architecture decision required), no new dependency,
self-contained scope, and genuinely substantial implementer work (synchronous-I/O
constraint, crash-safety/atomic-write concerns, startup hydration, correct interplay with
`_trimHistory()`'s eviction) — a much stronger test of "can Delegate MCP implement
production code" than the scheduled-sweep candidate, without the ADR-first scope the
replay-durability candidate would add.

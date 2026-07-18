import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FileJobStore } from "../src/services/fileJobStore.js";
import { createJob } from "../src/models/job.js";
import { JobManager } from "../src/services/jobManager.js";
import { createDelegationService } from "../src/services/delegationService.js";
import { loadConfig } from "../src/config/index.js";

// ADR-0011's REST/MCP coexistence section rests on one specific FileJobStore property:
// hydrate() runs once, at construction, and get()/list() only ever read the in-memory
// cache -- never the directory. tests/fileJobStoreE2E.test.js already proves recovery
// across a *sequential* crash-then-restart, but no existing test proves the stronger,
// simultaneous-instances claim these pin: two FileJobStore instances alive at the same
// time over the same directory do not share writes live. A future implementation that
// added even a lightweight live re-read (e.g. "check disk on cache miss") would make
// REST and MCP silently share job state -- exactly the regression this guards against.

const root = mkdtempSync(join(tmpdir(), "claude-delegate-filejobstore-coexistence-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("a job created via one live instance is invisible to another live instance over the same directory", () => {
  const dir = join(root, "coexist-create");
  const a = new FileJobStore({ dir });
  const b = new FileJobStore({ dir }); // constructed after `a`, but before `a` writes anything

  const job = createJob(randomUUID(), {});
  a.create(job);

  assert.equal(a.get(job.id).id, job.id, "the writing instance sees its own write");
  assert.equal(b.get(job.id), undefined, "a second live instance never sees a write made after its own construction");
  assert.deepEqual(b.list(), [], "list() on the second instance is also unaffected");

  // Only a fresh instance (a new hydrate() pass) picks it up -- proving the miss above is
  // "no live sync", not "this id can never be found".
  const c = new FileJobStore({ dir });
  assert.equal(c.get(job.id).id, job.id);
});

test("an update made via one live instance is invisible to another live instance's already-hydrated cache", () => {
  const dir = join(root, "coexist-update");
  const job = createJob(randomUUID(), {});
  // Seeded and completed *before* a/b ever hydrate, so it's terminal by the time they
  // read the directory -- hydrate()'s "rewrite any non-terminal job to failed" recovery
  // path (the other characterization test's subject) never touches it, isolating just
  // the property this test targets: a cache is a point-in-time snapshot, not a live view.
  const seed = new FileJobStore({ dir });
  seed.create(job);
  seed.update(job.id, { status: "completed", finishedAt: new Date().toISOString() });

  const a = new FileJobStore({ dir });
  const b = new FileJobStore({ dir });

  a.update(job.id, { result: { changed: true } });

  assert.deepEqual(a.get(job.id).result, { changed: true }, "the writing instance sees its own update");
  assert.equal(b.get(job.id).result, null, "a second live instance keeps serving its own stale hydrated snapshot");

  const c = new FileJobStore({ dir });
  assert.deepEqual(c.get(job.id).result, { changed: true }, "only a fresh hydrate() picks up the update");
});

test("two independent DelegationService stacks (their own JobManager+FileJobStore) over the same job directory never share a job", () => {
  // The two tests above pin the property at the FileJobStore layer only. This closes the
  // gap an adversarial review raised: a future implementation could add a live-refresh or
  // reconciliation step one layer up -- inside JobManager or DelegationService -- and every
  // FileJobStore-level test above would keep passing while ADR-0011's "REST and MCP each
  // construct their own DelegationService and are separate job universes" claim went false.
  // This exercises the exact stack shape (its own JobManager+FileJobStore pair wrapped in a
  // DelegationService) ADR-0011 describes each transport constructing.
  const dir = join(root, "coexist-service-layer");
  const config = { ...loadConfig({}), baseCwd: dir, workspaceRoot: join(dir, "workspaces") };
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const service = {
    invoke: (prompt, context, cfg, { onSpawn } = {}) => {
      onSpawn?.(); // advance starting -> running, as a real CLI spawn would
      return new Promise(() => {}); // never resolves -- no real CLI spawned, job just stays running
    },
  };
  const workspace = { createJobWorkspace() {} }; // out of scope here -- see fileJobStoreE2E/Integration tests for workspace-artifact behavior

  function newStack() {
    const jobManager = new JobManager({ store: new FileJobStore({ dir: join(dir, "jobs") }) });
    return createDelegationService({ jobManager, config, logger, service, workspace });
  }

  const mcpSide = newStack();
  const restSide = newStack(); // constructed after mcpSide, both alive at the same time

  const jobId = mcpSide.submit(
    { prompt: "hi", model: "sonnet", effort: "low", allowed_tools: "", trust_all: false, max_budget_usd: 1 },
    "delegate_task"
  );

  assert.ok(mcpSide.getJob(jobId), "the submitting stack sees its own job");
  assert.equal(
    restSide.getJob(jobId),
    undefined,
    "a second independently-constructed stack over the same directory never sees a job submitted after its own construction"
  );
  assert.deepEqual(restSide.listJobs(), [], "listJobs() on the second stack is also unaffected");

  // Round-2 review: the read-path assertions above (getJob/listJobs) don't prove the write
  // path is equally isolated. A future REST cancel/DELETE implementation could plausibly add
  // an on-miss reconcile specifically to cancelJob() (chasing ADR-0011's disclosed idempotent-
  // DELETE semantics) that would let one stack cancel the other's job without either read-path
  // assertion above catching it.
  assert.equal(
    restSide.cancelJob(jobId),
    false,
    "a stack can't cancel a job it never saw -- cross-stack cancellation is also isolated, not just reads"
  );
  assert.equal(mcpSide.getJob(jobId).status, "running", "the owning stack's job is unaffected by the other stack's no-op cancel attempt");
});

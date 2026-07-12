import { test } from "node:test";
import assert from "node:assert/strict";
import { wireWorkspaceToEventBus } from "../src/services/workspaceEventBridge.js";
import { createRuntimeEventBus } from "../src/services/runtimeEventBus.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";

function fakeJobManager(jobsById) {
  return { getJob: (id) => jobsById[id] };
}

function fakeWorkspace() {
  const calls = { persistJobArtifacts: [], pruneWorkspaces: [], createJobWorkspace: [] };
  return {
    calls,
    persistJobArtifacts: (...args) => calls.persistJobArtifacts.push(args),
    pruneWorkspaces: (...args) => calls.pruneWorkspaces.push(args),
    createJobWorkspace: (...args) => calls.createJobWorkspace.push(args),
  };
}

for (const type of [EVENT_TYPES.JOB_COMPLETED, EVENT_TYPES.JOB_FAILED, EVENT_TYPES.JOB_CANCELLED]) {
  test(`${type} triggers persistJobArtifacts (via getJob) and pruneWorkspaces`, () => {
    const bus = createRuntimeEventBus();
    const job = { id: "job-1", status: "whatever" };
    const jobManager = fakeJobManager({ "job-1": job });
    const workspace = fakeWorkspace();
    const config = { workspaceRoot: "/tmp/x" };

    wireWorkspaceToEventBus({ bus, jobManager, config, workspace });
    bus.publish({ type, jobId: "job-1", payload: {} });

    assert.equal(workspace.calls.persistJobArtifacts.length, 1);
    assert.deepEqual(workspace.calls.persistJobArtifacts[0][0], "job-1");
    assert.equal(workspace.calls.persistJobArtifacts[0][1], job);
    assert.equal(workspace.calls.pruneWorkspaces.length, 1);
  });
}

test("JobQueued does not trigger persistence (createJobWorkspace stays a direct call, not bus-wired)", () => {
  const bus = createRuntimeEventBus();
  const jobManager = fakeJobManager({ "job-1": { id: "job-1" } });
  const workspace = fakeWorkspace();

  wireWorkspaceToEventBus({ bus, jobManager, config: {}, workspace });
  bus.publish({ type: EVENT_TYPES.JOB_QUEUED, jobId: "job-1", payload: {} });

  assert.equal(workspace.calls.persistJobArtifacts.length, 0);
  assert.equal(workspace.calls.createJobWorkspace.length, 0);
});

test("a terminal event for an unknown job id is a safe no-op (job already evicted)", () => {
  const bus = createRuntimeEventBus();
  const jobManager = fakeJobManager({}); // empty — no jobs
  const workspace = fakeWorkspace();

  wireWorkspaceToEventBus({ bus, jobManager, config: {}, workspace });
  assert.doesNotThrow(() => bus.publish({ type: EVENT_TYPES.JOB_COMPLETED, jobId: "ghost-job", payload: {} }));
  assert.equal(workspace.calls.persistJobArtifacts.length, 0);
});

test("unsubscribe-all stops all three terminal subscriptions", () => {
  const bus = createRuntimeEventBus();
  const jobManager = fakeJobManager({ "job-1": { id: "job-1" } });
  const workspace = fakeWorkspace();

  const unsubscribeAll = wireWorkspaceToEventBus({ bus, jobManager, config: {}, workspace });
  unsubscribeAll();

  bus.publish({ type: EVENT_TYPES.JOB_COMPLETED, jobId: "job-1", payload: {} });
  bus.publish({ type: EVENT_TYPES.JOB_FAILED, jobId: "job-1", payload: {} });
  bus.publish({ type: EVENT_TYPES.JOB_CANCELLED, jobId: "job-1", payload: {} });

  assert.equal(workspace.calls.persistJobArtifacts.length, 0);
});

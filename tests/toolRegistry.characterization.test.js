import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpServer } from "../src/server/mcpServer.js";
import { loadConfig } from "../src/config/index.js";

// Stage 1a characterization (ADR-0010): pins today's exact MCP tool registry -- names, order,
// titles, descriptions, input field names, and annotations -- so Stage 1b's DelegationService
// refactor (an internal dependency-injection change only) can be proven byte-identical at the
// wire-observable level. Deliberately tests server._registeredTools (the same introspection
// point tests/mcpServer.test.js already uses for tool name/order), not internal handler logic.

const EXPECTED_TOOL_ORDER = [
  "delegate_task",
  "delegate_submit",
  "delegate_status",
  "delegate_history",
  "delegate_models",
  "delegate_cancel",
  "delegate_replay",
  "delegate_metrics",
  "delegate_snapshot",
];

function buildServer() {
  const config = loadConfig({});
  const logger = { info() {}, warn() {}, error() {} };
  return createMcpServer({ config, logger, version: "characterization-test" }).server;
}

test("Inspector tools/list stability: exactly 9 tools, this order, no more no less", () => {
  const server = buildServer();
  assert.deepEqual(Object.keys(server._registeredTools), EXPECTED_TOOL_ORDER);
});

test("Inspector tools/list stability: each tool's title/description/annotations/inputSchema field set is pinned", () => {
  const server = buildServer();
  const snapshot = {};
  for (const name of EXPECTED_TOOL_ORDER) {
    const t = server._registeredTools[name];
    snapshot[name] = {
      title: t.title,
      description: t.description,
      annotations: t.annotations,
      inputFields: Object.keys(t.inputSchema.shape).sort(),
    };
  }

  assert.deepEqual(snapshot, {
    delegate_task: {
      title: "Delegate task to a Claude Code subagent",
      description:
        "Runs a one-shot Claude Code CLI session (headless) to execute a task, billed against the " +
        "user's existing Claude subscription/session auth — not a separate API key. Use a cheap model " +
        "(sonnet/haiku) for mechanical or recon work, and only escalate to opus/fable for judgment-heavy " +
        "steps. If the requested model is unavailable, it automatically falls back to a cheaper one. " +
        "Blocks until the task finishes — for a long task, use delegate_submit instead and poll with " +
        "delegate_status.",
      annotations: undefined,
      inputFields: ["allowed_tools", "cwd", "effort", "max_budget_usd", "model", "prompt", "trust_all"],
    },
    delegate_submit: {
      title: "Submit a task to a Claude Code subagent (non-blocking)",
      description:
        "Like delegate_task, but returns immediately with a job_id instead of waiting for the task to " +
        "finish. Poll progress with delegate_status/delegate_history, cancel with delegate_cancel. Same " +
        "model tiers, fallback behavior, and default tool restrictions as delegate_task.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputFields: ["allowed_tools", "cwd", "effort", "max_budget_usd", "model", "prompt", "trust_all"],
    },
    delegate_status: {
      title: "Check a delegated job's status",
      description:
        "Looks up a delegate_task/delegate_submit job by id: current status, timestamps, runtime, " +
        "cost, and the full result once it has finished.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputFields: ["job_id"],
    },
    delegate_history: {
      title: "List recent delegated jobs",
      description:
        "Lists recent delegate_task/delegate_submit jobs, most recent first, with status/cost summaries.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputFields: ["limit", "status"],
    },
    delegate_models: {
      title: "List available delegate models",
      description:
        "Lists the model tiers delegate_task accepts, their automatic fallback chains, valid effort " +
        "levels, and current defaults.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputFields: [],
    },
    delegate_cancel: {
      title: "Cancel a delegated job",
      description:
        "Cancels a queued, starting, or running delegate_task/delegate_submit job by id. " +
        "Starting/running jobs are aborted (their subprocess is killed); already-finished jobs " +
        "cannot be cancelled.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputFields: ["job_id"],
    },
    delegate_replay: {
      title: "Replay a delegated job's event history",
      description:
        "Reconstructs a delegate_task/delegate_submit job's event history for viewing -- read-only, " +
        "never re-executes anything. Returns the richest available source: 'runtime' (live, in-memory, " +
        "full fidelity), 'durable' (on-disk full fidelity, only if CLAUDE_DELEGATE_EVENT_HISTORY=file " +
        "was enabled), 'workspace' (coarse lifecycle summary), or 'unavailable'.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputFields: ["job_id"],
    },
    delegate_metrics: {
      title: "Get delegation service metrics",
      description:
        "Returns real-time metrics on job execution, queue depth, and workspace usage — read-only, " +
        "no input required.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputFields: [],
    },
    delegate_snapshot: {
      title: "Get a delegation service snapshot",
      description:
        "Returns a point-in-time snapshot of delegation service state -- metrics plus the list of " +
        "currently active (non-terminal) jobs -- read-only, no input required.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputFields: [],
    },
  });
});

test("delegate_history's real registered schema: limit must be a positive integer, status must be a valid job status", () => {
  const server = buildServer();
  const schema = server._registeredTools["delegate_history"].inputSchema;

  assert.equal(schema.safeParse({}).success, true, "both fields optional");
  assert.equal(schema.safeParse({ limit: 20 }).success, true);
  assert.equal(schema.safeParse({ limit: 0 }).success, false, "limit must be positive");
  assert.equal(schema.safeParse({ limit: -1 }).success, false);
  assert.equal(schema.safeParse({ limit: 1.5 }).success, false, "limit must be an integer");
  assert.equal(schema.safeParse({ status: "queued" }).success, true);
  assert.equal(schema.safeParse({ status: "starting" }).success, true);
  assert.equal(schema.safeParse({ status: "running" }).success, true);
  assert.equal(schema.safeParse({ status: "completed" }).success, true);
  assert.equal(schema.safeParse({ status: "failed" }).success, true);
  assert.equal(schema.safeParse({ status: "cancelled" }).success, true);
  assert.equal(schema.safeParse({ status: "bogus" }).success, false);
  assert.equal(schema.safeParse({}).data.limit, 20, "limit defaults to 20");
});

test("delegate_status/delegate_cancel/delegate_replay's real registered schema: job_id is required and must be a string", () => {
  const server = buildServer();
  for (const name of ["delegate_status", "delegate_cancel", "delegate_replay"]) {
    const schema = server._registeredTools[name].inputSchema;
    assert.equal(schema.safeParse({}).success, false, `${name}: job_id must be required`);
    assert.equal(schema.safeParse({ job_id: 123 }).success, false, `${name}: job_id must be a string`);
    assert.equal(schema.safeParse({ job_id: "abc-123" }).success, true, `${name}: a plain string id is valid`);
  }
});

test("delegate_task/delegate_submit's real registered schema rejects the same invalid input the standalone schema rejects", () => {
  const server = buildServer();
  for (const name of ["delegate_task", "delegate_submit"]) {
    const schema = server._registeredTools[name].inputSchema;
    assert.equal(schema.safeParse({ prompt: "hi", model: "gpt5" }).success, false, `${name}: unknown model rejected`);
    assert.equal(schema.safeParse({ model: "sonnet" }).success, false, `${name}: missing prompt rejected`);
    assert.equal(schema.safeParse({ prompt: "hi", max_budget_usd: 0 }).success, false, `${name}: non-positive budget rejected`);
    assert.equal(schema.safeParse({ prompt: "hi" }).success, true, `${name}: minimal valid input accepted`);
  }
});

test("delegate_models/delegate_metrics/delegate_snapshot's real registered schema takes no input", () => {
  const server = buildServer();
  for (const name of ["delegate_models", "delegate_metrics", "delegate_snapshot"]) {
    const schema = server._registeredTools[name].inputSchema;
    assert.equal(schema.safeParse({}).success, true, `${name}: empty input valid`);
  }
});

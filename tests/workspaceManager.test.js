import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidJobId,
  getWorkspaceRoot,
  createJobWorkspace,
  persistJobArtifacts,
  pruneWorkspaces,
} from "../src/services/workspaceManager.js";
import { loadConfig } from "../src/config/index.js";
import { createExecutionContext } from "../src/models/executionContext.js";
import { createJob } from "../src/models/job.js";

const root = mkdtempSync(join(tmpdir(), "claude-delegate-workspace-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

function freshConfig(overrides = {}) {
  return { ...loadConfig({}), workspaceRoot: join(root, `w-${Math.random().toString(36).slice(2)}`), ...overrides };
}

const VALID_ID = "3562f8cf-6ebc-4573-a009-4fb5b58f2fc3";

test("isValidJobId accepts UUIDs and rejects everything else", () => {
  assert.equal(isValidJobId(VALID_ID), true);
  assert.equal(isValidJobId("../../etc/passwd"), false);
  assert.equal(isValidJobId("not-a-uuid"), false);
  assert.equal(isValidJobId(""), false);
  assert.equal(isValidJobId(null), false);
  assert.equal(isValidJobId(undefined), false);
});

test("createJobWorkspace writes context.json with environment redacted, plus an artifacts/ dir", () => {
  const config = freshConfig();
  const input = {
    prompt: "secret task",
    model: "sonnet",
    effort: "low",
    allowed_tools: "Read",
    trust_all: false,
    max_budget_usd: 1,
  };
  const context = createExecutionContext(input, config);

  createJobWorkspace(VALID_ID, context, config, undefined);

  const dir = join(getWorkspaceRoot(config), VALID_ID);
  assert.ok(existsSync(join(dir, "artifacts")));

  const written = JSON.parse(readFileSync(join(dir, "context.json"), "utf8"));
  assert.equal(written.model, "sonnet");
  assert.notEqual(written.environment, context.environment);
  assert.equal(typeof written.environment, "string");
  assert.ok(!JSON.stringify(written).includes(process.env.PATH ?? "__no_path__"));
});

test("createJobWorkspace never throws for an invalid job id — logs and no-ops instead", () => {
  const config = freshConfig();
  const context = createExecutionContext(
    { prompt: "x", model: "sonnet", effort: "low", allowed_tools: "Read", trust_all: false, max_budget_usd: 1 },
    config
  );
  const warnings = [];
  const logger = { warn: (msg, meta) => warnings.push({ msg, meta }) };

  assert.doesNotThrow(() => createJobWorkspace("../../evil", context, config, logger));
  assert.equal(existsSync(getWorkspaceRoot(config)), false);
  assert.equal(warnings.length, 1);
});

test("persistJobArtifacts writes metadata.json, stdout.log, stderr.log, result.json for a completed job", () => {
  const config = freshConfig();
  const job = {
    ...createJob(VALID_ID, { tool: "delegate_task", model: "haiku", effort: "low" }),
    status: "completed",
    finishedAt: new Date().toISOString(),
    runtimeMs: 123,
    exitCode: 0,
    result: { raw: '{"ok":true}', stderr: "warning: something", parsed: { ok: true, total_cost_usd: 0.01 } },
  };

  persistJobArtifacts(VALID_ID, job, config, undefined);

  const dir = join(getWorkspaceRoot(config), VALID_ID);
  const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
  assert.equal(metadata.status, "completed");
  assert.equal(metadata.costUsd, 0.01);
  assert.equal(readFileSync(join(dir, "stdout.log"), "utf8"), '{"ok":true}');
  assert.equal(readFileSync(join(dir, "stderr.log"), "utf8"), "warning: something");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")), { ok: true, total_cost_usd: 0.01 });
});

test("persistJobArtifacts records the error for a failed job", () => {
  const config = freshConfig();
  const job = {
    ...createJob(VALID_ID, { tool: "delegate_submit" }),
    status: "failed",
    finishedAt: new Date().toISOString(),
    error: "boom",
    result: null,
  };

  persistJobArtifacts(VALID_ID, job, config, undefined);

  const dir = join(getWorkspaceRoot(config), VALID_ID);
  const metadata = JSON.parse(readFileSync(join(dir, "metadata.json"), "utf8"));
  assert.equal(metadata.status, "failed");
  assert.equal(metadata.error, "boom");
  assert.equal(readFileSync(join(dir, "stdout.log"), "utf8"), "");
  assert.equal(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")), null);
});

test("pruneWorkspaces evicts the oldest completed workspaces beyond maxWorkspaceHistory, never an in-flight one", () => {
  const config = freshConfig({ maxWorkspaceHistory: 2 });
  const jobsDir = getWorkspaceRoot(config);

  // Three "finished" workspaces with increasing finishedAt, one "still running" (no metadata.json).
  const ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", "33333333-3333-3333-3333-333333333333"];
  ids.forEach((id, i) => {
    const dir = join(jobsDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "metadata.json"), JSON.stringify({ finishedAt: new Date(2026, 0, i + 1).toISOString() }));
  });
  const inFlightId = "44444444-4444-4444-4444-444444444444";
  mkdirSync(join(jobsDir, inFlightId), { recursive: true });
  writeFileSync(join(jobsDir, inFlightId, "context.json"), "{}"); // no metadata.json yet

  pruneWorkspaces(config, undefined);

  assert.equal(existsSync(join(jobsDir, ids[0])), false, "oldest finished workspace should be evicted");
  assert.equal(existsSync(join(jobsDir, ids[1])), true, "2nd-oldest should survive (cap is 2)");
  assert.equal(existsSync(join(jobsDir, ids[2])), true, "newest should survive");
  assert.equal(existsSync(join(jobsDir, inFlightId)), true, "in-flight workspace must never be evicted");
});

test("pruneWorkspaces is a safe no-op when the workspace root doesn't exist yet", () => {
  const config = freshConfig();
  assert.doesNotThrow(() => pruneWorkspaces(config, undefined));
});

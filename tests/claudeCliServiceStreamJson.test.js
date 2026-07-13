import { test } from "node:test";
import assert from "node:assert/strict";
import { createStreamJsonTracker } from "../src/services/claudeCliService.js";
import { createRuntimeEventBus } from "../src/services/runtimeEventBus.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";

// Fixtures below are trimmed/representative versions of a real `claude -p --output-format
// stream-json --verbose` capture (ADR-0002 Phase 1) — not synthesized from assumptions.
const HOOK_LINE = { type: "system", subtype: "hook_started", hook_id: "x", session_id: "s" };
const INIT_LINE = { type: "system", subtype: "init", session_id: "s", tools: [] };
const THINKING_TOKENS_LINE = { type: "system", subtype: "thinking_tokens", estimated_tokens: 42, estimated_tokens_delta: 17 };
const ASSISTANT_THINKING_LINE = {
  type: "assistant",
  message: { id: "msg_1", model: "claude-haiku-4-5-20251001", content: [{ type: "thinking", thinking: "reasoning..." }] },
};
const ASSISTANT_TEXT_LINE = {
  type: "assistant",
  message: { id: "msg_1", model: "claude-haiku-4-5-20251001", content: [{ type: "text", text: "Four." }] },
};
const RATE_LIMIT_LINE = { type: "rate_limit_event", rate_limit_info: { status: "allowed" } };
const RESULT_LINE = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "Four.",
  total_cost_usd: 0.0281,
  num_turns: 1,
  session_id: "s",
};

function feed(tracker, ...objects) {
  tracker.onChunk(objects.map((o) => JSON.stringify(o)).join("\n") + "\n");
}

test("thinking_tokens publishes JobProgress with phase=thinking and the observed token count", () => {
  const bus = createRuntimeEventBus();
  const progress = [];
  bus.subscribe(EVENT_TYPES.JOB_PROGRESS, (e) => progress.push(e));
  const tracker = createStreamJsonTracker({ bus, jobId: "job-1" });

  feed(tracker, THINKING_TOKENS_LINE);

  assert.equal(progress.length, 1);
  assert.equal(progress[0].jobId, "job-1");
  assert.equal(progress[0].payload.phase, "thinking");
  assert.match(progress[0].payload.progressMessage, /~42 tokens/);
});

test("assistant text content publishes JobProgress with phase=responding", () => {
  const bus = createRuntimeEventBus();
  const progress = [];
  bus.subscribe(EVENT_TYPES.JOB_PROGRESS, (e) => progress.push(e));
  const tracker = createStreamJsonTracker({ bus, jobId: "job-1" });

  feed(tracker, ASSISTANT_TEXT_LINE);

  assert.equal(progress.length, 1);
  assert.equal(progress[0].payload.phase, "responding");
  assert.equal(progress[0].payload.progressMessage, "Four.");
});

test("assistant thinking content does NOT publish progress (raw reasoning stays private)", () => {
  const bus = createRuntimeEventBus();
  const progress = [];
  bus.subscribe(EVENT_TYPES.JOB_PROGRESS, (e) => progress.push(e));
  const tracker = createStreamJsonTracker({ bus, jobId: "job-1" });

  feed(tracker, ASSISTANT_THINKING_LINE);

  assert.equal(progress.length, 0);
});

test("hook/init/rate-limit lines never publish progress (session bookkeeping, not task progress)", () => {
  const bus = createRuntimeEventBus();
  const progress = [];
  bus.subscribe(EVENT_TYPES.JOB_PROGRESS, (e) => progress.push(e));
  const tracker = createStreamJsonTracker({ bus, jobId: "job-1" });

  feed(tracker, HOOK_LINE, INIT_LINE, RATE_LIMIT_LINE);

  assert.equal(progress.length, 0);
});

test("getResultRaw() returns null until the terminal result line arrives, then its exact JSON text", () => {
  const tracker = createStreamJsonTracker({});
  assert.equal(tracker.getResultRaw(), null);

  feed(tracker, THINKING_TOKENS_LINE, ASSISTANT_TEXT_LINE);
  assert.equal(tracker.getResultRaw(), null);

  feed(tracker, RESULT_LINE);
  const raw = tracker.getResultRaw();
  assert.deepEqual(JSON.parse(raw), RESULT_LINE);
});

test("a full realistic session (hooks, init, thinking ticks, response, result) produces the expected progress sequence and final result", () => {
  const bus = createRuntimeEventBus();
  const progress = [];
  bus.subscribe(EVENT_TYPES.JOB_PROGRESS, (e) => progress.push(e.payload.phase));
  const tracker = createStreamJsonTracker({ bus, jobId: "job-1" });

  feed(
    tracker,
    HOOK_LINE,
    HOOK_LINE,
    INIT_LINE,
    { ...THINKING_TOKENS_LINE, estimated_tokens: 5 },
    { ...THINKING_TOKENS_LINE, estimated_tokens: 20 },
    ASSISTANT_THINKING_LINE,
    ASSISTANT_TEXT_LINE,
    RATE_LIMIT_LINE,
    RESULT_LINE
  );

  assert.deepEqual(progress, ["thinking", "thinking", "responding"]);
  assert.deepEqual(JSON.parse(tracker.getResultRaw()), RESULT_LINE);
});

test("malformed lines are skipped gracefully, valid lines around them still processed", () => {
  const bus = createRuntimeEventBus();
  const progress = [];
  bus.subscribe(EVENT_TYPES.JOB_PROGRESS, (e) => progress.push(e));
  const tracker = createStreamJsonTracker({ bus, jobId: "job-1" });

  tracker.onChunk(JSON.stringify(THINKING_TOKENS_LINE) + "\nnot valid json at all\n" + JSON.stringify(ASSISTANT_TEXT_LINE) + "\n");

  assert.equal(progress.length, 2);
});

test("a chunk boundary splitting a line mid-object still reassembles correctly", () => {
  const bus = createRuntimeEventBus();
  const progress = [];
  bus.subscribe(EVENT_TYPES.JOB_PROGRESS, (e) => progress.push(e));
  const tracker = createStreamJsonTracker({ bus, jobId: "job-1" });

  const line = JSON.stringify(THINKING_TOKENS_LINE) + "\n";
  tracker.onChunk(line.slice(0, 10));
  tracker.onChunk(line.slice(10));

  assert.equal(progress.length, 1);
});

test("works with no bus (standalone use) without throwing", () => {
  const tracker = createStreamJsonTracker({});
  assert.doesNotThrow(() => feed(tracker, THINKING_TOKENS_LINE, ASSISTANT_TEXT_LINE, RESULT_LINE));
});

test("concurrent trackers for different jobs never cross-publish progress to the wrong jobId", () => {
  const bus = createRuntimeEventBus();
  const trackerA = createStreamJsonTracker({ bus, jobId: "job-A" });
  const trackerB = createStreamJsonTracker({ bus, jobId: "job-B" });
  const seenByJob = { "job-A": [], "job-B": [] };
  bus.subscribe(EVENT_TYPES.JOB_PROGRESS, (e) => seenByJob[e.jobId]?.push(e));

  feed(trackerA, THINKING_TOKENS_LINE);
  feed(trackerB, ASSISTANT_TEXT_LINE);

  assert.equal(seenByJob["job-A"].length, 1);
  assert.equal(seenByJob["job-A"][0].payload.phase, "thinking");
  assert.equal(seenByJob["job-B"].length, 1);
  assert.equal(seenByJob["job-B"][0].payload.phase, "responding");
});

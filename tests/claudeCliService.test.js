import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArgs, shouldCleanupProcessTree, buildExecOptions } from "../src/services/claudeCliService.js";
import { createExecutionContext } from "../src/models/executionContext.js";
import { loadConfig } from "../src/config/index.js";

const config = loadConfig({});

function baseInput(overrides = {}) {
  return {
    prompt: "say hi",
    model: "sonnet",
    effort: "low",
    allowed_tools: "Read Grep",
    trust_all: false,
    max_budget_usd: 1,
    ...overrides,
  };
}

function contextFor(overrides = {}) {
  const input = baseInput(overrides);
  return { input, context: createExecutionContext(input, config) };
}

test("buildArgs includes prompt, model, effort, budget", () => {
  const { input, context } = contextFor();
  const args = buildArgs(input.prompt, context);
  assert.ok(args.includes("say hi"));
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), [
    "--model",
    "sonnet",
  ]);
  assert.ok(args.includes("--max-budget-usd"));
});

test("buildArgs adds fallback chain for fable and opus, not sonnet/haiku", () => {
  const build = (model) => {
    const { input, context } = contextFor({ model });
    return buildArgs(input.prompt, context);
  };
  assert.ok(build("fable").includes("--fallback-model"));
  assert.ok(build("opus").includes("--fallback-model"));
  assert.ok(!build("sonnet").includes("--fallback-model"));
  assert.ok(!build("haiku").includes("--fallback-model"));
});

test("buildArgs uses --allowedTools by default, --permission-mode bypassPermissions when trust_all", () => {
  const { input: safeInput, context: safeContext } = contextFor();
  const safe = buildArgs(safeInput.prompt, safeContext);
  assert.ok(safe.includes("--allowedTools"));
  assert.ok(!safe.includes("--permission-mode"));

  const { input: trustedInput, context: trustedContext } = contextFor({ trust_all: true });
  const trusted = buildArgs(trustedInput.prompt, trustedContext);
  assert.ok(trusted.includes("--permission-mode"));
  assert.ok(!trusted.includes("--allowedTools"));
});

test("buildArgs keeps prompt as a single literal argv entry (no shell involved to inject into)", () => {
  const dangerous = 'say hi" & calc.exe & echo "pwned; rm -rf / #';
  const { context } = contextFor();
  const args = buildArgs(dangerous, context);
  assert.equal(args[1], dangerous); // untouched — invoke() passes argv directly, no shell parses it
});

test("buildExecOptions uses config.maxBufferBytes, not a hardcoded duplicate constant", () => {
  const { context } = contextFor();
  const options = buildExecOptions(context, { ...config, maxBufferBytes: 12345 });
  assert.equal(options.maxBuffer, 12345);
  assert.equal(options.cwd, context.workingDirectory);
  assert.equal(options.timeout, context.timeoutMs);
});

test("shouldCleanupProcessTree only fires on win32 for an aborted or force-killed child", () => {
  assert.equal(shouldCleanupProcessTree("win32", { name: "AbortError" }), true);
  assert.equal(shouldCleanupProcessTree("win32", { killed: true }), true);
  assert.equal(shouldCleanupProcessTree("win32", { name: "Error", killed: false }), false);
  assert.equal(shouldCleanupProcessTree("win32", null), false);
  assert.equal(shouldCleanupProcessTree("linux", { name: "AbortError" }), false);
  assert.equal(shouldCleanupProcessTree("darwin", { killed: true }), false);
});

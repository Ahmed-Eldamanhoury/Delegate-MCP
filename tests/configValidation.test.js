import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig } from "../src/validation/configValidation.js";
import { loadConfig } from "../src/config/index.js";
import { ConfigError } from "../src/utils/errors.js";

test("validateConfig accepts default config", () => {
  assert.doesNotThrow(() => validateConfig(loadConfig({})));
});

test("validateConfig rejects a non-positive budget", () => {
  const config = { ...loadConfig({}), defaultMaxBudgetUsd: 0 };
  assert.throws(() => validateConfig(config), ConfigError);
});

test("validateConfig rejects a missing claudeBin", () => {
  const config = { ...loadConfig({}), claudeBin: "" };
  assert.throws(() => validateConfig(config), ConfigError);
});

test("validateConfig rejects a non-positive maxConcurrentJobs", () => {
  const config = { ...loadConfig({}), maxConcurrentJobs: 0 };
  assert.throws(() => validateConfig(config), ConfigError);
});

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

test("validateConfig rejects an unrecognized jobStore value", () => {
  const config = { ...loadConfig({}), jobStore: "sqlite" };
  assert.throws(() => validateConfig(config), ConfigError);
});

test("validateConfig rejects an empty jobStoreDir", () => {
  const config = { ...loadConfig({}), jobStoreDir: "" };
  assert.throws(() => validateConfig(config), ConfigError);
});

test("validateConfig accepts the default config with jobStore/jobStoreDir unset by the caller (loadConfig's own defaults apply)", () => {
  const config = loadConfig({});
  assert.equal(config.jobStore, "memory");
  assert.ok(config.jobStoreDir);
  assert.doesNotThrow(() => validateConfig(config));
});

test("validateConfig accepts jobStore explicitly set to 'file' with a valid jobStoreDir", () => {
  const config = { ...loadConfig({}), jobStore: "file", jobStoreDir: "/tmp/whatever" };
  assert.doesNotThrow(() => validateConfig(config));
});

test("loadConfig's defaults are backward compatible: no env vars produces the exact same jobStore/jobStoreDir as before this feature existed would have produced no fields at all -- this test pins today's default values so a future change to them is a deliberate, visible diff", () => {
  const config = loadConfig({});
  assert.equal(config.jobStore, "memory");
  assert.match(config.jobStoreDir, /job-store$/);
});

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

test("validateConfig rejects an unrecognized eventHistory value", () => {
  const config = { ...loadConfig({}), eventHistory: "sqlite" };
  assert.throws(() => validateConfig(config), ConfigError);
});

test("validateConfig rejects an empty eventHistoryDir", () => {
  const config = { ...loadConfig({}), eventHistoryDir: "" };
  assert.throws(() => validateConfig(config), ConfigError);
});

test("validateConfig accepts eventHistory explicitly set to 'file' with a valid eventHistoryDir", () => {
  const config = { ...loadConfig({}), eventHistory: "file", eventHistoryDir: "/tmp/whatever" };
  assert.doesNotThrow(() => validateConfig(config));
});

test("loadConfig's eventHistory/eventHistoryDir defaults are backward compatible -- this test pins today's default values so a future change to them is a deliberate, visible diff", () => {
  const config = loadConfig({});
  assert.equal(config.eventHistory, "memory");
  assert.match(config.eventHistoryDir, /event-history$/);
  assert.doesNotThrow(() => validateConfig(config));
});

test("validateConfig rejects a non-positive maxEventHistoryFiles", () => {
  const config = { ...loadConfig({}), maxEventHistoryFiles: 0 };
  assert.throws(() => validateConfig(config), ConfigError);
});

test("validateConfig rejects a non-integer maxEventHistoryFiles", () => {
  const config = { ...loadConfig({}), maxEventHistoryFiles: 1.5 };
  assert.throws(() => validateConfig(config), ConfigError);
});

test("loadConfig's maxEventHistoryFiles default is backward compatible -- pins today's default (100, matching maxWorkspaceHistory) so a future change is a deliberate, visible diff", () => {
  const config = loadConfig({});
  assert.equal(config.maxEventHistoryFiles, 100);
  assert.doesNotThrow(() => validateConfig(config));
});

// ADR-0012 WP0: dashboardDir config field

test("loadConfig provides a dashboardDir field that ends with dashboard/dist by default", () => {
  const config = loadConfig({});
  assert.ok(typeof config.dashboardDir === "string" && config.dashboardDir.length > 0, "dashboardDir must be a non-empty string");
  assert.ok(
    config.dashboardDir.replace(/\\/g, "/").endsWith("dashboard/dist"),
    `dashboardDir default must end with dashboard/dist, got: ${config.dashboardDir}`
  );
});

test("CLAUDE_DELEGATE_DASHBOARD_DIR env var overrides dashboardDir", () => {
  const config = loadConfig({ CLAUDE_DELEGATE_DASHBOARD_DIR: "/custom/path/to/dist" });
  assert.equal(config.dashboardDir, "/custom/path/to/dist");
});

test("validateConfig accepts default config including dashboardDir (ADR-0012 WP0 non-regression)", () => {
  assert.doesNotThrow(() => validateConfig(loadConfig({})));
});

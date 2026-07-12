import { ConfigError } from "../utils/errors.js";

/** @param {import("../config/index.js").DelegateConfig} config */
export function validateConfig(config) {
  const problems = [];

  if (!config.claudeBin || typeof config.claudeBin !== "string") {
    problems.push("claudeBin must be a non-empty string");
  }
  if (!config.baseCwd || typeof config.baseCwd !== "string") {
    problems.push("baseCwd must be a non-empty string");
  }
  if (!Number.isFinite(config.defaultMaxBudgetUsd) || config.defaultMaxBudgetUsd <= 0) {
    problems.push("defaultMaxBudgetUsd must be a positive number");
  }
  if (!Number.isFinite(config.spawnTimeoutMs) || config.spawnTimeoutMs <= 0) {
    problems.push("spawnTimeoutMs must be a positive number");
  }
  if (!Number.isInteger(config.maxConcurrentJobs) || config.maxConcurrentJobs <= 0) {
    problems.push("maxConcurrentJobs must be a positive integer");
  }
  if (!Number.isInteger(config.maxJobHistory) || config.maxJobHistory <= 0) {
    problems.push("maxJobHistory must be a positive integer");
  }

  if (problems.length > 0) {
    throw new ConfigError(`Invalid configuration: ${problems.join("; ")}`);
  }
}

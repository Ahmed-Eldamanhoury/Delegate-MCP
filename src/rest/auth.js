import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const BEARER_PREFIX = "Bearer ";

/**
 * Resolves the REST bearer token: `config.restToken` verbatim if explicitly set (env var),
 * otherwise the token already persisted at `config.restTokenFile` if one exists (so a token
 * survives restarts instead of silently rotating), otherwise a freshly generated
 * `crypto.randomBytes(32)` token, persisted to that file for next time
 * (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §7). The token value itself is never logged -- only
 * that one was generated and where, extending `ADR-0001`'s environment-redaction discipline.
 * @param {{config: {restToken?: string, restTokenFile: string}, logger: {info: Function}}} deps
 * @returns {string}
 */
export function resolveOrGenerateRestToken({ config, logger }) {
  if (config.restToken) return config.restToken;

  if (existsSync(config.restTokenFile)) {
    return readFileSync(config.restTokenFile, "utf8").trim();
  }

  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(config.restTokenFile), { recursive: true });
  writeFileSync(config.restTokenFile, token, "utf8");
  logger.info("generated a new REST bearer token", { file: config.restTokenFile });
  return token;
}

/**
 * Pure predicate: does `req`'s `Authorization` header carry exactly `token`?
 * (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §7). Compared with `crypto.timingSafeEqual` after an
 * explicit length check -- never `===`, and never lets a length mismatch throw uncaught
 * (`timingSafeEqual` requires equal-length buffers).
 * @param {{headers: {authorization?: string}}} req
 * @param {string} token
 * @returns {boolean}
 */
export function checkBearerToken(req, token) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith(BEARER_PREFIX)) return false;

  const presented = Buffer.from(header.slice(BEARER_PREFIX.length), "utf8");
  const expected = Buffer.from(token, "utf8");
  if (presented.length !== expected.length) return false;

  return timingSafeEqual(presented, expected);
}

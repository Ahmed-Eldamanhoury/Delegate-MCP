import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBearerToken, resolveOrGenerateRestToken } from "../src/rest/auth.js";

// WP1 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §7): checkBearerToken is a pure predicate --
// resolveOrGenerateRestToken's fs side effects (added in WP2, per §7/§3 -- restEntry.js's boot
// sequence needs it) are exercised here, extending this same module's own test file rather than
// a new one, since it's the same file gaining a new export.
// Compared with crypto.timingSafeEqual after an explicit length check, never ===.

const TOKEN = "a".repeat(64);

test("returns true for the exact configured token via a valid Authorization: Bearer header", () => {
  const req = { headers: { authorization: `Bearer ${TOKEN}` } };
  assert.equal(checkBearerToken(req, TOKEN), true);
});

test("returns false when the Authorization header is missing entirely", () => {
  const req = { headers: {} };
  assert.equal(checkBearerToken(req, TOKEN), false);
});

test("returns false for a wrong token of the same length", () => {
  const req = { headers: { authorization: `Bearer ${"b".repeat(64)}` } };
  assert.equal(checkBearerToken(req, TOKEN), false);
});

test("returns false for a wrong token of a different length -- must not throw (crypto.timingSafeEqual requires equal-length buffers)", () => {
  const req = { headers: { authorization: "Bearer short" } };
  assert.doesNotThrow(() => checkBearerToken(req, TOKEN));
  assert.equal(checkBearerToken(req, TOKEN), false);
});

test("returns false for a malformed header (no 'Bearer ' prefix)", () => {
  const req = { headers: { authorization: TOKEN } };
  assert.equal(checkBearerToken(req, TOKEN), false);
});

test("returns false for an empty Authorization header", () => {
  const req = { headers: { authorization: "" } };
  assert.equal(checkBearerToken(req, TOKEN), false);
});

const root = mkdtempSync(join(tmpdir(), "claude-delegate-restauth-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const logger = { info() {}, warn() {}, error() {} };

test("resolveOrGenerateRestToken returns config.restToken verbatim when explicitly set, never touching disk", () => {
  const restTokenFile = join(root, "should-not-be-created", "token");
  const token = resolveOrGenerateRestToken({ config: { restToken: "explicit-token", restTokenFile }, logger });

  assert.equal(token, "explicit-token");
  assert.equal(existsSync(restTokenFile), false);
});

test("resolveOrGenerateRestToken creates any missing nested parent directories for the token file", () => {
  const restTokenFile = join(root, "deeply", "nested", "not-yet-created", "token");
  assert.equal(existsSync(join(root, "deeply")), false);

  const token = resolveOrGenerateRestToken({ config: { restToken: undefined, restTokenFile }, logger });

  assert.equal(readFileSync(restTokenFile, "utf8").trim(), token);
});

test("resolveOrGenerateRestToken generates and persists a new token when none is configured and no file exists yet", () => {
  const restTokenFile = join(root, "fresh-token");
  const token = resolveOrGenerateRestToken({ config: { restToken: undefined, restTokenFile }, logger });

  assert.equal(typeof token, "string");
  assert.ok(token.length >= 32, "expected a real random token, not a short placeholder");
  assert.equal(readFileSync(restTokenFile, "utf8").trim(), token);
});

test("resolveOrGenerateRestToken reuses the persisted token on a later call rather than generating a new one", () => {
  const restTokenFile = join(root, "reuse-token");
  const first = resolveOrGenerateRestToken({ config: { restToken: undefined, restTokenFile }, logger });
  const second = resolveOrGenerateRestToken({ config: { restToken: undefined, restTokenFile }, logger });

  assert.equal(second, first, "a second boot must reuse the same token, not silently rotate it");
});

test("resolveOrGenerateRestToken never logs the token value itself, only that one was generated and where", () => {
  const restTokenFile = join(root, "logged-token");
  const calls = [];
  const spyLogger = { info: (...args) => calls.push(args), warn() {}, error() {} };

  const token = resolveOrGenerateRestToken({ config: { restToken: undefined, restTokenFile }, logger: spyLogger });

  assert.ok(calls.length >= 1, "expected at least one log call announcing token generation");
  const logged = JSON.stringify(calls);
  assert.ok(!logged.includes(token), "the token value itself must never appear in a log call");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createErrorMapper, PayloadTooLargeError, MalformedBodyError } from "../src/rest/errors.js";
import { InvalidQueryParamError } from "../src/rest/parsing.js";

// WP1 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §9): toHttpError() is the ONE place that maps a
// thrown exception to {status, body}. logger is an explicit constructor dependency (the 500
// branch logs server-side) -- createErrorMapper({logger}) returns the mapping function.

function newMapper(logger = { error() {} }) {
  return createErrorMapper({ logger });
}

test("maps PayloadTooLargeError to 413 PAYLOAD_TOO_LARGE, message passed through", () => {
  const toHttpError = newMapper();
  const err = new PayloadTooLargeError("body exceeds 1048576 bytes");

  assert.deepEqual(toHttpError(err), {
    status: 413,
    body: { error: { code: "PAYLOAD_TOO_LARGE", message: "body exceeds 1048576 bytes" } },
  });
});

test("maps MalformedBodyError to 400 MALFORMED_BODY with a fixed message", () => {
  const toHttpError = newMapper();
  const err = new MalformedBodyError("Unexpected token");

  assert.deepEqual(toHttpError(err), {
    status: 400,
    body: { error: { code: "MALFORMED_BODY", message: "Request body is not valid JSON" } },
  });
});

test("maps an InvalidQueryParamError to 400 INVALID_QUERY_PARAM, message passed through -- WP3 (parseTimelineQuery/parseListQuery can throw this)", () => {
  const toHttpError = newMapper();
  const err = new InvalidQueryParamError("Invalid type: NotReal");

  assert.deepEqual(toHttpError(err), {
    status: 400,
    body: { error: { code: "INVALID_QUERY_PARAM", message: "Invalid type: NotReal" } },
  });
});

test("maps a ZodError to 400 INVALID_INPUT with details:issues", () => {
  const toHttpError = newMapper();
  const schema = z.object({ prompt: z.string() });
  let zodError;
  try {
    schema.parse({});
  } catch (err) {
    zodError = err;
  }
  assert.ok(zodError instanceof z.ZodError);

  const result = toHttpError(zodError);
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "INVALID_INPUT");
  assert.equal(result.body.error.message, "Invalid request body");
  assert.deepEqual(result.body.error.details, zodError.issues);
});

test("maps any other error to a generic 500 INTERNAL_ERROR, never leaking err.message/stack over the wire", () => {
  const toHttpError = newMapper();
  const err = new Error("secret filesystem path: /etc/shadow");

  const result = toHttpError(err);
  assert.deepEqual(result, { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "An internal error occurred" } } });
});

test("the 500 branch logs the full error server-side, via the injected logger", () => {
  const calls = [];
  const toHttpError = newMapper({ error: (...args) => calls.push(args) });
  const err = new Error("boom");
  err.stack = "Error: boom\n    at somewhere";

  toHttpError(err);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "unhandled REST error");
  assert.equal(calls[0][1].message, "boom");
  assert.equal(calls[0][1].stack, err.stack);
});

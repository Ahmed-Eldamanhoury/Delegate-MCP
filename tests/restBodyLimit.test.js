import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { checkContentLengthLimit, streamBoundedBody } from "../src/rest/bodyLimit.js";
import { PayloadTooLargeError } from "../src/rest/errors.js";

// WP1 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §2/§8): checkContentLengthLimit is a pure,
// header-based pre-check (no I/O). streamBoundedBody is the ONE function that attaches the
// byte-counting guard to a request's body stream, used for every request regardless of route --
// its Promise resolves with the full Buffer once the body ends, or rejects with
// PayloadTooLargeError the moment accumulated bytes cross the limit, destroying the socket so no
// keep-alive reuse is possible after either 413 path.

function fakeReqWithSocket() {
  const req = new PassThrough();
  req.socket = { destroyed: false, destroy() { this.destroyed = true; } };
  return req;
}

test("checkContentLengthLimit returns true when Content-Length header is absent", () => {
  assert.equal(checkContentLengthLimit({ headers: {} }, 1024), true);
});

test("checkContentLengthLimit returns true when Content-Length is within the limit", () => {
  assert.equal(checkContentLengthLimit({ headers: { "content-length": "500" } }, 1024), true);
});

test("checkContentLengthLimit returns false when Content-Length exceeds the limit", () => {
  assert.equal(checkContentLengthLimit({ headers: { "content-length": "2048" } }, 1024), false);
});

test("checkContentLengthLimit returns false for a Content-Length exactly one byte over the limit, true exactly at the limit", () => {
  assert.equal(checkContentLengthLimit({ headers: { "content-length": "1025" } }, 1024), false);
  assert.equal(checkContentLengthLimit({ headers: { "content-length": "1024" } }, 1024), true);
});

test("streamBoundedBody resolves with the full accumulated Buffer once the body ends, within the limit", async () => {
  const req = fakeReqWithSocket();
  const promise = streamBoundedBody(req, 1024);
  req.end("hello world");

  const buffer = await promise;
  assert.equal(buffer.toString("utf8"), "hello world");
  assert.equal(req.socket.destroyed, false);
});

test("streamBoundedBody rejects with PayloadTooLargeError and destroys the socket once accumulated bytes cross the limit", async () => {
  const req = fakeReqWithSocket();
  const promise = streamBoundedBody(req, 10);
  req.write("this chunk is way more than ten bytes");

  await assert.rejects(promise, PayloadTooLargeError);
  assert.equal(req.socket.destroyed, true);
});

test("streamBoundedBody catches a body split across many small chunks that only exceed the limit cumulatively", async () => {
  const req = fakeReqWithSocket();
  const promise = streamBoundedBody(req, 10);
  req.write("12345");
  req.write("67890");
  req.write("more"); // 14 bytes total, crosses the limit on this write

  await assert.rejects(promise, PayloadTooLargeError);
  assert.equal(req.socket.destroyed, true);
});

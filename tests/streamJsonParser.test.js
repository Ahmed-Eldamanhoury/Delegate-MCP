import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStreamJsonChunk } from "../src/services/streamJsonParser.js";

test("parses complete lines delivered in one chunk", () => {
  const { objects, malformedLines, remainder } = parseStreamJsonChunk("", '{"a":1}\n{"b":2}\n');
  assert.deepEqual(objects, [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(malformedLines, []);
  assert.equal(remainder, "");
});

test("holds a line split across two chunks until it completes", () => {
  const first = parseStreamJsonChunk("", '{"a":1}\n{"b":');
  assert.deepEqual(first.objects, [{ a: 1 }]);
  assert.equal(first.remainder, '{"b":');

  const second = parseStreamJsonChunk(first.remainder, '2}\n{"c":3}\n');
  assert.deepEqual(second.objects, [{ b: 2 }, { c: 3 }]);
  assert.equal(second.remainder, "");
});

test("a line split across three chunks (one char at a time) still reassembles", () => {
  let remainder = "";
  const text = '{"x":42}\n';
  for (const ch of text) {
    ({ remainder } = parseStreamJsonChunk(remainder, ch));
  }
  const final = parseStreamJsonChunk(remainder, "");
  // the object should have appeared exactly once, on the call where '\n' completed the line
  let seen = [];
  remainder = "";
  for (const ch of text) {
    const r = parseStreamJsonChunk(remainder, ch);
    seen.push(...r.objects);
    remainder = r.remainder;
  }
  assert.deepEqual(seen, [{ x: 42 }]);
});

test("a malformed line is reported, not thrown, and doesn't block subsequent valid lines", () => {
  const { objects, malformedLines } = parseStreamJsonChunk("", "not json\n{\"ok\":true}\n");
  assert.deepEqual(objects, [{ ok: true }]);
  assert.deepEqual(malformedLines, ["not json"]);
});

test("blank lines are skipped silently", () => {
  const { objects, malformedLines } = parseStreamJsonChunk("", '\n\n{"a":1}\n\n');
  assert.deepEqual(objects, [{ a: 1 }]);
  assert.deepEqual(malformedLines, []);
});

test("no trailing newline leaves the final line in remainder, unparsed", () => {
  const { objects, remainder } = parseStreamJsonChunk("", '{"a":1}\n{"incomplete"');
  assert.deepEqual(objects, [{ a: 1 }]);
  assert.equal(remainder, '{"incomplete"');
});

test("empty input is a safe no-op", () => {
  const { objects, malformedLines, remainder } = parseStreamJsonChunk("", "");
  assert.deepEqual(objects, []);
  assert.deepEqual(malformedLines, []);
  assert.equal(remainder, "");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createConsumerRegistry } from "../src/services/consumerRegistry.js";

test("register returns a unique id and lists the consumer with its metadata", () => {
  const registry = createConsumerRegistry();
  const handle = registry.register("dashboard", { transport: "http" });

  assert.ok(handle.id);
  const list = registry.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, handle.id);
  assert.equal(list[0].name, "dashboard");
  assert.deepEqual(list[0].metadata, { transport: "http" });
  assert.ok(list[0].registeredAt);
});

test("registering without metadata defaults to an empty object, never throws", () => {
  const registry = createConsumerRegistry();
  const handle = registry.register("plugin-x");
  assert.deepEqual(registry.list()[0].metadata, {});
  assert.ok(handle.id);
});

test("two consumers get distinct ids, even with the same name", () => {
  const registry = createConsumerRegistry();
  const a = registry.register("dup");
  const b = registry.register("dup");
  assert.notEqual(a.id, b.id);
  assert.equal(registry.list().length, 2);
});

test("unregister (via the handle or by id) removes the consumer from list()", () => {
  const registry = createConsumerRegistry();
  const handle = registry.register("dashboard");
  assert.equal(handle.unregister(), true);
  assert.equal(registry.list().length, 0);
  assert.equal(registry.getHealth(handle.id).active, false);
});

test("unregistering an unknown id returns false, never throws", () => {
  const registry = createConsumerRegistry();
  assert.equal(registry.unregister("nope"), false);
});

test("touch updates lastSeenAt without changing registeredAt or the consumer's identity", async () => {
  const registry = createConsumerRegistry();
  const handle = registry.register("dashboard");
  const before = registry.getHealth(handle.id);

  await new Promise((r) => setTimeout(r, 5));
  assert.equal(handle.touch(), true);

  const after = registry.getHealth(handle.id);
  assert.equal(after.registeredAt, before.registeredAt);
  assert.notEqual(after.lastSeenAt, before.lastSeenAt);
});

test("touching an unregistered/unknown consumer returns false", () => {
  const registry = createConsumerRegistry();
  const handle = registry.register("dashboard");
  handle.unregister();
  assert.equal(handle.touch(), false);
});

test("getHealth for a never-registered id reports inactive with null timestamps", () => {
  const registry = createConsumerRegistry();
  assert.deepEqual(registry.getHealth("never-existed"), {
    id: "never-existed",
    active: false,
    registeredAt: null,
    lastSeenAt: null,
  });
});

test("getStatistics: activeCount reflects currently-registered count; totalRegistered is all-time and never decrements", () => {
  const registry = createConsumerRegistry();
  const a = registry.register("a");
  registry.register("b");
  assert.deepEqual(registry.getStatistics(), { activeCount: 2, totalRegistered: 2 });

  a.unregister();
  assert.deepEqual(registry.getStatistics(), { activeCount: 1, totalRegistered: 2 });
});

test("list() returns copies — mutating the returned array/objects never affects the registry", () => {
  const registry = createConsumerRegistry();
  registry.register("dashboard");
  const list = registry.list();
  list[0].name = "tampered";
  list.push({ id: "injected" });

  assert.equal(registry.list()[0].name, "dashboard");
  assert.equal(registry.list().length, 1);
});

test("regression: mutating a list() result's .metadata never corrupts the registry (metadata is cloned, not aliased)", () => {
  const registry = createConsumerRegistry();
  registry.register("dashboard", { transport: "http" });

  registry.list()[0].metadata.transport = "tampered";
  assert.equal(registry.list()[0].metadata.transport, "http");
});

test("regression: mutating the caller's original metadata object after register() never affects the registry", () => {
  const registry = createConsumerRegistry();
  const original = { transport: "http" };
  registry.register("dashboard", original);

  original.transport = "tampered";
  assert.equal(registry.list()[0].metadata.transport, "http");
});

test("exposes no transport/execution methods — pure bookkeeping only", () => {
  const registry = createConsumerRegistry();
  for (const forbidden of ["send", "publish", "broadcast", "connect", "emit"]) {
    assert.equal(typeof registry[forbidden], "undefined", `must not expose ${forbidden}`);
  }
});

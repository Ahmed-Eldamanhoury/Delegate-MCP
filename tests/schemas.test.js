import { test } from "node:test";
import assert from "node:assert/strict";
import { DelegateTaskInputSchema, DelegateTaskInputShape, MODELS, EFFORTS } from "../src/models/schemas.js";
import { createDelegateModelsHandler } from "../src/handlers/delegateModelsHandler.js";
import { loadConfig } from "../src/config/index.js";

test("schema applies defaults matching the pre-refactor tool contract", () => {
  const parsed = DelegateTaskInputSchema.parse({ prompt: "do x" });
  assert.equal(parsed.model, "sonnet");
  assert.equal(parsed.effort, "low");
  assert.equal(parsed.trust_all, false);
  assert.equal(parsed.max_budget_usd, 1);
  assert.equal(parsed.allowed_tools, "Read Grep Glob WebSearch WebFetch");
});

test("schema rejects an unknown model", () => {
  assert.throws(() => DelegateTaskInputSchema.parse({ prompt: "x", model: "gpt5" }));
});

test("schema requires prompt", () => {
  assert.throws(() => DelegateTaskInputSchema.parse({}));
});

test("schema rejects a zero or negative max_budget_usd", () => {
  assert.throws(() => DelegateTaskInputSchema.parse({ prompt: "x", max_budget_usd: 0 }));
  assert.throws(() => DelegateTaskInputSchema.parse({ prompt: "x", max_budget_usd: -5 }));
});

test("delegate_task's model/effort enums and delegate_models' listing share one source (MODELS/EFFORTS)", async () => {
  assert.deepEqual(DelegateTaskInputShape.model._def.innerType.options, MODELS);
  assert.deepEqual(DelegateTaskInputShape.effort._def.innerType.options, EFFORTS);

  const handler = createDelegateModelsHandler({ config: loadConfig({}) });
  const response = await handler();
  assert.deepEqual(
    response.structuredContent.models.map((m) => m.model),
    MODELS
  );
  assert.deepEqual(response.structuredContent.efforts, EFFORTS);
});

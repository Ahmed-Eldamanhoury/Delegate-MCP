import { test } from "node:test";
import assert from "node:assert/strict";
import { createModelsRoute } from "../src/rest/routes/models.js";
import { buildModelsInfo } from "../src/models/schemas.js";
import { loadConfig } from "../src/config/index.js";

// WP3 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §1/§2/§12): createModelsRoute({config}) ->
// {handleModels}. Calls the shared buildModelsInfo(config), returning its structured result as
// the JSON body directly -- no MCP-specific text formatting.

test("handleModels returns 200 with buildModelsInfo(config)'s exact structured result as the body", () => {
  const config = loadConfig({});
  const { handleModels } = createModelsRoute({ config });

  const result = handleModels({});

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, buildModelsInfo(config));
});

test("handleModels' body has no MCP-specific text field -- just the structured {models, efforts, defaults} shape", () => {
  const config = loadConfig({});
  const { handleModels } = createModelsRoute({ config });

  const { body } = handleModels({});

  assert.deepEqual(Object.keys(body).sort(), ["defaults", "efforts", "models"]);
  assert.deepEqual(
    body.models.map((m) => m.model),
    ["haiku", "sonnet", "opus", "fable"]
  );
});

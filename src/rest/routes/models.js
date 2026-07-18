import { buildModelsInfo } from "../../models/schemas.js";

/**
 * GET /v1/models (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §1/§2/§12, WP3). Calls the shared
 * buildModelsInfo(config), returning its structured result as the JSON body directly -- no
 * MCP-specific text formatting.
 * @param {{config: import("../../config/index.js").DelegateConfig}} deps
 */
export function createModelsRoute({ config }) {
  return {
    handleModels() {
      return { status: 200, body: buildModelsInfo(config) };
    },
  };
}

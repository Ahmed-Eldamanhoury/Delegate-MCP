import { buildModelsInfo } from "../models/schemas.js";

/** @param {{config: import("../config/index.js").DelegateConfig}} deps */
export function createDelegateModelsHandler({ config }) {
  return async function delegateModelsHandler() {
    const { models, efforts, defaults } = buildModelsInfo(config);

    const text = models
      .map((m) => `${m.model}${m.fallback ? ` (fallback: ${m.fallback})` : ""}`)
      .join("\n");

    return {
      content: [{ type: "text", text }],
      structuredContent: { models, efforts, defaults },
    };
  };
}

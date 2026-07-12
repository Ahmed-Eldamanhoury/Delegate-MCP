import { MODELS, EFFORTS } from "../models/schemas.js";

/** @param {{config: import("../config/index.js").DelegateConfig}} deps */
export function createDelegateModelsHandler({ config }) {
  return async function delegateModelsHandler() {
    const models = MODELS.map((model) => ({
      model,
      fallback: config.modelFallbacks[model] ?? null,
    }));

    const text = models
      .map((m) => `${m.model}${m.fallback ? ` (fallback: ${m.fallback})` : ""}`)
      .join("\n");

    return {
      content: [{ type: "text", text }],
      structuredContent: {
        models,
        efforts: EFFORTS,
        defaults: { model: "sonnet", effort: "low", maxBudgetUsd: config.defaultMaxBudgetUsd },
      },
    };
  };
}

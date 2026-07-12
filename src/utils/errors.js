export class DelegateError extends Error {
  constructor(message, { cause, code = "DELEGATE_ERROR" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DelegateError";
    this.code = code;
  }
}

export class ConfigError extends DelegateError {
  constructor(message, opts) {
    super(message, { ...opts, code: "CONFIG_ERROR" });
    this.name = "ConfigError";
  }
}

/** Formats any error as an MCP tool error response. */
export function toToolErrorContent(err) {
  return {
    isError: true,
    content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
  };
}

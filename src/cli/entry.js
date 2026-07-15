import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config/index.js";
import { VERSION } from "../config/version.js";
import { validateConfig } from "../validation/configValidation.js";
import { createLogger } from "../logging/logger.js";
import { checkClaudeBinary } from "../server/health.js";
import { createMcpServer } from "../server/mcpServer.js";

/**
 * Wires graceful shutdown to three independent triggers, all sharing one `shutdown()` path:
 * SIGINT, SIGTERM, and (new) the process's own `stdin` ending. The MCP SDK's
 * `StdioServerTransport` never detects its own `stdin` closing to self-shut-down (confirmed
 * by reading its source in ADR-0004) -- if the actual MCP host disconnects without delivering
 * a signal this process can catch (unreliable on Windows in particular), this process would
 * otherwise sit orphaned indefinitely, still holding stale job state. Reacting to `stdin`
 * ending routes that case through the exact same graceful-shutdown path SIGINT/SIGTERM use,
 * rather than adding a second, different shutdown mechanism.
 *
 * @param {{close: () => Promise<void>}} server
 * @param {{info: Function, warn: Function, error: Function}} logger
 * @param {{stdin?: NodeJS.ReadStream, exit?: () => void, signalSource?: NodeJS.Process}} [deps]
 *   Injectable purely for testability -- production always uses the real `process`/`process.stdin`.
 * @returns {(trigger: string) => void} the shutdown function itself, exposed for testability
 */
export function registerShutdownHandlers(server, logger, { stdin = process.stdin, exit = () => process.exit(0), signalSource = process } = {}) {
  const shutdown = (trigger) => {
    logger.info("shutting down", { trigger });
    server
      .close()
      .catch((err) => logger.error("error during shutdown", { message: err.message }))
      .finally(exit);
  };
  signalSource.on("SIGINT", () => shutdown("SIGINT"));
  signalSource.on("SIGTERM", () => shutdown("SIGTERM"));
  stdin.on("end", () => shutdown("stdin-closed"));
  return shutdown;
}

export async function main() {
  const logger = createLogger("claude-delegate");

  const config = loadConfig(process.env);
  validateConfig(config);

  const health = await checkClaudeBinary(config);
  logger[health.ok ? "info" : "warn"]("claude binary health check", health);

  const server = createMcpServer({ config, logger, version: VERSION });
  registerShutdownHandlers(server, logger);

  await server.connect(new StdioServerTransport());
  logger.info("claude-delegate mcp server started", { version: VERSION });
}

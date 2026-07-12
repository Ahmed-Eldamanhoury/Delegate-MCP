import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../config/index.js";
import { VERSION } from "../config/version.js";
import { validateConfig } from "../validation/configValidation.js";
import { createLogger } from "../logging/logger.js";
import { checkClaudeBinary } from "../server/health.js";
import { createMcpServer } from "../server/mcpServer.js";

export async function main() {
  const logger = createLogger("claude-delegate");

  const config = loadConfig(process.env);
  validateConfig(config);

  const health = await checkClaudeBinary(config);
  logger[health.ok ? "info" : "warn"]("claude binary health check", health);

  const server = createMcpServer({ config, logger, version: VERSION });

  const shutdown = (signal) => {
    logger.info("shutting down", { signal });
    server
      .close()
      .catch((err) => logger.error("error during shutdown", { message: err.message }))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await server.connect(new StdioServerTransport());
  logger.info("claude-delegate mcp server started", { version: VERSION });
}

main().catch((err) => {
  process.stderr.write(`fatal startup error: ${err.stack || err.message}\n`);
  process.exit(1);
});

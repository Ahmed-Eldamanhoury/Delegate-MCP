// REST server entrypoint — analogous to server.js for the MCP transport.
import { main } from "./src/cli/restEntry.js";

main().catch((err) => {
  process.stderr.write(`fatal startup error: ${err.stack || err.message}\n`);
  process.exit(1);
});

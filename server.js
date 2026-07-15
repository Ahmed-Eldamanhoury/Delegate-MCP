// Backward-compatible entrypoint — claude_desktop_config.json points at this exact path.
// Actual implementation lives in src/; see docs/ARCHITECTURE.md.
import { main } from "./src/cli/entry.js";

main().catch((err) => {
  process.stderr.write(`fatal startup error: ${err.stack || err.message}\n`);
  process.exit(1);
});

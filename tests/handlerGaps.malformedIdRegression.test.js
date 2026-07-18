import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../src/services/jobManager.js";
import { loadConfig } from "../src/config/index.js";
import { wireWorkspaceToEventBus } from "../src/services/workspaceEventBridge.js";
import { createDelegationService } from "../src/services/delegationService.js";
import { createDelegateStatusHandler } from "../src/handlers/delegateStatusHandler.js";
import { createDelegateCancelHandler } from "../src/handlers/delegateCancelHandler.js";

// WP1 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §5, §13): re-runs the exact malformed-id baseline
// Stage 1 Characterization already captured (tests/handlerGaps.characterization.test.js) against
// the real delegateStatusHandler/delegateCancelHandler, now that DelegationService's isValidJobId()
// guard exists, asserting byte-identical output before and after. This is the required
// non-negotiable regression/proof test (Review Package §7 item 1) -- it must start as soon as
// WP1's guard lands, not held behind WP5, since it needs only the guard plus the existing MCP
// handlers, no REST route.

const tempWorkspaceRoot = mkdtempSync(join(tmpdir(), "claude-delegate-malformed-id-regression-"));
after(() => rmSync(tempWorkspaceRoot, { recursive: true, force: true }));
const config = { ...loadConfig({}), workspaceRoot: tempWorkspaceRoot };
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function newDelegationService() {
  const jobManager = new JobManager({ maxConcurrent: 3 });
  wireWorkspaceToEventBus({ bus: jobManager.bus, jobManager, config, logger });
  return createDelegationService({ jobManager, config, logger });
}

// The exact baseline Stage 1 Characterization captured: every one of these malformed/unknown
// shapes produced isError:true, "No job found with id <job_id>", for both handlers, with no guard
// in place at all. Same inputs, same expected outputs -- re-asserted now that the guard exists.
const MALFORMED_OR_UNKNOWN_IDS = ["", "../../etc/passwd", "not a uuid at all!!", "00000000-0000-0000-0000-000000000000"];

test("delegate_status: malformed/unknown job id output is byte-identical to the pre-guard baseline", async () => {
  const delegationService = newDelegationService();
  const status = createDelegateStatusHandler({ delegationService });

  for (const id of MALFORMED_OR_UNKNOWN_IDS) {
    const response = await status({ job_id: id });
    assert.equal(response.isError, true);
    assert.equal(response.content[0].text, `No job found with id ${id}`);
    assert.equal(response.structuredContent, undefined);
  }
});

test("delegate_cancel: malformed/unknown job id output is byte-identical to the pre-guard baseline", async () => {
  const delegationService = newDelegationService();
  const cancel = createDelegateCancelHandler({ delegationService });

  for (const id of MALFORMED_OR_UNKNOWN_IDS) {
    const response = await cancel({ job_id: id });
    assert.equal(response.isError, true);
    assert.equal(response.content[0].text, `No job found with id ${id}`);
  }
});

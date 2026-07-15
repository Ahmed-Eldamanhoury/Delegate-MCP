import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../src/services/jobManager.js";
import { FileJobStore } from "../src/services/fileJobStore.js";

const root = mkdtempSync(join(tmpdir(), "claude-delegate-filejobstore-integration-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("JobManager with a FileJobStore runs a full job lifecycle and persists it to disk", async () => {
  const dir = join(root, "store-a");
  const manager = new JobManager({ store: new FileJobStore({ dir }) });

  const id = manager.submit(async (signal, markRunning) => {
    markRunning();
    return { ok: true };
  });
  const job = await manager.waitForCompletion(id);

  assert.equal(job.status, "completed");
  assert.deepEqual(job.result, { ok: true });
  assert.equal(manager.getJob(id).status, "completed");
});

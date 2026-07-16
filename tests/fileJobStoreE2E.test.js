import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobManager } from "../src/services/jobManager.js";
import { FileJobStore } from "../src/services/fileJobStore.js";

const root = mkdtempSync(join(tmpdir(), "claude-delegate-filejobstore-e2e-"));
after(() => rmSync(root, { recursive: true, force: true }));

test("a job abandoned mid-flight (simulated crash) is recovered as failed by a fresh JobManager+FileJobStore pair over the same directory", async () => {
  const dir = join(root, "e2e-a");
  const first = new JobManager({ store: new FileJobStore({ dir }) });

  let releaseJob;
  const stuck = new Promise((resolve) => {
    releaseJob = resolve;
  });
  const id = first.submit(async (signal, markRunning) => {
    markRunning();
    await stuck; // never resolves before the "crash" below -- simulates the process dying mid-job
    return { ok: true };
  });

  // wait for the job to actually reach "running" before simulating the crash -- bounded
  // so a real regression fails the test instead of hanging CI indefinitely
  for (let attempt = 0; first.getJob(id).status !== "running"; attempt++) {
    if (attempt >= 200) throw new Error("job never reached 'running' within 1s");
    await new Promise((r) => setTimeout(r, 5));
  }
  // "crash": no clean shutdown, no cancelJob() call -- the first JobManager is simply
  // abandoned, exactly like a killed process. releaseJob is never called.

  const second = new JobManager({ store: new FileJobStore({ dir }) });
  const recovered = second.getJob(id);

  assert.equal(recovered.status, "failed");
  assert.equal(recovered.error, "process restarted before job completed");
  releaseJob(); // let the first JobManager's dangling promise settle so the test process can exit cleanly
});

test("a job that completed before the 'crash' is still visible after restart, unchanged", async () => {
  const dir = join(root, "e2e-b");
  const first = new JobManager({ store: new FileJobStore({ dir }) });
  const id = first.submit(async (signal, markRunning) => {
    markRunning();
    return { ok: true };
  });
  await first.waitForCompletion(id);

  const second = new JobManager({ store: new FileJobStore({ dir }) });

  const recovered = second.getJob(id);
  assert.equal(recovered.status, "completed");
  assert.deepEqual(recovered.result, { ok: true });
});

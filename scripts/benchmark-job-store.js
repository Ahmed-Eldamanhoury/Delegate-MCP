import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryJobStore } from "../src/services/jobStore.js";
import { FileJobStore } from "../src/services/fileJobStore.js";
import { createJob } from "../src/models/job.js";
import { randomUUID } from "node:crypto";

const N = 200;

function bench(name, store) {
  const ids = Array.from({ length: N }, () => randomUUID());
  const start = process.hrtime.bigint();
  for (const id of ids) store.create(createJob(id));
  for (const id of ids) store.update(id, { status: "completed" });
  for (const id of ids) store.get(id);
  store.list();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`${name}: ${N} jobs, create+update+get+list in ${elapsedMs.toFixed(2)}ms (${(elapsedMs / N).toFixed(3)}ms/job avg)`);
  return elapsedMs;
}

const memMs = bench("InMemoryJobStore", new InMemoryJobStore());

const dir = mkdtempSync(join(tmpdir(), "claude-delegate-benchmark-"));
const fileMs = bench("FileJobStore", new FileJobStore({ dir }));
rmSync(dir, { recursive: true, force: true });

console.log(`FileJobStore is ${(fileMs / memMs).toFixed(1)}x the wall-clock cost of InMemoryJobStore for this workload.`);

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createEventHistoryStore } from "../src/services/eventHistoryStore.js";
import { EVENT_TYPES } from "../src/models/runtimeEvent.js";

const N = 200;

function makeEvent(jobId, i) {
  return {
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    version: 1,
    type: i === N - 1 ? EVENT_TYPES.JOB_COMPLETED : EVENT_TYPES.JOB_PROGRESS,
    jobId,
    payload: { i },
  };
}

function bench(name, store, jobId) {
  const events = Array.from({ length: N }, (_, i) => makeEvent(jobId, i));
  const start = process.hrtime.bigint();
  for (const event of events) store.append(event);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`${name}: ${N} appendFileSync calls for one job in ${elapsedMs.toFixed(2)}ms (${(elapsedMs / N).toFixed(3)}ms/event avg)`);
  return elapsedMs;
}

const dir = mkdtempSync(join(tmpdir(), "claude-delegate-eventhistory-benchmark-"));
const store = createEventHistoryStore({ dir });
const jobId = randomUUID();

const appendMs = bench("EventHistoryStore.append", store, jobId);

const readStart = process.hrtime.bigint();
const events = store.readAll(jobId);
const readMs = Number(process.hrtime.bigint() - readStart) / 1e6;
console.log(`EventHistoryStore.readAll: read back ${events.length} events in ${readMs.toFixed(2)}ms`);

rmSync(dir, { recursive: true, force: true });

console.log(`EventHistoryStore.append averaged ${(appendMs / N).toFixed(3)}ms/event of real wall-clock appendFileSync cost for this workload.`);

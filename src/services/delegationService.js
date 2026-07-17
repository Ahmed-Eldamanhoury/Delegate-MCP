import { createExecutionContext } from "../models/executionContext.js";
import { DelegateTaskInputSchema } from "../models/schemas.js";
import { toJobView, summarizeJob } from "../models/job.js";
import * as defaultClaudeCliService from "./claudeCliService.js";
import * as defaultWorkspaceManager from "./workspaceManager.js";

/**
 * The write-side counterpart to `ObservabilityService`: the single object every transport
 * adapter calls to submit, query, list, or cancel a job (`ADR-0010` Stage 1b,
 * `STAGE_1B_DESIGN_PACKAGE.md` §1). As of WP6, this is the *only* submission path — both
 * `delegate_submit` (`delegateSubmitHandler.js`) and `delegate_task`
 * (`delegateTaskHandler.js`, which still awaits the job itself via
 * `jobManager.waitForCompletion()` per its one documented exception) route through
 * `submit()` below. The transitional standalone `submitDelegation()` function this factory
 * was originally introduced "additive alongside" (WP1) has been removed now that both
 * callers have migrated (WP5/WP6), per the approved design's migration plan.
 *
 * `submit()` builds an `ExecutionContext` and submits the CLI invocation as a job —
 * `JobManager` is the only place execution state lives.
 *
 * `createJobWorkspace()` is called directly here (not via the RuntimeEventBus, unlike
 * terminal-side persistence — see workspaceEventBridge.js) because it needs the full
 * ExecutionContext, including `environment` (`process.env`). That must never be duplicated
 * into JobManager's job record: `job.metadata` is returned verbatim in `delegate_status`'s
 * MCP response, so storing raw env vars there would leak secrets through the protocol — the
 * exact leak ADR-0001's `context.json` redaction exists to prevent at the disk layer. This is
 * the one place in the pipeline that legitimately holds the unredacted context, so it's the
 * one place workspace creation is called directly rather than reconstructed from a
 * (deliberately lean) event payload or the job record.
 *
 * OutputChunk events (ADR-0002) are published through `jobManager.bus` — the same shared bus
 * JobManager itself publishes lifecycle events on — so `claudeCliService.invoke()` doesn't
 * need its own separately-wired bus reference.
 *
 * `submit()` also validates input via `DelegateTaskInputSchema.parse(input)`, which throws an
 * uncaught `ZodError` on invalid input. `getJob()`/`listJobs()` return already-shaped
 * `JobView`/`JobSummary` objects (via `toJobView`/`summarizeJob`), never a raw `Job`.
 * `listJobs()`'s `limit = 20` default is a deliberate, disclosed addition not present in
 * today's bare `delegateHistoryHandler.js` — see `STAGE_1B_DESIGN_PACKAGE.md` §1/§4/§5 for the
 * full disclosure and its non-breaking rationale for the one consumer (MCP) that exists today.
 * @param {{jobManager: import("./jobManager.js").JobManager, config: import("../config/index.js").DelegateConfig, logger?: object, service?: typeof defaultClaudeCliService, workspace?: typeof defaultWorkspaceManager}} args
 */
export function createDelegationService({
  jobManager,
  config,
  logger,
  service = defaultClaudeCliService,
  workspace = defaultWorkspaceManager,
}) {
  return Object.freeze({
    submit(input, toolName) {
      DelegateTaskInputSchema.parse(input);
      const context = createExecutionContext(input, config);
      const jobId = jobManager.submit(
        (signal, markRunning, jobId) =>
          service.invoke(input.prompt, context, config, { signal, onSpawn: markRunning, bus: jobManager.bus, jobId }),
        { tool: toolName, ...context.metadata }
      );
      workspace.createJobWorkspace(jobId, context, config, logger);
      return jobId;
    },
    getJob(jobId) {
      const job = jobManager.getJob(jobId);
      return job ? toJobView(job) : undefined;
    },
    listJobs({ status, limit = 20 } = {}) {
      let jobs = jobManager.listJobs();
      if (status) jobs = jobs.filter((j) => j.status === status);
      return jobs.slice(-limit).reverse().map(summarizeJob);
    },
    cancelJob(jobId) {
      return jobManager.cancelJob(jobId);
    },
  });
}

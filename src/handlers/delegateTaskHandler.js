import { submitDelegation } from "../services/delegationService.js";
import { forwardJobProgressToMcp } from "../services/mcpProgressAdapter.js";
import { toToolErrorContent } from "../utils/errors.js";

/**
 * External contract (tool name, schema, response shape, blocking behavior) is unchanged
 * since Sprint 1/2. Internally this submits through the shared JobManager — same path
 * delegate_submit uses — so delegate_status/history/cancel have real data to report, but
 * this handler still awaits the job before returning, exactly as before.
 *
 * ADR-0002 Phase 5: if the caller requested progress notifications (`extra._meta.progressToken`
 * present, MCP spec), this forwards the job's lifecycle events as `notifications/progress`
 * for the duration of the blocking wait — additive; a caller that never asked for progress
 * (no `extra`/`progressToken`) sees no behavior change at all.
 * @param {{config: object, logger: object, jobManager: import("../services/jobManager.js").JobManager, service?: object}} deps
 */
export function createDelegateTaskHandler({ config, logger, jobManager, service }) {
  return async function delegateTaskHandler(input, extra) {
    logger.info("delegate_task started", { model: input.model, effort: input.effort });

    const jobId = submitDelegation({ input, config, jobManager, logger, service, toolName: "delegate_task" });

    const progressToken = extra?._meta?.progressToken;
    const unsubscribeProgress =
      progressToken !== undefined && extra?.sendNotification
        ? forwardJobProgressToMcp({
            bus: jobManager.bus,
            jobId,
            progressToken,
            sendNotification: extra.sendNotification,
            logger,
          })
        : () => {};

    const job = await jobManager.waitForCompletion(jobId);
    unsubscribeProgress();

    if (job.status === "failed") {
      logger.error("delegate_task spawn failed", { message: job.error });
      return toToolErrorContent(new Error(`Failed to run claude CLI: ${job.error}`));
    }
    if (job.status === "cancelled") {
      logger.warn("delegate_task was cancelled", { jobId });
      return toToolErrorContent(new Error("Task was cancelled."));
    }

    const { raw, parsed } = job.result;
    if (!parsed) {
      logger.warn("delegate_task returned non-JSON output");
      return { content: [{ type: "text", text: raw }] };
    }

    logger.info("delegate_task finished", {
      cost: parsed.total_cost_usd,
      turns: parsed.num_turns,
      isError: Boolean(parsed.is_error),
    });

    const summary = `[model=${input.model} cost=$${parsed.total_cost_usd ?? "?"} turns=${parsed.num_turns ?? "?"}]`;
    return {
      isError: Boolean(parsed.is_error),
      content: [{ type: "text", text: `${summary}\n${parsed.result ?? raw}` }],
      structuredContent: parsed,
    };
  };
}

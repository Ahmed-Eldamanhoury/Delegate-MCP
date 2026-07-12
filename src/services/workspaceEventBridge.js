import { EVENT_TYPES } from "../models/runtimeEvent.js";
import * as defaultWorkspaceManager from "./workspaceManager.js";

const TERMINAL_EVENT_TYPES = [EVENT_TYPES.JOB_COMPLETED, EVENT_TYPES.JOB_FAILED, EVENT_TYPES.JOB_CANCELLED];

/**
 * Subscribes workspace persistence to the RuntimeEventBus (ADR-0002 Phase 4), replacing what
 * used to be a direct `.then()` call in delegationService. On any terminal event, refetches
 * the full Job via `jobManager.getJob(id)` (events carry lean payloads by design — this is
 * the "reconcile via getJob" pattern ADR-0002 establishes) and persists its artifacts, then
 * prunes old workspaces.
 *
 * `createJobWorkspace()` is deliberately NOT wired here — see delegationService.js for why
 * (it needs the unredacted ExecutionContext, which must never be duplicated into JobManager's
 * exposed job record).
 * @param {{bus: object, jobManager: import("./jobManager.js").JobManager, config: object, logger?: object, workspace?: typeof defaultWorkspaceManager}} deps
 * @returns {() => void} unsubscribe-all, for symmetry with server shutdown
 */
export function wireWorkspaceToEventBus({ bus, jobManager, config, logger, workspace = defaultWorkspaceManager }) {
  const unsubscribers = TERMINAL_EVENT_TYPES.map((type) =>
    bus.subscribe(type, (event) => {
      const job = jobManager.getJob(event.jobId);
      if (!job) return; // shouldn't happen — JobManager publishes before evicting, never after
      workspace.persistJobArtifacts(event.jobId, job, config, logger);
      workspace.pruneWorkspaces(config, logger);
    })
  );

  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

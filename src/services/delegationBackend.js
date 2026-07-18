import { JobManager } from "./jobManager.js";
import { InMemoryJobStore } from "./jobStore.js";
import { FileJobStore } from "./fileJobStore.js";
import { createRuntimeEventBus } from "./runtimeEventBus.js";
import { wireWorkspaceToEventBus } from "./workspaceEventBridge.js";
import { createObservabilityService } from "./observabilityService.js";
import { createDelegationService } from "./delegationService.js";
import { createEventHistoryStore } from "./eventHistoryStore.js";
import { wireEventHistoryToEventBus } from "./eventHistoryBridge.js";

/**
 * Picks the JobStore implementation per config.jobStore. Extracted as its own exported
 * function so it's unit-testable without constructing a full backend.
 * @param {import("../config/index.js").DelegateConfig} config
 * @param {{warn: Function}} [logger]
 * @returns {import("./jobStore.js").JobStore}
 */
export function selectJobStore(config, logger) {
  if (config.jobStore === "file") {
    return new FileJobStore({ dir: config.jobStoreDir, logger });
  }
  return new InMemoryJobStore();
}

/**
 * Constructs the single, shared `EventHistoryStore` per `config.eventHistory` (ADR-0006),
 * mirroring `selectJobStore`'s shape: extracted as its own exported function so it's
 * unit-testable without constructing a full backend. This is the ONE construction point for
 * this stateless store. `createDelegationBackend` calls this once and threads the single
 * resulting instance into both `wireEventHistoryIfEnabled` (the write-side bridge) and
 * `createObservabilityService` (ReplayEngine's durable read tier). When `config.eventHistory`
 * is unset or `"memory"` this returns `undefined` -- default behavior stays byte-identical to
 * before this feature existed.
 * @param {import("../config/index.js").DelegateConfig} config
 * @param {{warn: Function}} [logger]
 * @returns {ReturnType<typeof createEventHistoryStore>|undefined}
 */
export function selectEventHistoryStore(config, logger) {
  if (config.eventHistory !== "file") return undefined;
  return createEventHistoryStore({ dir: config.eventHistoryDir, logger });
}

/**
 * Wires an already-constructed `EventHistoryStore` into the write-side bus bridge (ADR-0006).
 * Gating happens exactly once, in `createDelegationBackend`, when deciding whether to construct
 * the store at all (`selectEventHistoryStore`) -- this function no longer checks
 * `config.eventHistory` or builds its own store; it only uses whatever `eventHistoryStore` it's
 * given, so passing `undefined` (the default-config case) is a no-op.
 * @param {{bus: object, eventHistoryStore?: ReturnType<typeof createEventHistoryStore>, config: import("../config/index.js").DelegateConfig}} deps
 * @returns {(() => void)|undefined} unsubscribe, or undefined when eventHistoryStore is undefined
 */
export function wireEventHistoryIfEnabled({ bus, eventHistoryStore, config }) {
  if (!eventHistoryStore) return undefined;
  return wireEventHistoryToEventBus({ bus, eventHistoryStore, maxFiles: config.maxEventHistoryFiles });
}

/**
 * Extract-Function refactor of `createMcpServer`'s former inline construction block
 * (WP0, REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §4) -- the transport-agnostic construction of
 * every shared, stateful piece a `DelegationService`-consuming transport adapter needs. Both
 * `createMcpServer` (stdio) and the future `restEntry.js` (REST) call this independently; each
 * call produces its own fully independent set of instances sharing no module-level state
 * (proven by `tests/delegationBackend.test.js`'s independent-instance isolation test).
 *
 * Zero new logic -- every construction step, and their relative order, is unchanged from what
 * `createMcpServer` used to do inline, just wrapped in one function call.
 *
 * `service` is an optional pass-through to `createDelegationService`'s own existing injectable
 * `service` param (defaults to the real `claudeCliService` when omitted, exactly as before this
 * parameter existed) -- added for WP5's integration tests, which need a real `createDelegationBackend()`
 * instance (not a hand-rolled equivalent) wired to a fast, deterministic stub instead of spawning
 * the real `claude` CLI binary.
 * @param {{config: import("../config/index.js").DelegateConfig, logger?: object, service?: object}} deps
 * @returns {{jobManager: JobManager, bus: ReturnType<typeof createRuntimeEventBus>, observabilityService: ReturnType<typeof createObservabilityService>, delegationService: ReturnType<typeof createDelegationService>, eventHistoryStore: ReturnType<typeof createEventHistoryStore>|undefined}}
 */
export function createDelegationBackend({ config, logger, service }) {
  const bus = createRuntimeEventBus({ logger });
  const jobManager = new JobManager({
    store: selectJobStore(config, logger),
    maxConcurrent: config.maxConcurrentJobs,
    maxHistory: config.maxJobHistory,
    logger,
    bus,
  });
  // ADR-0002 Phase 4: Workspace is a bus subscriber, not a direct call from delegationService
  // (except createJobWorkspace — see delegationService.js for why).
  wireWorkspaceToEventBus({ bus, jobManager, config, logger });

  // ADR-0006: EventHistoryStore is stateless and constructed exactly ONCE here, opt-in via
  // config.eventHistory (default "memory" = off, byte-identical to before this feature existed).
  // The single resulting instance is shared by both ObservabilityService's ReplayEngine durable
  // tier (below) and the write-side bridge (wireEventHistoryIfEnabled, further below).
  const eventHistoryStore = selectEventHistoryStore(config, logger);

  const observabilityService = createObservabilityService({
    bus,
    config,
    logger,
    maxTimelineHistory: config.maxJobHistory,
    eventHistoryStore,
  });

  wireEventHistoryIfEnabled({ bus, eventHistoryStore, config });

  // ADR-0010 Stage 1b: the single DelegationService instance every transport adapter's handler
  // routes through (submit/getJob/listJobs/cancelJob). `service: undefined` (the default here
  // when no override is passed) triggers createDelegationService's own default parameter,
  // exactly as if this argument were omitted entirely -- production behavior is unchanged.
  const delegationService = createDelegationService({ jobManager, config, logger, service });

  return { jobManager, bus, observabilityService, delegationService, eventHistoryStore };
}

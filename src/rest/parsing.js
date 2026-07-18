import { DEFAULT_MAX_JOB_HISTORY } from "../config/index.js";
import { JOB_STATUS } from "../models/job.js";
import { EVENT_TYPES } from "../models/runtimeEvent.js";

const VALID_STATUSES = new Set(Object.values(JOB_STATUS));
const VALID_EVENT_TYPES = new Set(Object.values(EVENT_TYPES));

/** Thrown by parseListQuery/parseTimelineQuery on an unrecognized/malformed query param value. */
export class InvalidQueryParamError extends Error {}

/**
 * `MAX_LIST_LIMIT` value (500) is pinned by REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §17: tied to
 * the store's own existing history cap rather than an invented number. The reject-vs-clamp
 * choice for an oversized `limit` was left open there ("decided at Stage 2 implementation-plan
 * time") -- resolved here, during implementation, as clamp rather than reject: `listJobs()` can
 * never usefully return more than `maxJobHistory` jobs anyway, so silently capping costs a caller
 * nothing a rejection would have prevented (see below).
 */
export const MAX_LIST_LIMIT = DEFAULT_MAX_JOB_HISTORY;

/**
 * Extracts the raw `:id` path segment as a plain string -- performs NO validation of any kind.
 * All job-id-shape validation lives in exactly one place, DelegationService's isValidJobId()
 * guard, so a malformed id reaches the service layer exactly like an unknown one and gets 404
 * JOB_NOT_FOUND, never a 400 here (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §8).
 * @param {string} rawSegment
 * @returns {string}
 */
export function parseJobIdParam(rawSegment) {
  return rawSegment;
}

/**
 * Parses/validates `GET /v1/jobs?status=&limit=`'s query params for
 * `delegationService.listJobs({status, limit})`. A present-but-invalid `status`/`limit` throws
 * InvalidQueryParamError (mapped to 400 INVALID_QUERY_PARAM by the caller); an absent param
 * resolves to `undefined`, letting `listJobs()`'s own default (20) apply.
 * @param {URLSearchParams} searchParams
 * @returns {{status: string|undefined, limit: number|undefined}}
 */
export function parseListQuery(searchParams) {
  const rawStatus = searchParams.get("status");
  let status;
  if (rawStatus !== null) {
    if (!VALID_STATUSES.has(rawStatus)) {
      throw new InvalidQueryParamError(`Invalid status: ${rawStatus}`);
    }
    status = rawStatus;
  }

  const rawLimit = searchParams.get("limit");
  let limit;
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) {
      throw new InvalidQueryParamError(`Invalid limit: ${rawLimit}`);
    }
    limit = Math.min(Number(rawLimit), MAX_LIST_LIMIT);
  }

  return { status, limit };
}

/**
 * Parses/validates `GET /v1/jobs/:id/timeline?type=&since=`'s query params for
 * `observabilityService.getTimeline(id, {type, since})`. `type` is validated against the known
 * EVENT_TYPES enum; `since` is passed through unchanged (TimelineStore's own filtering is a plain
 * ISO-8601 lexicographic string comparison, needing no parsing here).
 * @param {URLSearchParams} searchParams
 * @returns {{type: string|undefined, since: string|undefined}}
 */
export function parseTimelineQuery(searchParams) {
  const rawType = searchParams.get("type");
  let type;
  if (rawType !== null) {
    if (!VALID_EVENT_TYPES.has(rawType)) {
      throw new InvalidQueryParamError(`Invalid type: ${rawType}`);
    }
    type = rawType;
  }

  const since = searchParams.get("since") ?? undefined;

  return { type, since };
}

import { ZodError } from "zod";
import { InvalidQueryParamError } from "./parsing.js";

/** Thrown by bodyLimit.js when a request body exceeds the configured byte limit. */
export class PayloadTooLargeError extends Error {}

/** Thrown by a route handler when a request body fails JSON.parse. */
export class MalformedBodyError extends Error {}

/**
 * REST's error-mapping layer (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §9) -- the ONE place that
 * maps a thrown exception to {status, body}. `logger` is an explicit constructor dependency (the
 * 500 branch logs server-side), so `createErrorMapper({logger})` returns the mapping function
 * rather than assuming an ambient global. REST's `toToolErrorContent()` analog: never leaks
 * `err.message`/`err.stack` over the wire for an unrecognized error.
 * @param {{logger: {error: Function}}} deps
 */
export function createErrorMapper({ logger }) {
  return function toHttpError(err) {
    if (err instanceof PayloadTooLargeError) {
      return { status: 413, body: { error: { code: "PAYLOAD_TOO_LARGE", message: err.message } } };
    }
    if (err instanceof MalformedBodyError) {
      return { status: 400, body: { error: { code: "MALFORMED_BODY", message: "Request body is not valid JSON" } } };
    }
    if (err instanceof InvalidQueryParamError) {
      return { status: 400, body: { error: { code: "INVALID_QUERY_PARAM", message: err.message } } };
    }
    if (err instanceof ZodError) {
      return { status: 400, body: { error: { code: "INVALID_INPUT", message: "Invalid request body", details: err.issues } } };
    }
    logger.error("unhandled REST error", { message: err.message, stack: err.stack }); // server-side only
    return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "An internal error occurred" } } };
  };
}

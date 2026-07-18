import { PayloadTooLargeError } from "./errors.js";

/**
 * Pure, header-based pre-check (no I/O): does `req`'s `Content-Length` header, if present, fit
 * within `maxBytes`? An absent header returns `true` -- it's not a lie to the caller, only a
 * signal that the streaming guard (`streamBoundedBody`) is the one actually enforcing the bound
 * for that request (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §8).
 * @param {{headers: {"content-length"?: string}}} req
 * @param {number} maxBytes
 * @returns {boolean}
 */
export function checkContentLengthLimit(req, maxBytes) {
  const raw = req.headers["content-length"];
  if (raw === undefined) return true;
  return Number(raw) <= maxBytes;
}

/**
 * Attaches a byte-counting guard to `req`'s body stream. Resolves with the full accumulated
 * `Buffer` once the body ends; rejects with `PayloadTooLargeError` and destroys `req.socket` the
 * instant accumulated bytes cross `maxBytes`, so a chunked-encoded or `Content-Length`-understated
 * body can never exceed the bound, and no keep-alive reuse is possible after the reject.
 * Called only by routes that actually read a request body -- as of WP4, exactly
 * `routes/jobs.js`'s `handleSubmit` (`POST /v1/jobs`); every other route never touches the body
 * stream at all (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §8 -- refined during WP4 from an earlier
 * "attached to every request" framing once a real body-consuming route existed to reason about).
 * @param {import("node:http").IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
export function streamBoundedBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const onData = (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
        req.removeListener("error", onError);
        req.socket?.destroy();
        reject(new PayloadTooLargeError(`Request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      resolve(Buffer.concat(chunks));
    };
    const onError = (err) => {
      if (settled) return;
      reject(err);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

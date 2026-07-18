import { createServer } from "node:http";
import { matchRoute } from "./router.js";
import { checkBearerToken } from "./auth.js";
import { checkContentLengthLimit } from "./bodyLimit.js";
import { createErrorMapper } from "./errors.js";
import { isDashboardRequest, serveDashboard } from "./dashboard.js";

function sendJson(res, status, body, headers = {}) {
  // Build the payload BEFORE writeHead() -- if JSON.stringify() throws (e.g. a circular
  // reference in a handler's result), no headers have been sent yet, so the caller's own
  // .catch() can still safely call sendJson() again for the mapped error response, instead of
  // hitting ERR_HTTP_HEADERS_SENT on a response already half-written.
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(payload);
}

/**
 * Owns the raw `http.Server`, the inline route table, and the request pipeline: body-size
 * Content-Length gate -> auth check -> route match -> handler -> error mapping -> response
 * (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §2/§8). Zero business logic -- every branch either
 * rejects with a fixed HTTP error or calls exactly one handler.
 *
 * `routes` defaults to empty -- WP2 registered zero real routes; WP3/WP4 pass the real route table
 * in (assembled by `restEntry.js`'s `buildRouteTable`). `streamBoundedBody` (the per-request
 * body-streaming guard) is deliberately NOT wired here, universally, for every request: only
 * `POST /v1/jobs` (`routes/jobs.js`'s `handleSubmit`) ever reads a request body, so only it calls
 * `streamBoundedBody` itself, scoped to exactly the request that needs it -- every other route
 * never attaches to the body stream at all, so there is no teardown-after-response mechanism to
 * build (refined during WP4 from an earlier "universal guard, torn down after response" framing,
 * once a real body-consuming route existed to reason about -- see §8). The synchronous
 * Content-Length gate below still bounds every request regardless of route, satisfying WP2's own
 * "413 before any route logic runs" acceptance criterion.
 * @param {{backend: object, config: import("../config/index.js").DelegateConfig, logger: object, token: string, routes?: {method: string, path: string, handler: Function}[]}} deps
 * @returns {{server: import("node:http").Server, close: () => Promise<void>}}
 */
export function createRestServer({ backend, config, logger, token, routes = [] }) {
  const toHttpError = createErrorMapper({ logger });

  const server = createServer((req, res) => {
    // Dashboard static files are served BEFORE the auth gate -- intentionally unauthenticated
    // because they expose no confidential information (ADR-0012 §8, WP0 LOW-1 fix).
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (isDashboardRequest(url.pathname)) {
      serveDashboard(req, res, config);
      return;
    }

    if (!checkContentLengthLimit(req, config.restMaxBodyBytes)) {
      // "Connection: close" (not an immediate req.socket.destroy()) -- the socket must stay open
      // long enough to flush this very response; Node closes it once the response is fully
      // written, giving "no keep-alive reuse after a 413" without racing the write itself.
      res.setHeader("Connection", "close");
      sendJson(res, 413, {
        error: { code: "PAYLOAD_TOO_LARGE", message: `Request body exceeds ${config.restMaxBodyBytes} bytes` },
      });
      return;
    }

    if (!checkBearerToken(req, token)) {
      sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "Missing or invalid bearer token" } });
      return;
    }

    const matched = matchRoute(req.method, url.pathname, routes);
    if (matched.status === "not-found") {
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "No such route" } });
      return;
    }

    Promise.resolve()
      .then(() => matched.handler({ req, res, params: matched.params, url, backend, config, logger }))
      .then((result) => sendJson(res, result.status, result.body, result.headers))
      .catch((err) => {
        const mapped = toHttpError(err);
        sendJson(res, mapped.status, mapped.body);
      });
  });

  return {
    server,
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections(); // Node >=18.2 builtin -- closes keep-alives that are idle right now, §10
      await closed;
    },
  };
}

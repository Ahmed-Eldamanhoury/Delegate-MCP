import { createReadStream, existsSync, statSync } from "node:fs";
import { join, resolve, extname, sep } from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

function mimeFor(filePath) {
  return MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Returns true when the pathname belongs to the dashboard prefix.
 * Must be checked BEFORE the auth gate — dashboard routes are intentionally unauthenticated
 * (ADR-0012 §8 LOW-1 fix: they expose no confidential information).
 * @param {string} pathname
 * @returns {boolean}
 */
export function isDashboardRequest(pathname) {
  return pathname === "/dashboard" || pathname === "/dashboard/" || pathname.startsWith("/dashboard/");
}

/**
 * Serves GET /dashboard/* requests (ADR-0012 WP0).
 *
 * Route table:
 *   GET /dashboard/config.js  — dynamically generated JS stub with window.__DELEGATE_REST__
 *   GET /dashboard            — serves dashboardDir/index.html
 *   GET /dashboard/           — serves dashboardDir/index.html
 *   GET /dashboard/<path>     — serves dashboardDir/<path> as a static file
 *
 * Path-traversal safety: the resolved absolute path must be a child of dashboardDir.
 * If dashboardDir does not exist or the file is missing, responds 404 — graceful for the
 * "dashboard not built yet" state.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {import("../config/index.js").DelegateConfig} config
 */
export function serveDashboard(req, res, config) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // Dynamically generated config stub — never read from disk, always fresh.
  if (pathname === "/dashboard/config.js") {
    const body = `window.__DELEGATE_REST__ = "http://${config.restHost}:${config.restPort}";\n`;
    res.writeHead(200, {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(body);
    return;
  }

  // /dashboard and /dashboard/ both serve the SPA entry point.
  const relative =
    pathname === "/dashboard" || pathname === "/dashboard/" ? "index.html" : pathname.slice("/dashboard/".length);

  const dashboardDir = resolve(config.dashboardDir);
  const filePath = resolve(join(dashboardDir, relative));

  // Path-traversal guard: reject anything that escapes dashboardDir.
  if (!filePath.startsWith(dashboardDir + sep)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } }));
    return;
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Dashboard file not found" } }));
    return;
  }

  const stat = statSync(filePath);
  if (!stat.isFile()) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not a file" } }));
    return;
  }

  res.writeHead(200, { "Content-Type": mimeFor(filePath), "Content-Length": stat.size });
  createReadStream(filePath).pipe(res);
}

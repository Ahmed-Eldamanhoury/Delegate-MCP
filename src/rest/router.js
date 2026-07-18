/**
 * Minimal, hand-rolled `:id`-param matcher (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §1/§2) --
 * pure pattern match, no I/O, no router library/framework dependency (`ADR-0011` pins Node's
 * built-in `http` module only).
 * @param {string} method
 * @param {string} pathname
 * @param {{method: string, path: string, handler: unknown}[]} table
 * @returns {{status: "not-found"} | {handler: unknown, params: Record<string, string>}}
 */
export function matchRoute(method, pathname, table) {
  const pathSegments = pathname.split("/").filter(Boolean);

  for (const route of table) {
    if (route.method !== method) continue;

    const routeSegments = route.path.split("/").filter(Boolean);
    if (routeSegments.length !== pathSegments.length) continue;

    const params = {};
    let matched = true;
    for (let i = 0; i < routeSegments.length; i++) {
      const routeSegment = routeSegments[i];
      if (routeSegment.startsWith(":")) {
        params[routeSegment.slice(1)] = pathSegments[i];
      } else if (routeSegment !== pathSegments[i]) {
        matched = false;
        break;
      }
    }

    if (matched) return { handler: route.handler, params };
  }

  return { status: "not-found" };
}

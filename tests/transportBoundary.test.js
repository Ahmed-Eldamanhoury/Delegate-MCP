import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ADR-0010 Stage 1b structural boundary (STAGE_1B_DESIGN_PACKAGE.md §4 acceptance criterion 3,
// ADR-0010_REVIEW_PACKAGE.md §10.4): every write-side MCP handler depends on DelegationService
// only, never JobManager directly, except delegateTaskHandler.js's one documented exception
// (jobManager.waitForCompletion()/.bus, its frozen synchronous contract). This is the direct
// write-side analog of how OBSERVABILITY_FREEZE.md's Passive Observation Rule is verified
// structurally (Object.keys(observability) contains no mutator) -- a real, CI-gateable check.
//
// This project's handlers receive their dependencies via constructor parameters (dependency
// injection), never a static `import` of a service singleton -- confirmed by reading every
// handler: none of the 5 write-side handlers statically imports jobManager.js or
// delegationService.js, and delegateTaskHandler.js's only service-adjacent import is
// mcpProgressAdapter.js (progress forwarding, its own documented MCP-specific concern). So the
// real coupling vector to check is the handler factory's own destructured parameter list, not
// just `import` statements -- checking only imports (as originally sketched) would never catch a
// regression in this codebase's DI style, since jobManager was never imported as a module here.

const WRITE_SIDE_HANDLERS = {
  "delegateStatusHandler.js": { factory: "createDelegateStatusHandler", allowJobManager: false },
  "delegateHistoryHandler.js": { factory: "createDelegateHistoryHandler", allowJobManager: false },
  "delegateCancelHandler.js": { factory: "createDelegateCancelHandler", allowJobManager: false },
  "delegateSubmitHandler.js": { factory: "createDelegateSubmitHandler", allowJobManager: false },
  "delegateTaskHandler.js": { factory: "createDelegateTaskHandler", allowJobManager: true }, // documented exception
};

function factoryParams(source, factoryName) {
  const match = source.match(new RegExp(`export function ${factoryName}\\(\\{([^}]*)\\}\\)`));
  assert.ok(match, `expected to find "export function ${factoryName}({ ... })" in the handler source`);
  return match[1]
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

for (const [file, { factory, allowJobManager }] of Object.entries(WRITE_SIDE_HANDLERS)) {
  test(
    `${file}: depends on DelegationService, ${
      allowJobManager ? "keeps its documented jobManager exception" : "never JobManager directly"
    }`,
    () => {
      const source = readFileSync(`src/handlers/${file}`, "utf8");

      // (a) no static import of a service module this handler shouldn't touch, or the raw Job
      // model -- DelegationService already returns shaped JobView/JobSummary objects.
      const serviceImports = [...source.matchAll(/from\s+["']\.\.\/services\/([\w.]+)["']/g)].map((m) => m[1]);
      const modelImports = [...source.matchAll(/from\s+["']\.\.\/models\/([\w.]+)["']/g)].map((m) => m[1]);
      assert.ok(!serviceImports.includes("jobManager.js"), `${file} must not statically import jobManager.js`);
      assert.ok(
        !serviceImports.includes("delegationService.js"),
        `${file} must not statically import delegationService.js -- it's injected, not imported`
      );
      assert.ok(
        !modelImports.includes("job.js"),
        `${file} must not import src/models/job.js directly -- DelegationService already shapes the view`
      );

      // (b) the factory's own parameter list -- the real coupling vector in this DI-style codebase.
      const params = factoryParams(source, factory);
      assert.ok(
        params.includes("delegationService"),
        `${file}'s ${factory} must accept a delegationService dependency`
      );
      assert.equal(
        params.includes("jobManager"),
        allowJobManager,
        allowJobManager
          ? `${file} is expected to keep its documented jobManager exception (waitForCompletion/.bus)`
          : `${file} must not accept jobManager directly -- route through delegationService instead`
      );
    }
  );
}

// WP5 (REST_STAGE_1B_IMPLEMENTATION_DESIGN.md §11 Transport Boundaries): "REST never imports
// JobManager, RuntimeEventBus, or FileJobStore directly in any routes/*.js file -- only
// backend.delegationService/backend.observabilityService, injected." Extends this file's existing
// import-boundary-checking pattern to src/rest/routes/*.js, the REST-side analog of the MCP check
// above.

const FORBIDDEN_SERVICE_IMPORTS = ["jobManager.js", "runtimeEventBus.js", "fileJobStore.js"];

const REST_ROUTE_FILES = {
  "jobs.js": { factory: "createJobRoutes", requiredParam: "delegationService" },
  "observability.js": { factory: "createObservabilityRoutes", requiredParam: "observabilityService" },
  "models.js": { factory: "createModelsRoute", requiredParam: "config" },
};

for (const [file, { factory, requiredParam }] of Object.entries(REST_ROUTE_FILES)) {
  test(`src/rest/routes/${file}: never imports JobManager/RuntimeEventBus/FileJobStore directly -- only ${requiredParam}, injected`, () => {
    const source = readFileSync(`src/rest/routes/${file}`, "utf8");

    const serviceImports = [...source.matchAll(/from\s+["'][./]+services\/([\w.]+)["']/g)].map((m) => m[1]);
    for (const forbidden of FORBIDDEN_SERVICE_IMPORTS) {
      assert.ok(!serviceImports.includes(forbidden), `${file} must not statically import ${forbidden}`);
    }

    const params = factoryParams(source, factory);
    assert.ok(params.includes(requiredParam), `${file}'s ${factory} must accept a ${requiredParam} dependency`);
  });
}

# ADR-0004: Server Instance Lifecycle

## Status
**Recommended fix implemented (2.2.2), live-host verification still pending.** This ADR
originally documented a confirmed root-cause investigation into the job-tracking-loss
defect recorded in the prior sprint's [SPRINT_REPORT.md](../../SPRINT_REPORT.md) ("The
Central Failure: Concurrent MCP Dispatch Broke Job Tracking") with no code change, per
that sprint's explicit operating rule. The Dogfooding Sprint that produced
`docs/superpowers/plans/dogfooding-stdin-shutdown.md` implemented the Decision below —
`stdin`-close routed through `registerShutdownHandlers()` in `src/cli/entry.js` — and
verified it with unit tests against injected fakes (`tests/entry.test.js`) plus an
MCP-Inspector check that production startup is unaffected. What remains open, unchanged
from the original Decision: verifying this actually fires against a real MCP host's
(Claude Desktop's) disconnect behavior was and still is out of scope — that verification
requires deliberately disrupting a live session, not something to do incidentally. See
`docs/releases/KNOWN_LIMITATIONS.md` for the current status of that gap.

## Context
The prior sprint observed two concurrent `node.exe` processes both running
`claude-delegate-mcp\server.js` (PIDs 9868 and 32788), each holding its own in-memory
`JobManager`, silently splitting job state: a job created against one instance was
invisible to a `delegate_status`/`delegate_history` call that happened to land on the
other. By the time that report was written, only one instance remained running, pointing
to a **stale/orphaned process** (e.g., left over from a prior Claude Desktop restart that
didn't terminate its old MCP server child) rather than a defect that reproduces on every
launch.

This investigation confirms, via direct code reading, two facts that together explain both
why that can happen and why it is not simply "fix concurrency":

- **No startup guard exists.** `src/cli/entry.js` has no lockfile, PID file, or port-bind
  check anywhere in its startup path (`main()`, lines 9–32). Nothing prevents a second
  `server.js` process from starting while a live one is still running. The only lifecycle
  hooks present are the `shutdown()` closure (lines 20–26) and its `SIGINT`/`SIGTERM`
  registrations (lines 27–28), which run `server.close()` and then `process.exit(0)` — but
  only in response to an externally delivered signal.
- **The MCP SDK's stdio transport has no self-detection for "my client disconnected."**
  Reading `node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js` directly:
  `StdioServerTransport.start()` (lines 26–33) registers exactly two listeners on
  `this._stdin` — `"data"` (line 31) and `"error"` (line 32) — and nothing else. There is no
  `"end"` or `"close"` listener registered on `stdin` anywhere in the file, and `close()`
  (lines 48–62) never calls `process.exit()` on its own; it only removes the transport's own
  listeners, conditionally pauses `stdin`, and invokes the `onclose` callback — it is a
  method the *caller* invokes, not something the transport triggers itself when its input
  pipe ends.

Because the transport is `stdio`, the process model is inherently a 1:1 parent-child pipe:
each legitimate concurrent Claude Desktop window/session spawning its own `server.js`
instance is normal, correct, intended multi-client operation — not a bug. Each instance only
ever needs to track its own jobs. The actual defect is narrower and different from "more
than one instance exists": it is **stale, orphaned instances that should have exited when
their client disconnected but never received a signal telling them to**, because nothing in
the stack — not the SDK transport, not `entry.js` — currently converts "my stdin pipe ended"
into a shutdown trigger. An orphaned instance sits alive indefinitely, still holding its own
`JobManager`, and requests that reach the wrong live instance are a form of the same
underlying symptom (job state silently split across processes) regardless of whether the
extra process is legitimate-but-different-window or truly orphaned.

## Decision
No code change in this sprint.

The recommended fix for a future wave is: detect the server's **own** `stdin` ending
(`process.stdin.on("end", ...)` or `"close"`) in `src/cli/entry.js` and route it through the
same `shutdown()` closure that `SIGINT`/`SIGTERM` already use (lines 20–28). This only
causes an instance whose own client has actually disconnected to exit; it has no effect on
any other, still-connected concurrently-running instance, so it does not regress legitimate
multi-window usage.

This is not implemented now because correctness depends on unverified host behavior:
whether Claude Desktop (the actual MCP host) ever lets `server.js`'s stdin pipe end without
also forcefully terminating the process outright, and whether Windows' signal-delivery model
— Node's `SIGTERM` support on Windows is documented as limited compared to POSIX — already
causes `shutdown()` to silently never fire on that path today. Verifying this with certainty
would require deliberately killing/restarting the live MCP connection this very session
depends on, which is a live-session-disrupting experiment that should be deliberately
scheduled, not done incidentally mid-sprint. Implementing a stdin-close-based shutdown
without that verification risks getting server lifecycle semantics subtly wrong — a wrong
"fix" here is worse than the current, documented status quo, which is this sprint's explicit
standard for when to stop at an ADR instead of shipping code.

## Alternatives considered
- **Global single-instance lockfile/PID check** (refuse a second `server.js` from starting
  at all): rejected as likely wrong, not merely "not the safest option." `stdio` transport
  concurrency is intentional — each Claude Desktop window/session is expected to run its own
  instance — so a global lock would block legitimate concurrent multi-window usage, a real
  regression, in order to guard against a narrower problem (stale instances) that a lock
  does not actually target correctly.
- **Liveness-checked PID file** (a middle ground: record the PID on startup, and a new
  instance checks whether the recorded PID is still alive before deciding whether to
  proceed): unlike a naive global lock, this only reaps genuinely *dead* PIDs and would
  not block legitimate concurrent live windows. Not pursued in this ADR because it still
  requires the same unverified assumption the Decision above is deferring on — reliably
  detecting "is that PID still my old server" cross-platform (especially PID reuse by
  the OS) is its own source of subtle bugs, and `stdin`-close self-shutdown is the more
  direct fix for the actual defect (an orphan that should have exited) rather than a
  workaround for one that didn't.
- **`stdin`-close self-shutdown** (reusing `shutdown()`): recommended as the leading
  candidate for a future wave, pending verification of actual Claude Desktop / MCP-host
  child-process lifecycle behavior on Windows, per Decision above.
- **Do nothing**: rejected. The underlying job-tracking-loss defect documented in the prior
  sprint's `SPRINT_REPORT.md` remains real, even though it is narrowly scoped and currently
  mitigated operationally (avoid batching `delegate_*` calls in one message).

## Consequences
The known limitation stays open and documented, not silently dropped: nothing in the current
architecture prevents a stale/orphaned `server.js` instance from continuing to run and
splitting job state from a live one. The existing operating mitigation remains in force —
avoid concurrent/batched `delegate_*` MCP calls in a single message; issue them one at a
time, per the workaround verified in `SPRINT_REPORT.md`. A future wave must first run the
deliberately scheduled host-behavior verification described in Decision, then implement the
`stdin`-close self-shutdown fix with its own dedicated test/review cycle — this ADR does not
authorize implementing it without that verification step.

## Compatibility impact
None. This ADR makes no code change; it records an investigation and a decision to defer.

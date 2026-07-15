# Lessons Learned — Dogfooding Sprint (2026-07-15)

Forward-looking only — what would change next time. See `SPRINT_REPORT.md` for what
happened, `DOGFOODING_REPORT.md`/`DOGFOODING_DECISION.md` for the Delegate MCP
evaluation.

## About this codebase

1. **Resuming uncommitted work from a prior session should be verified end-to-end before
   trusting it, not just read.** The prior session's code (extraction + tests) *looked*
   complete and matched the plan exactly — but nobody had actually run `npm test` against
   it before this sprint. Reading a diff is not the same as running it. The bug that
   blocked this sprint would have been caught immediately by anyone running the tests the
   prior session had already written; it sat there uncommitted for the length of a full
   session boundary.
2. **The `import.meta.url === process.argv[1]` entrypoint-detection idiom is not safe to
   assume in any codebase with a wrapper entrypoint script.** Any repo where a thin
   `server.js`/`main.js`/`index.js` re-exports the real implementation module breaks this
   check silently — `process.argv[1]` is always the wrapper's path. Worth a quick check
   before reaching for this idiom anywhere else in this project.
3. **A hung test process on Windows leaves real orphaned `node.exe` processes behind, and
   the shell wrapper's own timeout does not clean them up.** This happened twice this
   sprint (once from the buggy code, once deliberately while re-verifying RED). Killing
   the wrapper (`timeout N cmd`, a Bash tool's own timeout) is not sufficient — the actual
   child process needs to be found (`Get-CimInstance Win32_Process` by command line) and
   killed separately. Worth remembering as a standard cleanup step whenever a Node test
   run is force-terminated on this platform.

## About using Delegate MCP

4. **Read the structured job result, not just the summary text, before calling a
   `delegate_*` job "clean."** This sprint's tool-permission finding
   (`permission_denials`) was sitting in the JSON `delegate_status` returns, not in the
   plain-language result text. A quick glance at the prose alone would have missed it.
5. **Four sprints running, the implementer role has never actually been tried via
   `delegate_task`/`delegate_submit`.** Each time, the choice to use the native `Agent`
   tool instead was individually reasonable (short mechanical task, needed the
   `subagent-driven-development` brief/report machinery, etc.) — but the aggregate effect
   is that the sprint's central question ("can Delegate MCP be the primary development
   environment") keeps getting answered for research tasks and never for the actual
   development work the question is really about. Next sprint should deliberately force
   this comparison rather than let a fifth reasonable-in-isolation default happen again.
6. **Don't fabricate an event that didn't happen, even under time pressure.** Mid-sprint,
   there was an instruction to "record that the reviewer timed out" — but no reviewer had
   actually been dispatched yet at that point. The honest record ("no reviewer was
   launched; the controller substituted independent verification instead") took the same
   amount of effort as the inaccurate one and kept the sprint's evidence trail trustworthy.

## About process

7. **A pre-flight scan for conflicts between a plan and its own global constraints is
   cheap and worth doing even on a two-task plan.** Nothing was found this sprint, but the
   check itself took under a minute and would have caught a real problem if the amended
   plan had introduced one.
8. **Folding a near-empty "Task 1" into "Task 0" rather than dispatching a second
   implementer/reviewer pair for it was the right call** — Task 1 had nothing left to do
   except run a command Task 0 already needed to run. Right-sizing tasks against what
   actually remains, not against the plan document's original task boundaries, avoided a
   wasted subagent round-trip.
9. **A worktree lock's PID should be checked before unlocking, not assumed stale.** This
   sprint's worktree was locked under a PID that turned out to be this very session's own
   shell — safe to unlock — but the check (`Get-Process -Id`) took one call and is the
   difference between a safe unlock and potentially disrupting a genuinely live, separate
   session.

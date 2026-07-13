# Release Integrity Report — v2.0.0 tag repair

Scope: repair release metadata only. No code, tests, ADRs, or documentation content were
changed in this wave.

## Previous tag

`v2.0.0` → commit `f7fe5a7cd48d783308309f02702eba9853cca044` ("Merge remote's initial
placeholder commit"), tag object `18847c6975dc90a691d69e2ae4d47d86f4063d5d`.

## Correct tag

`v2.0.0` → commit `9c8506e1a95cbefaad0230681e217d3b388f54a0` ("Fix the real root cause of the
flaky pruneWorkspaces test (not just its timeout)"), tag object
`8caebc0b92387e177414424e20154c095f09e41a`. Same annotation message as the original tag,
verbatim — release notes were not changed, only the commit the tag points to.

## Commit IDs

| Ref | Commit | Note |
|---|---|---|
| `main` / HEAD (certified) | `9c8506e` | 145/145 tests, CI green |
| `v2.0.0` (before repair) | `f7fe5a7` | 2 commits behind `main` |
| `v2.0.0` (after repair) | `9c8506e` | matches `main` exactly |

## Reason

The `v2.0.0` tag was originally created immediately after merging the GitHub repo's placeholder
initial commit, before two real bugfixes were discovered and merged in the very next wave (via
the repository's first actual CI run):

- `28448da` — fixed `DEFAULT_BIN` resolving to an empty string on non-Windows (broke
  `validateConfig()` outside Windows).
- `9c8506e` — fixed the actual root cause of a flaky `pruneWorkspaces` test (a test-isolation
  defect), not just its symptom.

This was already identified and logged as a low-severity finding during a separate Self-Harness
validation pass (workspace `delegate-mcp-validation`, failure id
`01KXE18YXDNMAC2PC8G389RE9G`) before this repair wave. This report is the remediation of that
finding.

## What was missing from the old tag

Installing from the old `v2.0.0` tag specifically (rather than `main`) would have reproduced
both bugs above — verified in that same validation pass via a real reproduction on Linux (WSL
Ubuntu 24.04) before the fix, and 4 consecutive clean runs after it.

## Repair actions taken

1. `git tag -d v2.0.0` (local) — removed the tag pointing at `f7fe5a7`.
2. `git push origin --delete v2.0.0` — removed the same tag from the remote.
3. `git tag -a v2.0.0 -m "<original message, verbatim>" 9c8506e1a95cbefaad0230681e217d3b388f54a0`
   — recreated as an annotated tag on the certified commit.
4. `git push origin v2.0.0` — pushed the corrected tag.

No GitHub Release existed referencing the old tag (verified via `gh release list` — empty both
before and after this repair), so Phase 4's release-update step did not apply.

## Validation (Phase 5)

| Check | Result |
|---|---|
| `git describe --tags` | `v2.0.0` (exact — HEAD is the tag, no `-N-g<hash>` suffix) |
| `git rev-list -n 1 v2.0.0` | `9c8506e...` (matches `main`) |
| `git log` (top of `main`) | `9c8506e` unchanged throughout this repair |
| Local vs. remote tag object | Identical (`8caebc0...` both sides) |
| Tag dereferences to | `9c8506e1a95cbefaad0230681e217d3b388f54a0` |
| GitHub Release | None exists — nothing to update |
| GitHub tag (`ls-remote`) | `8caebc0...` → `9c8506e` |
| CI on the corrected commit/tag push | `success` |
| Inspector `tools/list` | 6/6 tools, unchanged |
| Test suite | 145/145 passing |

Everything — `main`, `HEAD`, the local tag, the remote tag, CI, Inspector, and the test suite —
now references the same commit: `9c8506e1a95cbefaad0230681e217d3b388f54a0`.

## Final state

`v2.0.0` is an annotated tag on `main`'s current tip, identical release-notes content to the
original tag, verified consistent locally and on GitHub. Release integrity: **restored**.

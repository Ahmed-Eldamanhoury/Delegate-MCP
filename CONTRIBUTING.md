# Contributing

`claude-delegate-mcp` is a single-maintainer open-source project
([repository](https://github.com/Ahmed-Eldamanhoury/Delegate-MCP)). External contributions are
welcome via pull request, but note there is currently no CI configured — reviews are manual.

## Before you start

1. Read [docs/FOUNDATION_FREEZE.md](docs/FOUNDATION_FREEZE.md) and
   [docs/OBSERVABILITY_FREEZE.md](docs/OBSERVABILITY_FREEZE.md) first — they define what's
   frozen and why. A change that would break a documented guarantee needs an ADR
   (`docs/adr/`), not just a code change; open an issue to discuss first if you're unsure.
2. `npm install` then `npm test` — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#development)
   for the test conventions used in this codebase (`node:test`, no external framework, no
   network/CLI login required to run the suite).

## Making a change

1. Run `npm test` before and after your change — the full suite must pass.
2. Update `CHANGELOG.md` for any user-visible change, following the existing entry format.
3. If you touch a frozen contract (the 9 MCP tools' schemas, the job lifecycle,
   `ExecutionContext`, `RuntimeEventBus`, or `ObservabilityService`'s public methods), explain
   why in the PR description and reference the relevant ADR or freeze document.
4. Open a pull request. Keep it scoped — this project has deliberately avoided speculative
   abstractions and premature generalization; new code should follow that same discipline.

## License

By submitting a pull request you agree that your contribution is licensed under the
[Apache License, Version 2.0](LICENSE) — the same license as this project.

## Reporting bugs / requesting features

Use the GitHub [issue templates](https://github.com/Ahmed-Eldamanhoury/Delegate-MCP/issues/new/choose).
For security issues, see [SECURITY.md](SECURITY.md) instead — do not open a public issue for those.

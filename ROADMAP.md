# Roadmap

Full detail: [docs/releases/ROADMAP_v1.1.md](docs/releases/ROADMAP_v1.1.md). Summary below —
none of this is implemented; each item still needs its own ADR before any code is written,
per this project's established discipline.

All future consumers depend only on `ObservabilityService` — never on `RuntimeEventBus`
directly ([ADR-0003](docs/adr/ADR-0003-observability-architecture.md)).

- **Dashboard** — a UI polling `getSnapshot()`/`getTimeline()`. No transport decided.
- **REST API** — HTTP endpoints over `ObservabilityService`'s methods. Framework deliberately
  undecided (a new dependency is a real decision, not a default).
- **Plugin SDK** — no design beyond "plugins depend only on `ObservabilityService`" yet.
- **VS Code Extension** — in-process `require` or an HTTP bridge, depending on what else ships first.
- **Prometheus Exporter** — a scrape endpoint over `getMetrics()`.
- **Grafana Adapter** — consumes the Prometheus Exporter or REST API, not `ObservabilityService` directly.
- **Future transports / future consumers** — anything not listed above follows the same rule:
  call `ObservabilityService`, never the bus, never a schema change without its own review.

Also tracked (internal hardening, not new capabilities — see
[KNOWN_LIMITATIONS.md](docs/releases/KNOWN_LIMITATIONS.md)): a persistent job store, durable
full-fidelity replay, `ConsumerRegistry` auto-expiry.

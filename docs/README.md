# Documentation

New here? Start with [Getting Started](getting-started.md).
Want the full capability list? See [Features](features.md).

## Guides

| Page                                             | What it covers                                              |
| ------------------------------------------------ | ----------------------------------------------------------- |
| [Browser UI](guides/browser.md)                  | Web console (`/`, `/v3`), desktop app, local vs remote mode |
| [Automation](guides/automation.md)               | Driving the daemon from agents/scripts, MCP, Testcontainers |
| [Docker](guides/docker.md)                       | Image tags, persistent state, compose, health checks        |
| [SOAP versions](guides/soap.md)                  | OCPP 1.2 / 1.5 / 1.6S over SOAP, callback URLs, SteVe       |
| [Security profiles](guides/security-profiles.md) | OCPP 1.6 security profiles 1–3, TLS flags                   |
| [Migration](guides/migration.md)                 | REST/Unix control → Socket.IO                               |
| [Legacy v1 UI](guides/legacy-v1.md)              | The original single-page UI (maintenance only)              |

## Reference

| Page                                            | What it covers                                         |
| ----------------------------------------------- | ------------------------------------------------------ |
| [CLI](reference/cli.md)                         | Every flag, REPL/JSON modes, daemon, analyze           |
| [Server](reference/server.md)                   | Socket.IO RPC, MCP endpoint, events, persistence, CORS |
| [Scenario format](reference/scenario-format.md) | Scenario JSON schema, node types, assertions           |
| [Trace format](reference/trace-format.md)       | OCPP trace record format v1.1                          |

## Examples

- [Scenario library](examples/scenarios/) · [Automation clients](examples/automation/) · [Reverse-proxy configs](examples/)
- [Java + Testcontainers](../examples/testcontainers-java/README.md)

## Development

- [Testing strategy](development/testing.md)

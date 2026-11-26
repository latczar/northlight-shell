# Northlight agent

The Northlight agent is the backend for AI agents used by websites and staff apps. An app sends it a message, the brain runs the selected agent, and the app receives the reply. It runs on Cloudflare Workers.

Each business has a client configuration that sets its allowed agents, settings, service connections and spending limits. The separate desk Worker holds service credentials and checks requests before sending them.

## Get started

Use Node 22.12 or newer in the Node 22 release line, matching CI. Node 24 is also supported. `.nvmrc` selects Node 22.

```sh
npm ci
npm run check
```

`check` runs TypeScript, the full test suite, and dry-run builds of both Workers. It does not deploy or require production credentials. CI runs the same command.

For local development, copy `.dev.vars.example` to `.dev.vars` and `desk/.dev.vars.example` to `desk/.dev.vars`, then fill in only the connections you need. Keep real tokens out of Git and chat.

```sh
npm run dev
```

This starts the brain. To run the brain and desk together, follow [local setup in the runbook](docs/runbook.md#local-setup-and-checks).

## Work on one thing

```sh
npm test -- test/phone-experience.test.ts
npm run test:watch -- test/phone-experience.test.ts
npm run typecheck
npm run check:build
```

Keep changes small, run the checks, and describe what changed. For any substantial change, use a branch and open a PR for review before merging. Keep small fixes and documentation edits lightweight. [The working guide](CONTRIBUTING.md) covers tests, failures and the manual release commands.

## Where things live

| Path | Purpose |
| --- | --- |
| `agents/<id>/` | The agent's prompt, tools, setup requirements and editable settings |
| `clients/<id>/` | Client configuration, permissions, schedules and secret names |
| `src/` | The shared loop, routes, conversation state and access controls |
| `tools/index.ts` | Shared tools and the combined tool catalogue |
| `desk/` | The separate Worker that holds service credentials and checks external requests |
| `test/` | Automated tests, plus explicitly opt-in live smoke scripts |
| `scripts/` | Operational scripts, including the live voice-timing probe |

## Reference

Start with [AGENTS.md](AGENTS.md) for coding-agent instructions and [the runbook](docs/runbook.md) for operations and how multiple websites use the shared brain.

The [technical reference](docs/reference.md) covers API contracts, tools and runtime behaviour. Paths shown there are relative to the repository root.

| Area | Reference |
| --- | --- |
| Endpoints the console and site call | [Endpoints](docs/reference.md#endpoints) |
| Iris, the website agent | [Iris](docs/reference.md#iris) |
| Clients, models and spend limits | [Configuration](docs/reference.md#configuration) |
| Credentials and external calls | [Front desk](docs/reference.md#front-desk) |
| Secrets and Cloudflare resources | [Deploying](docs/runbook.md#deploying) |

## Releases

CI checks code. It does not deploy. Production releases are manual, from a checked `main`, with the desk deployed before the brain. See [the release steps](CONTRIBUTING.md#releasing).

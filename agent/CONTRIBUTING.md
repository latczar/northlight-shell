# Working on the Northlight agent

See [AGENTS.md](AGENTS.md) for coding-agent instructions and [the runbook](docs/runbook.md) for client setup, website integration boundaries and troubleshooting.

Keep the loop short: make one understandable change, test it, then land it. For any substantial change, use a branch and open a PR for review before merging. This includes new features, shared runtime changes, permissions, integrations and deployment behaviour. Include a short description and the relevant check results. Keep small fixes and documentation edits lightweight; use a PR whenever review would help.

## Before landing a change

```sh
npm ci
npm run check
```

`check` typechecks the project, runs all automated tests and bundles both Workers with `--dry-run`. The same command runs in GitHub CI. If a dependency changes, commit `package.json` and `package-lock.json` together.

While editing, run just the relevant test files with `npm test -- test/<file>.test.ts`, or use `npm run test:watch -- test/<file>.test.ts`. Run the full check before landing the finished change.

Add tests for changed behaviour, especially client isolation, permissions, approvals, duplicate actions and recovery after interrupted writes. Documentation-only edits need a link and command check, not artificial tests.

For an integration, test the API contract and the actual Worker request flow with fake external services. If a website changes too, include browser tests in that repository and link both PRs for review. Cover authentication, validation, retries, service failures and the affected user interaction. CI must run these checks without production credentials or paid service calls; record live verification separately before enabling the integration.

## When CI fails

Read the failed step and assertion first. Reproduce the failing file locally. A test-only fix should preserve what the test proves; do not remove assertions or add retries just to turn a run green. Timing tests should control their events or use the real timeout when timing is not what they test.

Use `gh pr checks <number>` for the current PR result and `gh run view <run-id> --log-failed` for its errors. An older failed run stays in history after a fix; check the result for the latest commit. Do not describe an isolated pass as a passing full suite.

The automated suite uses fake model and service responses. It does not prove that production credentials, ElevenLabs speech or a live website are connected. `scripts/voice-timing.mjs` is a live probe, outside `npm run check`; use it only for an explicitly requested live check with the right account and credentials. It may incur model charges.

## Keep changes contained

Agent behaviour belongs in `agents/`; client-specific access and settings belong in `clients/`. Change the shared runtime only when the shared behaviour needs to change. Keep unrelated cleanup out of feature diffs and preserve other people's work.

Commit secret names and example files only. Model and signing secrets belong to the brain, while service credentials belong to the desk. Use fake customer details in tests and keep personal information out of logs and review descriptions.

## Releasing

Releasing is a separate, intentional step from committing code. Use a clean, up-to-date `main` whose checks passed. Confirm the Cloudflare account is the intended one, and record the currently deployed version IDs first:

```sh
npx wrangler deployments list --config desk/wrangler.jsonc
npx wrangler deployments list
```

Set `CLOUDFLARE_ACCOUNT_ID` to that account ID for the terminal session, then deploy the desk before the brain:

```sh
npx wrangler deploy --config desk/wrangler.jsonc
npx wrangler deploy
```

Afterwards, check the affected agent's setup and one relevant request in the intended client account. A new integration also needs its own live smoke check. Record the commit, both deployed version IDs and the result in the release note or review thread.

If the release breaks existing behaviour, use `npx wrangler rollback <previous-version-id>` for the affected Worker, adding `--config desk/wrangler.jsonc` for the desk. Durable Object migrations and persisted data may need a separate recovery plan; a code rollback does not undo them. Do not rotate shared signing keys as a routine release step.

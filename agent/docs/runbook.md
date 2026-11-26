# Runbook

Operations for the two Workers: the brain (`northlight-agent`, this folder's `wrangler.jsonc`) and the desk (`northlight-desk`, `desk/wrangler.jsonc`). The desk holds every service credential; the brain reaches it over a service binding and the desk has no public URL.

## Local setup and checks

```sh
npm ci
npm run check
```

`check` runs TypeScript, the test suite and dry-run builds of both Workers. It needs no credentials.

To run both Workers locally, copy `.dev.vars.example` to `.dev.vars` and `desk/.dev.vars.example` to `desk/.dev.vars`, fill in what you need, then:

```sh
npx wrangler dev -c wrangler.jsonc -c desk/wrangler.jsonc
```

The tests use synthetic clients (`test/fixtures/demo.ts`: Acme Test Co and Beacon Studio, with agents Helper, Second and Third). They are registered only by the test setup file and are never deployed. The deployed build has one client, `clients/kestrel`, with one agent, Iris.

## Deploying

### Cloudflare resources

Create these once on the account, before the first deploy:

| Resource | Name | Used by |
| --- | --- | --- |
| R2 bucket | `northlight-images` | Brain (`IMAGES`) and desk: image drafts and small records |
| R2 bucket | `northlight-media` | Brain (`MEDIA`): the client media library |
| Durable Objects (SQLite) | `Conversation`, `Memory`, `Dashboard`, `Scheduler`, `Usage`, `Learning`, `Leads` | Brain; created by the `v1` migration on first deploy |
| Rate limiting bindings | `CLIENT_LIMITER`, `MEDIA_LIMITER`, `LEADS_LIMITER`, `LEAD_INTAKE_LIMITER`, `STATUS_LIMITER`, `STATUS_PERSON_LIMITER` | Brain; declared in `wrangler.jsonc` |
| Cron trigger | `7 * * * *` | Brain; wakes the scheduler hourly |
| Service binding | `DESK` to `northlight-desk` (entrypoint `Desk`) | Brain |

```sh
npx wrangler r2 bucket create northlight-images
npx wrangler r2 bucket create northlight-media
```

R2 must be enabled on the account before a bucket can be created. Cloudflare asks for a payment method to enable R2, even though usage within the free allowance is not charged.

If you deploy to your own Cloudflare account, replace `latczar` in `BRAIN_URL` (`wrangler.jsonc`) and in `clients/kestrel/iris.json` (`site`) with your workers.dev subdomain, and deploy again.

### Secrets

Brain (`npx wrangler secret put <NAME>`):

- `OPENAI_API_KEY`
- `CLIENT_TOKEN_KESTREL`
- `USER_SIGNING_KEY_KESTREL`
- `DASHBOARD_SIGNING_KEY_KESTREL`
- `APPROVER_SIGNING_KEY_KESTREL`
- `ACCESS_SIGNING_KEY_KESTREL`
- `LEADS_SIGNING_KEY` (optional: only for lead intake)

Desk (`npx wrangler secret put <NAME> --config desk/wrangler.jsonc`), all optional; each tool reports "not connected" without its key:

- `KESTREL_RELEASE_GITHUB_TOKEN`: read-only on the site repo, for `find_deployed_pull`
- `KESTREL_PREVIEW_GITHUB_TOKEN`: contents and pull requests write on the site repo, for the two preview tools
- `PAGESPEED_API_KEY`: raises the PageSpeed quota for `page_audit`
- `R2_MEDIA_ACCESS_KEY_ID`, `R2_MEDIA_SECRET_ACCESS_KEY`, `R2_MEDIA_ACCOUNT_ID`: sign media upload links

The console needs the same values as the brain for `CLIENT_TOKEN_KESTREL`, `USER_SIGNING_KEY_KESTREL`, `APPROVER_SIGNING_KEY_KESTREL` and `ACCESS_SIGNING_KEY_KESTREL`.

### Order

Deploy the desk before the brain:

```sh
npx wrangler deploy --config desk/wrangler.jsonc
npx wrangler deploy
```

Then open Iris's setup (`GET /v1/agents/iris/setup` with the client token) and check each item reads as expected.

## Rolling back

`npx wrangler rollback <previous-version-id>`, adding `--config desk/wrangler.jsonc` for the desk. A code rollback does not undo Durable Object data. Do not rotate signing keys as a routine step: the console must change at the same time.

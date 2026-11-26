# Kestrel Garage demo website

A demo website for **Kestrel Garage**, a fictional independent car garage in the made-up town of Milbrook. Northlight uses it to show what its website manager agent, Iris, can do: audit a page, suggest SEO wording, draft changes and wait for staff approval.

Everything about the business is made up. The phone number comes from the Ofcom range reserved for drama, the address and team are invented, and the images are drawn placeholders. Pages are marked `noindex` and every page says the business is fictional.

The site is static HTML built from `site.json`. A small Cloudflare Worker serves it and hosts the Iris staff desk at `/staff/iris/`.

## Run it

Use Node 22.12 or newer on the Node 22 line (see `.nvmrc`). Node 24 also works.

```sh
npm ci
npx playwright install chromium webkit
npm run check        # build, unit tests, Worker dry run and browser tests; no deployment
node build.mjs       # site.json + src/ + assets/ -> public/ (generated, ignored by git)
node serve.mjs 4317  # local preview at http://127.0.0.1:4317/
```

## Layout

| Path | Role |
| --- | --- |
| `site.json` | Business facts and all page copy. Iris proposes changes to this file. |
| `build.mjs` | Renders pages and structured data, bundles CSS and JavaScript, copies assets and self-hosted fonts |
| `src/styles.css`, `src/site.js` | Northlight theme tokens and layout; mobile menu and the demo form |
| `src/content.mjs` | Service page sections and policy pages |
| `news/` | One JSON file per news post (see `docs/NEWS.md`) |
| `assets/` | Placeholder SVG images and brand marks, made by `scripts/make-placeholders.mjs` |
| `worker.mjs` | Serves the static site and routes `/staff/iris/` to the staff desk |
| `src/iris-staff.mjs`, `src/iris-view.mjs` | Staff desk: review requests, approve or request changes, and chat with Iris |
| `src/iris-calls.mjs` | Optional call history for a voice line. Switched off unless a voice line is configured. |
| `src/review/` | Server-side helpers for turning a call into a Services draft and recording late feedback |
| `test/`, `browser/` | Node unit tests and Playwright browser tests |

## Staff desk configuration

The staff desk only opens behind Cloudflare Access. Until these are set it returns "Staff sign-in is being configured".

| Name | Kind | Purpose |
| --- | --- | --- |
| `IRIS_ACCESS_ISSUER` | var | Cloudflare Access team URL, for example `https://<team>.cloudflareaccess.com` |
| `IRIS_ACCESS_AUD` | var | Access application audience tag |
| `IRIS_STAFF_EMAIL` | var | The one staff email allowed into the desk |
| `IRIS_STAFF_PERSON` | var | That person's ID in the agent's Kestrel client access list |
| `CLIENT_TOKEN_KESTREL` | secret | Kestrel client token for the agent |
| `USER_SIGNING_KEY_KESTREL` | secret | Signs the staff member's chat pass |
| `APPROVER_SIGNING_KEY_KESTREL` | secret | Signs approval decisions |

The footer links staff to the Northlight console (`staff.sign_in` in `site.json`). Until Cloudflare Access is set up for `/staff/iris` (`IRIS_ACCESS_ISSUER` unset), that path redirects to the console as well.

The Worker reaches the agent through the `AGENT` service binding to the `northlight-agent` Worker. Phone calls are optional: `IRIS_CALL_HISTORY_KEY`, `IRIS_VOICE_AGENT_ID`, `IRIS_VOICE_BRANCH_ID`, `IRIS_PHONE_NUMBER`, `IRIS_PHONE_DISPLAY` and `IRIS_STAFF_HANDSET` turn on call history and the call link.

Set secrets with `npx wrangler secret put <NAME>`. Never commit them; `.dev.vars` is ignored.

## Live and Preview

Page titles and meta descriptions that staff approve in the Northlight console reach this site without a rebuild:

- **Preview:** an approved change shows first on Preview. Open any page with `?preview=1` to see it (a cookie keeps
  Preview on while you browse, with a teal bar at the top); `?preview=0` goes back to the live site.
- **Live:** pressing **Publish to live** on Iris's Overview in the console makes every waiting change live at once.
  **Discard changes** drops them instead.

The Worker asks the agent for the copy through the `SITE_COPY` service binding (`src/live-copy.mjs`) and swaps it into
each page as it is served. If the agent cannot answer, the built page is served unchanged. `site.json` stays the
starting copy.

## Deploy

```powershell
$env:DEPLOY_COMMIT = git rev-parse HEAD
npm run build
npx wrangler deploy
```

`DEPLOY_COMMIT` writes `/foundry-source.json`, which Iris reads to confirm which commit is live. This publishes to the `kestrel-garage-site` Worker on your account's workers.dev subdomain. Deploy the `northlight-agent` Worker first so the service binding resolves.

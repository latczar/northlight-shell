# Technical reference

Paths are relative to this folder. Confirm behaviour against the code; this page is a map, not a contract.

## Endpoints

Every `/v1/` request needs `authorization: Bearer <CLIENT_TOKEN_KESTREL>`. Person-scoped routes also need a signed pass in a header (`x-user-pass`, `x-approver-pass` or `x-admin-pass`), made with the matching signing key.

Called by the console (`console/src/lib/server/brain.ts`):

| Method and path | Purpose |
| --- | --- |
| `GET /v1/agents` | Each agent's status, items to review and newest card |
| `GET /v1/agents/:agent/setup` | What the agent needs, by name, never a value |
| `GET /v1/agents/:agent/data` | Dashboard snapshots the agent's tools saved |
| `GET`, `PUT /v1/agents/:agent/settings` | Editable settings (`PUT` needs an approver pass) |
| `GET /v1/agents/:agent/lessons`, `POST /v1/lessons/:id` | Proposed and active lessons; approve or remove one |
| `GET`, `POST /v1/agents/:agent/conversations/web-<person>-…` | A person's chat with the agent (`/messages`, `/jobs`) |
| `GET /v1/approvals`, `GET`, `POST /v1/approvals/:id` | Proposals waiting for a person; approve or decline |
| `GET /v1/dashboard` | Cards for the client dashboard |
| `PUT /v1/access/approvers` | Push the approver and manager lists (signed with `ACCESS_SIGNING_KEY_KESTREL`) |

Called by the site (`site/src/iris-staff.mjs`, server side only):

| Method and path | Purpose |
| --- | --- |
| `GET`, `POST /v1/agents/iris/conversations/kestrel-staff-desk/…` | The staff desk chat with Iris |
| `GET /v1/approvals` | The staff desk's waiting proposals |

Other routes: `GET /health`, `POST /v1/agents/iris/homepage-preview`, `POST /v1/chat/completions` (voice), `POST /v1/voice/phone-start`, `/v1/media/…`, `/v1/leads/…`, `GET /v1/stuck`, `POST /v1/agents/:agent/reset`, `GET /v1/schedules` and `POST /v1/schedules/:id/run`. Routes for agents a client does not have answer `404`.

The `/v1/convai/` calls in the console and site go to ElevenLabs, not to the brain.

## Voice

Calls to Iris use an ElevenLabs voice agent with a custom LLM: ElevenLabs listens and speaks, and sends each turn to `POST /v1/chat/completions` with the client token as its API key and `model: "iris"`. `scripts/elevenlabs-iris.mjs` creates or updates that voice agent (private, with custom LLM extra body allowed).

- Browser calls start in the console (`/c/kestrel/iris/talk`). It asks ElevenLabs for a one-time token and sends `elevenlabs_extra_body: {conversation_id: "voice-<person>-<uuid>", user_auth: <pass>}`, so the call is the signed-in person's, with their memory and approvals.
- Phone calls need a number from Twilio or a SIP trunk (not free) and `POST /v1/voice/phone-start` as the conversation initiation webhook.

## Iris

`agents/iris/`: the website manager and SEO agent. Tools:

| Tool | Effect |
| --- | --- |
| `review_site_page` | Reads a page's title, description, canonical link and headings on the configured site |
| `page_audit` | Google PageSpeed scores, Core Web Vitals and failing SEO checks for one page |
| `find_deployed_pull` | The merged pull request for the deployed commit, when the release token is set |
| `submit_seo_copy`, `post_seo_report` | A title or description proposal for editorial approval; a report card |
| `build_homepage_preview` | A pull request changing the two homepage heading lines, for a signed-in manager |
| `propose_services_title_preview` | A draft pull request for an approved Services title, for named pilot staff only |

The preview tools edit one JSON file in `repository` on `baseBranch`. `siteFile` sets its path (`site.json` by default; Kestrel uses `site/site.json`). Paths outside the repo are refused. `servicesPreviewStaff` starts empty, so the Services preview is off until a person is named.

## Configuration

`clients/kestrel/client.json` sets the client's model (`gpt-5.4-mini` through OpenAI), its daily spend cap and its signing key names. `clients/kestrel/iris.json` sets Iris's permissions, settings, connections and the weekly review schedule. `validateClient` checks both at startup.

An agent may set its own `model` and `limits`; otherwise the client's apply. Each model call reserves its worst-case cost against the daily cap before it runs.

## Front desk

`desk/`: the only Worker that holds service credentials. A connection in `iris.json` names its hosts, its secret and the exact `gets` and `writes` it may make. The desk refuses anything else, redacts credentials from responses and logs each request to the client's dashboard. A write that needs approval runs only with the fingerprints a person approved, each once.

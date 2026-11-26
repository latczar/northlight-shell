# Northlight

Northlight is an AI website manager and SEO assistant for small businesses. Staff chat with **Iris**, the agent, to audit a page, get SEO advice, draft new wording, request changes and approve or decline them before anything is published.

This repository is a working demo. Every business, person, phone number and conversation in it is made up. The demo business is **Kestrel Garage**, a fictional independent garage in the fictional town of Milbrook.

## What's here

| Folder | What it is | Runs on |
| --- | --- | --- |
| [`agent/`](agent/) | The agent platform and Iris: chat, tools, approvals, drafts and history, plus the separate desk Worker that holds service credentials | Cloudflare Workers |
| [`site/`](site/) | The Kestrel Garage demo website and its staff desk | Cloudflare Workers |
| [`console/`](console/) | The Northlight staff console: sign-in, chat with Iris, drafts, approvals and people | Next.js on Vercel, Supabase |

Each folder has its own README with setup steps and checks.

## Checks

```sh
cd agent && npm ci && npm run check
cd site && npm ci && npm run check
cd console && npm ci && npm run typecheck && npm run lint && npm test
```

CI runs the same checks for all three on every push and pull request.

## Secrets

No real keys, tokens or signing keys belong in this repository. Each app lists the names it needs in its example env file (`.dev.vars.example` or `.env.example`). Set real values with `wrangler secret put` or `vercel env add`.

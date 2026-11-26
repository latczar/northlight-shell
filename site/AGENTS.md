# Working on the Kestrel Garage demo site

- Read [README.md](README.md) and [the brand guide](docs/BRAND.md) first.
- Kestrel Garage is fictional. Keep every fact synthetic: Ofcom drama-range phone numbers (01632 960 xxx), invented addresses, invented names and `example` domains. Never add real businesses, people, photos or contact details.
- Business facts and page copy live in `site.json`; the renderer escapes and validates them. Do not invent prices, reviews, ratings, warranties or accreditations.
- Images are placeholders made by `scripts/make-placeholders.mjs`. Regenerate them and `assets/media.json` together.
- Keep browser code free of client tokens and signing keys. They belong in Worker secrets.
- A browser message claiming to be staff grants no rights. The staff desk checks Cloudflare Access and one configured email.
- Use plain British English and no Unicode em dashes in copy or documentation.

## Checks

```sh
npm ci
npx playwright install chromium webkit
npm run check
```

`check` builds the site, runs the unit tests, bundles the Worker without deploying and runs the browser tests against the local Worker. Tests use fake services only. Fix failures rather than weakening assertions.

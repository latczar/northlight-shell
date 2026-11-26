# News posts

There is one file per post: `news/<slug>.json`. `build.mjs` validates every field and fails the build on anything wrong, whether a person or an agent wrote the post.

| Field | Rule |
| --- | --- |
| `slug` | Lowercase slug, equal to the file name |
| `status` | `"published"` or `"draft"`. Drafts are not rendered |
| `date` | `YYYY-MM-DD` |
| `category` | One of `MOT`, `Brakes`, `Tyres`, `Suspension`, `Maintenance`, `Garage news` |
| `title` / `summary` | Text, at most 90 / 200 characters |
| `image` / `image_alt` | An existing `.svg` or `.webp` in `assets/img` / alt text |
| `author` | Text |
| `featured` | Optional `true`. The newest featured post leads `/news/` |
| `body` | List of blocks, each exactly one of `p`, `h2`, `ul`, `ol`, `callout` |
| `sources` | List of `{label, url}` with `https:` URLs |

There is no HTML and no inline links. Text is escaped.

The build rejects em dashes and promises such as guarantees, warranties, accreditations or price claims.

Write in plain British English. Only state general, well-known car care facts, and cite GOV.UK where a rule is mentioned. Do not publish vehicle recall details: point readers to the GOV.UK recall checker instead.

# Brand guide

The demo site uses the Northlight theme so it matches the staff console.

## Colours

| Token | Hex | Use |
| --- | --- | --- |
| `--charcoal` | `#1f2328` | Text, header, footer and dark sections |
| `--mist` | `#f6f8f8` | Light section backgrounds |
| `--teal` | `#0f766e` | Links, buttons and accents on light backgrounds |
| `--accent-hover` | `#0b5e58` | Button hover |
| Light teal | `#2dd4bf`, `#5eead4` | Accents on dark backgrounds only |
| `--muted` | `#5b6670` | Secondary text |
| `--line` | `#dde3e6` | Borders |

`test/site.test.mjs` checks the text colour pairs against WCAG AA (4.5:1). Add a pair there when you add a new text colour.

## Type

Headings use Manrope and body text uses Inter. Both are self-hosted from the `@fontsource-variable` packages, so visitors make no requests to font services. System fonts are the fallback.

## Marks

- Header wordmark: "KESTREL" over "GARAGE", set in Manrope.
- Footer and favicon: `assets/brand/kestrel-badge.svg`.
- Footer credit: the Northlight north star (`assets/brand/northlight-mark.svg`) with "Website managed by Northlight".

## Images

All images are flat SVG illustrations in the theme colours. They are placeholders for a fictional business and must not be replaced with photos of real places or people.

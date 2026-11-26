// Turns a request's untrusted `preview` object into labelled fields a person can read. Never prints raw JSON; only
// http(s) values become links.

export type PreviewField =
  | { label: string; kind: "text"; text: string }
  | { label: string; kind: "link"; href: string; text: string }
  | { label: string; kind: "list"; items: { text: string; href?: string }[]; more: number }
  | { label: string; kind: "long"; text: string };

const MAX_FIELDS = 12;
const MAX_ITEMS = 24;
const MAX_ITEM_CHARS = 80;
const LONG_CHARS = 240;
const NAME_KEYS = ["name", "title", "label", "url", "slug", "id"];

/** The URL itself when it is a plain http(s) address, otherwise undefined (so javascript:, data: and the like never link). */
export function httpUrl(value: string): string | undefined {
  if (/\s/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

export const labelFor = (key: string) =>
  key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase().replace(/^\w/, c => c.toUpperCase());

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value.toLocaleString("en-GB");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return undefined;
}

/** One short human line for any value; nesting past `depth` is dropped rather than dumped. */
function describe(value: unknown, depth = 0): string | undefined {
  const plain = scalar(value);
  if (plain !== undefined || value === null || value === undefined) return plain;
  if (depth >= 2) return undefined;
  if (Array.isArray(value)) return value.map(v => describe(v, depth + 1)).filter(Boolean).join(", ") || undefined;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const named = NAME_KEYS.map(k => scalar(record[k])).find(Boolean);
    if (named) return named;
    const parts = Object.entries(record).flatMap(([k, v]) => {
      const text = describe(v, depth + 1);
      return text ? [`${labelFor(k)}: ${text}`] : [];
    });
    return parts.join(" · ") || undefined;
  }
  return undefined;
}

function toField(key: string, value: unknown): PreviewField | undefined {
  const label = labelFor(key);
  if (Array.isArray(value)) {
    const texts = value.map(v => describe(v)).filter((t): t is string => !!t);
    if (!texts.length) return undefined;
    const items = texts.slice(0, MAX_ITEMS).map(text => ({
      text: text.length > MAX_ITEM_CHARS ? `${text.slice(0, MAX_ITEM_CHARS - 1)}…` : text,
      href: httpUrl(text),
    }));
    return { label, kind: "list", items, more: texts.length - items.length };
  }
  if (value && typeof value === "object") {
    const lines = Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
      const text = describe(v, 1);
      return text ? [`${labelFor(k)}: ${text}`] : [];
    });
    return lines.length ? { label, kind: "text", text: lines.join("\n") } : undefined;
  }
  const text = scalar(value);
  if (text === undefined) return undefined;
  const href = typeof value === "string" ? httpUrl(text) : undefined;
  if (href) return { label, kind: "link", href, text };
  return text.length > LONG_CHARS ? { label, kind: "long", text } : { label, kind: "text", text };
}

export function previewFields(preview: Record<string, unknown> | null | undefined): PreviewField[] {
  const seen = new Set<string>();
  const fields: PreviewField[] = [];
  for (const [key, value] of Object.entries(preview ?? {})) {
    const field = toField(key, value);
    if (!field) continue;
    // The same label with the same content (pageUrl and page_url) is one field.
    const identity = `${field.label.toLowerCase()}|${JSON.stringify(field)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    fields.push(field);
    if (fields.length === MAX_FIELDS) break;
  }
  return fields;
}

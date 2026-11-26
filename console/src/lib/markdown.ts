import { httpUrl } from "./preview";

// A small, safe subset of Markdown for chat replies: paragraphs, bold, italics, inline code, lists and http(s) links.
// The result is a tree of known node types, rendered as React elements; raw HTML is just text, and no value is ever
// used as markup or as a non-http(s) link target.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "br" }
  | { t: "strong" | "em"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };
export type Block = { t: "p"; c: Inline[] } | { t: "ul" | "ol"; items: Inline[][] };

const INLINE = new RegExp([
  "`([^`\\n]+)`", // 1 code
  "\\[([^\\]\\n]+)\\]\\((\\S+?)\\)", // 2 text, 3 href
  "(https?:\\/\\/[^\\s<>]*[^\\s<>.,;:!?'\")\\]])", // 4 bare url
  "\\*\\*(?=\\S)(.+?)(?<=\\S)\\*\\*|__(?=\\S)(.+?)(?<=\\S)__", // 5, 6 strong
  "\\*(?=\\S)(.+?)(?<=\\S)\\*|(?<![\\w])_(?=\\S)(.+?)(?<=\\S)_(?![\\w])", // 7, 8 em
].join("|"), "g");

export function parseInline(text: string, links = true): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ t: "text", v: text.slice(last, at) });
    last = at + m[0].length;
    if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
    else if (m[2] !== undefined) {
      const href = links ? httpUrl(m[3]) : undefined;
      out.push(...(href ? [{ t: "link", href, c: parseInline(m[2], false) } as const] : parseInline(m[2], links)));
    } else if (m[4] !== undefined) out.push(links ? { t: "link", href: m[4], c: [{ t: "text", v: m[4] }] } : { t: "text", v: m[4] });
    else if (m[5] !== undefined || m[6] !== undefined) out.push({ t: "strong", c: parseInline(m[5] ?? m[6], links) });
    else out.push({ t: "em", c: parseInline(m[7] ?? m[8], links) });
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    const c = paragraph.flatMap((line, i) => [...(i ? [{ t: "br" } as const] : []), ...parseInline(line)]);
    blocks.push({ t: "p", c });
    paragraph = [];
  };
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    const bullet = BULLET.exec(raw);
    const numbered = bullet ? null : NUMBERED.exec(raw);
    const item = bullet ?? numbered;
    if (item) {
      flush();
      const kind = bullet ? "ul" : "ol";
      const last = blocks.at(-1);
      if (last?.t === kind) last.items.push(parseInline(item[1]));
      else blocks.push({ t: kind, items: [parseInline(item[1])] });
    } else if (!raw.trim()) flush();
    else {
      // A heading marker is dropped and its line shown in bold; chat has no heading levels.
      const heading = /^#{1,6}\s+(.*)$/.exec(raw);
      if (heading) {
        flush();
        blocks.push({ t: "p", c: [{ t: "strong", c: parseInline(heading[1]) }] });
      } else paragraph.push(raw);
    }
  }
  flush();
  return blocks;
}

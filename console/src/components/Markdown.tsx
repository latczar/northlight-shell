import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { parseMarkdown, type Inline } from "@/lib/markdown";

function inline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.v;
      case "br":
        return <br key={i} />;
      case "code":
        return (
          <code key={i} className="rounded-sm bg-inset px-1 py-0.5 font-mono text-[0.9em]">
            {n.v}
          </code>
        );
      case "strong":
        return <strong key={i} className="font-semibold">{inline(n.c)}</strong>;
      case "em":
        return <em key={i}>{inline(n.c)}</em>;
      case "link":
        return (
          <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex max-w-full items-baseline gap-1 text-accent-text underline decoration-accent-text/40 underline-offset-4 [overflow-wrap:anywhere] hover:decoration-accent-text">
            <span className="min-w-0">{inline(n.c)}</span>
            <ExternalLink className="size-3.5 shrink-0 self-center" aria-hidden="true" />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        );
    }
  });
}

/** Chat text as safe Markdown (lib/markdown.ts): no HTML, only http(s) links. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 break-words">
      {parseMarkdown(text).map((b, i) =>
        b.t === "p" ? (
          <p key={i}>{inline(b.c)}</p>
        ) : b.t === "ul" ? (
          <ul key={i} className="list-disc pl-5">
            {b.items.map((c, j) => <li key={j}>{inline(c)}</li>)}
          </ul>
        ) : (
          <ol key={i} className="list-decimal pl-5">
            {b.items.map((c, j) => <li key={j}>{inline(c)}</li>)}
          </ol>
        ),
      )}
    </div>
  );
}

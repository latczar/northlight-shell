import { decodeHTML, decodeHTMLAttribute } from "entities";

/** Older page inspections and approvals contain the HTMLRewriter source spelling. */
export function reviewedText(current: string, field: string, format: unknown): string {
  if (format === "plain") return current;
  return field === "description" ? decodeHTMLAttribute(current) : decodeHTML(current);
}

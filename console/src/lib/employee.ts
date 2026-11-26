import type { AgentSummary, Card } from "./brain-types";
import type { Tone } from "@/components/ui/Status";

// Plain words for what an employee is doing and what a piece of its work is, the design's way: a dot plus a word.

const DAY_MS = 24 * 60 * 60_000;

/** "Needs you" only when this person has a decision to make; another person's request does not need them. */
export function employeeState(agent: AgentSummary, decisions: number, now = Date.now()): { tone: Tone; word: string } {
  // the count lives beside it (the heading, the Requests tab), so the state stays one short phrase
  if (decisions > 0) return { tone: "attention", word: "Needs you" };
  if (agent.lastActive && now - agent.lastActive < DAY_MS) return { tone: "ok", word: "Active today" };
  return { tone: "quiet", word: "Idle" };
}

const OUTCOME = /^(Done|Declined|Failed|Not confirmed):\s*/;

/** A piece of work in words: its kind or outcome as a dot and a word, and its title without the outcome the word says. */
export function workState(card: Card): { tone: Tone; word: string; title: string } {
  const title = card.title.replace(OUTCOME, "") || card.title;
  if (card.kind === "alert") return { tone: "error", word: "Problem", title };
  if (card.kind === "report") return { tone: "quiet", word: "Report", title };
  if (/^(Failed|Not confirmed):/.test(card.title)) return { tone: "error", word: "Did not go through", title };
  if (/^Declined:/.test(card.title)) return { tone: "quiet", word: "Declined", title };
  return { tone: "ok", word: "Done", title };
}

/** "1 employee", "2 requests": a count with its noun. */
export const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

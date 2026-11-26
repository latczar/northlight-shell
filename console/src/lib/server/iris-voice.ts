import "server-only";
import { randomUUID } from "node:crypto";
import { signPass } from "@/lib/pass";
import { brainCredentials } from "./config";

// Browser calls to Iris through the voice provider (ElevenLabs). The voice agent is private: only this server can open a
// call, with the provider key, and only for a signed-in person who may use Iris. Each call carries a pass signed for that
// person, so the agent answers as Iris for them and nobody else (agent/src/index.ts, completions).

const AGENT_ID = /^[A-Za-z0-9_-]{1,120}$/;
/** A call keeps its pass for this long: every turn of the call is checked against it. */
const CALL_PASS_SECONDS = 30 * 60;

/** Whether staff may talk to Iris in the browser: switched on, with the provider key and voice agent set. */
export function browserCallsOn(): boolean {
  return process.env.IRIS_CALL_BROWSER === "on" && Boolean(process.env.IRIS_CALL_HISTORY_KEY) && AGENT_ID.test(process.env.IRIS_CALL_AGENT_ID ?? "");
}

export type CallStart = { token: string; userId: string; extraBody: { conversation_id: string; user_auth: string } };

export class CallStartError extends Error {}

/**
 * Opens one browser call for this person: a single-use connection token from the provider, a new conversation of theirs,
 * and their signed pass. Callers check the person's access to Iris first.
 */
export async function startBrowserCall(clientId: string, userId: string, send: typeof fetch = fetch): Promise<CallStart> {
  if (!browserCallsOn()) throw new CallStartError("Calls to Iris are not switched on.");
  const creds = brainCredentials(clientId);
  if ("missing" in creds) throw new CallStartError("This business is not connected yet.");
  const query = new URLSearchParams({ agent_id: process.env.IRIS_CALL_AGENT_ID! });
  if (process.env.IRIS_CALL_BRANCH_ID) query.set("branch_id", process.env.IRIS_CALL_BRANCH_ID);
  let response: Response;
  try {
    response = await send("https://api.elevenlabs.io/v1/convai/conversation/token?" + query, {
      headers: { "xi-api-key": process.env.IRIS_CALL_HISTORY_KEY! }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new CallStartError("The voice service did not answer. Try again in a minute.");
  }
  if (!response.ok) {
    console.warn("Iris call start provider error", { status: response.status });
    throw new CallStartError(response.status === 429 ? "The voice service is busy. Try again in a minute." : "The voice service would not start a call. Tell your Northlight contact.");
  }
  const body = await response.json().catch(() => null) as { token?: unknown } | null;
  if (typeof body?.token !== "string" || !body.token) throw new CallStartError("The voice service sent an answer this app could not read.");
  return {
    token: body.token,
    userId,
    extraBody: {
      conversation_id: `voice-${userId}-${randomUUID()}`,
      user_auth: signPass(creds.userKey, clientId, userId, Math.floor(Date.now() / 1000) + CALL_PASS_SECONDS),
    },
  };
}

import { AGENTS } from "../agents";
import { warmBriefing } from "./briefing";
import type { ClientConfig } from "./contracts";
import type { Env } from "./conversation";
import { SLACK_USER } from "./slack";

/**
 * The form of the call ids the Call Lab makes up for its test calls. Twilio's call ids (`CA…`) and ElevenLabs' own
 * (`conv_…`) do not have it, so a call under one of those cannot be given a test model. It is a naming rule, not proof of
 * where a start came from: the sender chooses the id, so whoever holds the client token can start a test call under any
 * such id, and a call id from another carrier that happened to begin this way could be tied to a test model by a test
 * start that reached the call before its own start.
 */
const TEST_CALL_ID = /^lab(check)?-/;

/**
 * POST /v1/voice/phone-start: ElevenLabs' conversation initiation webhook for inbound phone calls (client token in its
 * request headers). A call carries no app pass or chat id, so this gives the call its own conversation, `phone-<call SID>`,
 * through custom_llm_extra_body; completions() then receives it as elevenlabs_extra_body.conversation_id.
 * `?agent=<id>` on the webhook URL (set per ElevenLabs agent) says whose call it is: after the answer goes out, in the
 * background, that agent's call briefing is warmed, the notes its first reply needs are read, and the model gets one
 * practice request with both (Conversation.keepCallNotes, rehearse), so the call never waits for this and the caller's
 * first words wait for none of it.
 * A client with `phone` accepts only its approved numbers: the caller's first name is saved in the call's conversation before
 * this answers (Conversation.warm), and completions() refuses a call whose conversation has none. Nothing about the caller
 * goes through ElevenLabs, and such a client's webhook URL must carry `?agent=`: without it there is no conversation to save
 * in, and the call is refused. Other clients accept every caller, anonymous (useful for testing).
 * `test_model` in the body ties one test call to one of the client's `callTestModels` (the Call Lab's model choice): the name
 * is saved with the call before this answers, the practice request and every reply of the call use that model, and the
 * answer names it. It is asked for here, with the client token, never by a caller: completions() reads no model name. It
 * is taken only under a test call's id (TEST_CALL_ID) and only as the call's first start: a call's model is fixed once
 * (Conversation.warm), so a call that has already started, as a test call or an ordinary one, answers 409 and keeps what
 * it has. A name the client does not list, or one asked for under any other call id, is refused and nothing starts.
 */
export async function phoneStart(request: Request, env: Env, client: ClientConfig, ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  const body = await request.json().catch(() => null) as { call_sid?: unknown; conversation_id?: unknown; caller_id?: unknown; test_model?: unknown } | null;
  const sid = [body?.call_sid, body?.conversation_id].find(v => typeof v === "string" && /^[A-Za-z0-9_-]{8,100}$/.test(v)) as string | undefined;
  if (!sid) return Response.json({ error: "call_sid or conversation_id is required" }, { status: 400 });
  const conversationId = `phone-${sid}`;
  const caller = client.phone ? approvedCallers(env, client)[String(body?.caller_id ?? "").replace(/[^0-9+]/g, "")] : undefined;
  if (client.phone && !caller) console.log(JSON.stringify({ event: "phone_caller_refused", client: client.id }));
  const agentId = new URL(request.url).searchParams.get("agent") ?? "";
  const agent = client.agents.includes(agentId) ? AGENTS[agentId] : undefined;
  const asked = body?.test_model;
  const testModel = typeof asked === "string" && agent && TEST_CALL_ID.test(sid) && Object.hasOwn(client.callTestModels ?? {}, asked) ? asked : undefined;
  if (asked !== undefined && !testModel) {
    return Response.json({ error: "test_model must be one of this client's call test models, on a test call id (lab-...) and a call start that names its agent" }, { status: 400 });
  }
  if (agent && (!client.phone || caller)) {
    const call = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`${client.id}/${agent.id}/${conversationId}`));
    const failed = (what: string) => (error: unknown) => console.error(`${what} failed`, error instanceof Error ? error.name : typeof error);
    // The call's conversation object is started now, so the caller's first words do not wait for it (measured 2026-11-11: 0.5 to 0.8 s on a first turn, under 0.1 s later).
    // An approved caller is saved there before this answers, so the record exists when their first words arrive. If saving fails the call is refused as unknown.
    // A test model is fixed the same way, but here a failure is an error: the answer below says the call is tied to it.
    if (testModel) {
      const tied = await call.warm(caller, testModel).catch((error: unknown) => { failed("call record")(error); return null; });
      if (tied === null) return Response.json({ error: "The test model could not be saved for this call" }, { status: 503 });
      // The call had already started, with another model or as an ordinary call: it keeps what it has, and this start does nothing more.
      if (tied !== testModel) return Response.json({ error: "This call has already started: its model was fixed by its first start" }, { status: 409 });
    } else if (caller) await call.warm(caller).catch(failed("call record"));
    else ctx.waitUntil(call.warm().catch(() => {}));
    // Whose memory the call's turns read: the team's for a client with approved callers (src/index.ts completions), nobody's on an anonymous line.
    const userId = client.phone ? SLACK_USER : undefined;
    const briefed = agent.briefing ? warmBriefing(env, client, agent, conversationId).catch(failed("call briefing")) : Promise.resolve();
    const noted = call.keepCallNotes(client.id, agent.id, userId).catch(failed("call notes"));
    // The practice request carries what the first reply will: it goes once the briefing and the notes are in, or have failed.
    ctx.waitUntil(Promise.all([briefed, noted]).then(() => call.rehearse(client.id, agent.id, conversationId, userId)).catch(failed("call practice")));
  }
  return Response.json({
    type: "conversation_initiation_client_data", custom_llm_extra_body: { conversation_id: conversationId }, dynamic_variables: {},
    ...(testModel && (!client.phone || caller) ? { test_model: testModel } : {}),
  });
}

/** The client's approved numbers and the first name of each; empty when the secret is missing or not a JSON object of names. */
export function approvedCallers(env: Env, client: ClientConfig): Record<string, string> {
  const raw = client.phone ? (env as unknown as Record<string, unknown>)[client.phone.callersEnv] : undefined;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) as unknown : undefined;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([number, name]) => /^\+?\d{7,15}$/.test(number) && typeof name === "string" && /^[A-Za-z][A-Za-z .'-]{0,39}$/.test(name)));
  } catch {
    return {};
  }
}

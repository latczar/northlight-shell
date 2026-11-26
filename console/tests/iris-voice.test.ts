import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { signPass } from "../src/lib/pass";
import { browserCallsOn, startBrowserCall } from "../src/lib/server/iris-voice";
import { historyCaller } from "../src/lib/server/pilot-call-access";
import { pilotCall, pilotCalls } from "../src/lib/server/iris-calls.mjs";

const KEY = "test-user-signing-key-kestrel-0123456789";
const caller = { phone: null, userId: "user-robin", since: null } as const;

beforeEach(() => {
  vi.stubEnv("IRIS_CALL_BROWSER", "on");
  vi.stubEnv("IRIS_CALL_HISTORY_KEY", "fixture");
  vi.stubEnv("IRIS_CALL_AGENT_ID", "agent_demo_iris_0001");
  vi.stubEnv("IRIS_CALL_BRANCH_ID", "");
  vi.stubEnv("KESTREL_HISTORY_CALLERS", "");
  vi.stubEnv("AGENT_BRAIN_URL", "https://brain.example");
  vi.stubEnv("BRAIN_TOKEN_KESTREL", "token");
  vi.stubEnv("BRAIN_USER_SIGNING_KEY_KESTREL", KEY);
  vi.stubEnv("BRAIN_APPROVER_SIGNING_KEY_KESTREL", "approver");
});
afterEach(() => vi.unstubAllEnvs());

it("switches browser calls on only with the flag, the key and the voice agent", () => {
  expect(browserCallsOn()).toBe(true);
  for (const [name, value] of [["IRIS_CALL_BROWSER", ""], ["IRIS_CALL_HISTORY_KEY", ""], ["IRIS_CALL_AGENT_ID", "not an id!"]]) {
    vi.stubEnv(name, value);
    expect(browserCallsOn()).toBe(false);
    vi.stubEnv("IRIS_CALL_BROWSER", "on");
    vi.stubEnv("IRIS_CALL_HISTORY_KEY", "fixture");
    vi.stubEnv("IRIS_CALL_AGENT_ID", "agent_demo_iris_0001");
  }
});

it("gives staff without a handset their own browser call history, and nobody else's", () => {
  expect(historyCaller("robin@kestrel.example", "kestrel", "iris", "user-robin")).toEqual(caller);
  expect(historyCaller("robin@kestrel.example", "kestrel", "iris")).toBeNull();
  expect(historyCaller("robin@kestrel.example", "harbour", "iris", "user-robin")).toBeNull();
  vi.stubEnv("KESTREL_HISTORY_CALLERS", JSON.stringify([{ userId: "user-robin", phone: "+441632960100", since: 1700000000 }]));
  expect(historyCaller("robin@kestrel.example", "kestrel", "iris", "user-robin")).toEqual({ phone: "+441632960100", since: 1700000000 });
  // Broken handset assignments show nobody any calls.
  vi.stubEnv("KESTREL_HISTORY_CALLERS", "not json");
  expect(historyCaller("robin@kestrel.example", "kestrel", "iris", "user-robin")).toBeNull();
  vi.stubEnv("KESTREL_HISTORY_CALLERS", "");
  vi.stubEnv("IRIS_CALL_BROWSER", "");
  expect(historyCaller("robin@kestrel.example", "kestrel", "iris", "user-robin")).toBeNull();
});

it("opens a call with a one-time token, a new conversation of the person's and their signed pass", async () => {
  const send = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe("/v1/convai/conversation/token");
    expect(url.searchParams.get("agent_id")).toBe("agent_demo_iris_0001");
    expect(new Headers(init?.headers).get("xi-api-key")).toBe("fixture");
    return Response.json({ token: "one-time" });
  });
  const call = await startBrowserCall("kestrel", "user-robin", send as typeof fetch);
  expect(call.token).toBe("one-time");
  expect(call.userId).toBe("user-robin");
  expect(call.extraBody.conversation_id).toMatch(/^voice-user-robin-[0-9a-f-]{36}$/);
  const [person, expiry] = call.extraBody.user_auth.split(".");
  expect(person).toBe("user-robin");
  expect(call.extraBody.user_auth).toBe(signPass(KEY, "kestrel", "user-robin", Number(expiry)));
  await expect(startBrowserCall("kestrel", "user-robin", (async () => new Response(null, { status: 401 })) as typeof fetch)).rejects.toThrow("would not start a call");
  vi.stubEnv("IRIS_CALL_BROWSER", "");
  await expect(startBrowserCall("kestrel", "user-robin", send as typeof fetch)).rejects.toThrow("not switched on");
});

function detail(id: string, extra: Record<string, unknown>, more: Record<string, unknown> = {}) {
  return {
    conversation_id: id, agent_id: "agent_demo_iris_0001", status: "done",
    conversation_initiation_client_data: { custom_llm_extra_body: extra },
    metadata: { start_time_unix_secs: 200 },
    transcript: [{ role: "user", message: "How is the Services page doing?" }, { role: "agent", message: "Its title is fine." }],
    ...more,
  };
}

it("shows a browser call only when it carries a pass signed for this person", async () => {
  const own = { conversation_id: "voice-user-robin-1", user_auth: signPass(KEY, "kestrel", "user-robin", 1700000000) };
  const details: Record<string, unknown> = {
    conv_own: detail("conv_own", own),
    // Someone else's pass, a conversation id that is not Robin's, a forged signature, a phone call, another agent.
    conv_theirs: detail("conv_theirs", { conversation_id: "voice-user-robin-2", user_auth: signPass(KEY, "kestrel", "user-sam", 1700000000) }),
    conv_wrong_id: detail("conv_wrong_id", { ...own, conversation_id: "voice-user-sam-1" }),
    conv_forged: detail("conv_forged", { ...own, user_auth: signPass("another-key-entirely-0123456789abcdef", "kestrel", "user-robin", 1700000000) }),
    conv_phone: detail("conv_phone", own, { metadata: { start_time_unix_secs: 200, phone_call: { direction: "inbound" } } }),
    conv_agent: detail("conv_agent", own, { agent_id: "agent_other" }),
  };
  const read = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.search) {
      expect(url.searchParams.get("user_id")).toBe("user-robin");
      expect(url.searchParams.has("call_direction")).toBe(false);
      return Response.json({ conversations: Object.keys(details).map(id => ({ conversation_id: id, agent_id: "agent_demo_iris_0001", status: "done" })), has_more: false });
    }
    return Response.json(details[url.pathname.split("/").pop()!]);
  });
  const page = await pilotCalls("fixture", null, caller, read as typeof fetch);
  expect(page).toEqual({ records: [{ id: "conv_own", time: 200, turns: [{ who: "You", text: "How is the Services page doing?" }, { who: "Iris", text: "Its title is fine." }] }], cursor: null, incomplete: false });
  expect(await pilotCall("fixture", "conv_forged", caller, read as typeof fetch)).toBeNull();
});

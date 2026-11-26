import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { historyCaller } from "../src/lib/server/pilot-call-access";
import { irisLine, pilotCalls } from "../src/lib/server/iris-calls.mjs";

const caller = {phone: "+441632960100", since: null};
const pilot = {userId: "pilot-user", phone: "+441632960100", since: 1700000000};

beforeEach(() => {
  vi.stubEnv("IRIS_CALL_AGENT_ID", "agent_demo_iris_0001");
  vi.stubEnv("IRIS_CALL_BRANCH_ID", "agtbrch_demo_iris_0001");
  vi.stubEnv("IRIS_CALL_LINE", "+441632960001");
});
afterEach(() => vi.unstubAllEnvs());

it("limits history to a configured handset assignment on the Kestrel Garage Iris desk", () => {
  vi.stubEnv("KESTREL_HISTORY_CALLERS", JSON.stringify([pilot]));
  vi.stubEnv("IRIS_CALL_HISTORY_KEY", "");
  expect(historyCaller("robin@kestrel.example","kestrel","iris",pilot.userId)).toBeNull();
  vi.stubEnv("IRIS_CALL_HISTORY_KEY", "fixture");
  expect(historyCaller("robin@kestrel.example","kestrel","iris",pilot.userId)).toEqual({phone: pilot.phone, since: pilot.since});
  for (const [userId, client, agent] of [
    ["other-user","kestrel","iris"],["pilot-user","harbour","iris"],["pilot-user","kestrel","other-agent"],
  ]) expect(historyCaller("robin@kestrel.example",client,agent,userId)).toBeNull();
  expect(historyCaller("robin@kestrel.example","kestrel","iris")).toBeNull();
});

it("shows the desk's call link only for a valid configured line", () => {
  expect(irisLine()).toEqual({number: "+441632960001", label: "+441632960001"});
  vi.stubEnv("IRIS_CALL_LINE_LABEL", "01632 960001");
  expect(irisLine()).toEqual({number: "+441632960001", label: "01632 960001"});
  vi.stubEnv("IRIS_CALL_LINE", "01632 960001");
  expect(irisLine()).toBeNull();
});

it("finds no calls when the provider agent is not configured", async () => {
  vi.stubEnv("IRIS_CALL_AGENT_ID", "");
  const read = vi.fn(async (input: RequestInfo | URL) => new URL(String(input)).search
    ? Response.json({conversations:[{conversation_id:"conv_good",agent_id:"",branch_id:"agtbrch_demo_iris_0001",status:"done",direction:"inbound"}],has_more:false})
    : Response.json({}));
  expect((await pilotCalls("fixture", null, caller, read)).records).toEqual([]);
  expect(read).toHaveBeenCalledTimes(1);
});

it("checks each call detail, skips missing or unrelated calls and returns one pilot transcript", async () => {
  const agent_id="agent_demo_iris_0001",branch_id="agtbrch_demo_iris_0001";
  const ids=["conv_good","conv_good","conv_missing","conv_other","conv_branch"];
  const read=vi.fn(async (input: RequestInfo | URL) => {
    const url=new URL(String(input));
    const row=(id:string)=>({conversation_id:id,agent_id,branch_id,status:"done",direction:"inbound"});
    if(url.search){expect(url.searchParams.get("cursor")).toBe("next page");return Response.json({conversations:ids.map(row),has_more:true,next_cursor:"more"});}
    const id=url.pathname.split("/").pop()!;
    if(id==="conv_missing")return new Response(null,{status:410});
    return Response.json({...row(id),branch_id:id==="conv_branch"?"other":branch_id,
      metadata:{start_time_unix_secs:100,phone_call:{direction:"inbound",agent_number:"+441632960001",external_number:id==="conv_other"?"+441632960999":"+441632960100"}},
      transcript:[{role:"user",message:"Review Services."},{role:"tool",message:"hidden"}]});
  });
  expect(await pilotCalls("fixture","next page",caller, read)).toEqual({records:[{id:"conv_good",time:100,turns:[{who:"You",text:"Review Services."}]}],cursor:"more",incomplete:false});
  expect(read).toHaveBeenCalledTimes(5);
  await expect(pilotCalls("fixture",null,caller, async()=>new Response(null,{status:429}))).rejects.toThrow("unavailable");
});
const summary = {
  conversation_id: "conv_primary", agent_id: "agent_demo_iris_0001",
  branch_id: "agtbrch_demo_iris_0001", direction: "inbound", status: "done",
};
const phone = { direction: "inbound", agent_number: "+441632960001", external_number: "+441632960100" };

it("retains only verified calls when a neighboring detail times out and retries that same batch", async () => {
  let unavailable = true;
  const read = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.search) return Response.json({ conversations: ["conv_primary", "conv_slow", "conv_elsewhere"].map(
      id => ({ ...summary, conversation_id: id })), has_more: true, next_cursor: "later" });
    const id = url.pathname.split("/").pop();
    if (id === "conv_slow" && unavailable) return new Response(null, { status: 503 });
    return Response.json({ ...summary, conversation_id: id, metadata: { start_time_unix_secs: 100,
      phone_call: { ...phone, external_number: id === "conv_elsewhere" ? "+441632960101" : phone.external_number } } });
  };
  const partial = await pilotCalls("fixture", "current", caller, read);
  expect(partial).toMatchObject({ incomplete: true, cursor: "later" });
  expect(partial.records.map(r => r.id)).toEqual(["conv_primary"]);
  unavailable = false;
  const recovered = await pilotCalls("fixture", "current", caller, read);
  expect(recovered.cursor).toBe("later");
  expect(recovered.records.map(r => r.id)).toEqual(["conv_primary", "conv_slow"]);
});

it.each([null, "yesterday", 1e25])("keeps the transcript when its timestamp is invalid (%s)", async time => {
  const read = async (input: RequestInfo | URL) => Response.json(String(input).includes("?")
    ? { conversations: [null, summary] }
    : { ...summary, metadata: { phone_call: phone, start_time_unix_secs: time },
        transcript: [null, { role: "user", message: "Review Services." }] });
  expect((await pilotCalls("fixture", null, caller, read)).records).toEqual([
    { id: "conv_primary", time: null, turns: [{ who: "You", text: "Review Services." }] },
  ]);
});

it("keeps neighboring calls readable when one transcript has no turns yet", async () => {
  const read = async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.search) return Response.json({ conversations: [summary, { ...summary, conversation_id: "conv_wait" }] });
    const id = url.pathname.split("/").pop();
    return Response.json({ ...summary, conversation_id: id, metadata: { phone_call: phone, start_time_unix_secs: 100 },
      transcript: id === "conv_wait" ? null : [{ role: "agent", message: "Ready." }] });
  };
  expect((await pilotCalls("fixture", null, caller, read)).records).toEqual([
    { id: "conv_primary", time: 100, turns: [{ who: "Iris", text: "Ready." }] }, { id: "conv_wait", time: 100, turns: [] },
  ]);
});

it.each([["same", "same"], ["", ""], ["first", 42], ["first", "x".repeat(2049)]])(
  "stops pagination on a repeated or unusable continuation %#", async (cursor, next) => {
    const result = await pilotCalls("fixture", cursor, caller, async () => Response.json({
      conversations: [], has_more: true, next_cursor: next,
    }));
    expect(result.cursor).toBeNull();
  },
);

it("preserves the cursor when a page contains no eligible conversations", async () => {
  const read = vi.fn(async () => Response.json({ conversations: [{ ...summary, status: "processing" }],
    has_more: true, next_cursor: "older/+" }));
  expect(await pilotCalls("fixture", null, caller, read)).toEqual({ records: [], cursor: "older/+", incomplete: false });
  expect(read).toHaveBeenCalledTimes(1);
});

it("rejects conflicting handset assignments", () => {
  vi.stubEnv("IRIS_CALL_HISTORY_KEY", "test");
  const owner = {userId: "owner-id", phone: "+441632960102", since: 1700000000};
  for (const conflict of [{...owner, userId: "other"}, {...owner, phone: "+441632960103"}, {...pilot, phone: owner.phone}]) {
    vi.stubEnv("KESTREL_HISTORY_CALLERS", JSON.stringify([owner, conflict]));
    expect(historyCaller("owner@example.com", "kestrel", "iris", owner.userId)).toBeNull();
  }
  vi.stubEnv("KESTREL_HISTORY_CALLERS", JSON.stringify([owner, pilot]));
  expect(historyCaller("owner@example.com", "kestrel", "iris", owner.userId)).toEqual({phone: owner.phone, since: owner.since});
});

it.each([
  ["end_call tool was called.", false, "iris"],
  ["end_call tool was called.", true, undefined],
  ["Call ended by remote party", true, "phone"],
  ["Unknown reason", false, undefined],
  [undefined, false, undefined],
] as const)("reports the verified end of a phone call (%s, failed tool: %s)", async (reason, failed, expected) => {
  const read = async (input: RequestInfo | URL) => new URL(String(input)).search
    ? Response.json({ conversations: [summary], has_more: false })
    : Response.json({ ...summary, metadata: { phone_call: phone, termination_reason: reason },
      transcript: [{ role: "agent", tool_results: [{ tool_name: "end_call", is_error: failed }] }] });
  const { records } = await pilotCalls("fixture", null, caller, read);
  expect(records).toHaveLength(1);
  expect(records[0].turns).toEqual([]);
  expect("endedBy" in records[0] ? records[0].endedBy : undefined).toBe(expected);
});

it.each(["2026-03-29", "2026-10-25"])("limits the provider search around the requested UK day %s", async day => {
  const read = vi.fn(async (input: RequestInfo | URL) => {
    const query = new URL(String(input)).searchParams;
    expect(Number(query.get("call_start_after_unix"))).toBe(Date.parse(day + "T00:00:00Z") / 1000 - 3600 - 1);
    expect(Number(query.get("call_start_before_unix"))).toBe(Date.parse(day + "T00:00:00Z") / 1000 + 86400);
    expect(query.get("cursor")).toBe("next");
    return Response.json({ conversations: [], has_more: false });
  });
  await pilotCalls("fixture", "next", caller, read, day);
  expect(read).toHaveBeenCalledOnce();
});

it("logs only the operation and status when the provider rejects the History credential", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const denied = async () => new Response("private provider diagnostic", { status: 401 });
    await expect(pilotCalls("private credential", "private cursor", caller, denied)).rejects.toThrow("Call history unavailable");
    expect(warn.mock.calls).toEqual([["Iris History provider error", { operation: "list", status: 401 }]]);
  } finally {
    warn.mockRestore();
  }
});

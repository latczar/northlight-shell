import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PilotCallHistory from "../src/app/(app)/c/[client]/[agent]/calls/page";

const { read, viewer, grant } = vi.hoisted(() => ({
  read: vi.fn(), viewer: vi.fn(), grant: vi.fn(),
}));
vi.mock("@/lib/server/iris-calls.mjs", () => ({ pilotCalls: read }));
vi.mock("@/lib/server/session", () => ({ requireViewer: viewer, requireAgent: grant }));
const page = (query: {cursor?: string | string[]; topic?: string; day?: string} = {}, client = "kestrel", agent = "iris") =>
  PilotCallHistory({params: Promise.resolve({ client, agent }), searchParams: Promise.resolve(query)});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("IRIS_CALL_HISTORY_KEY", "fixture");
  vi.stubEnv("KESTREL_HISTORY_CALLERS", JSON.stringify([{ userId: "pilot-user", phone: "+441632960100", since: 1700000000 }]));
  viewer.mockResolvedValue({email: "robin@kestrel.example", userId: "pilot-user", access:{grants:[]}});
});
afterEach(() => vi.unstubAllEnvs());

describe("pilot history on the signed-in desk", () => {
  it.each(["2026-02-29", "2026-13-01", "2026-04-31"])("rejects impossible call date %s before querying History", async day => {
    await expect(page({ day })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it("stops at sign-in before checking the grant or calling the provider", async () => {
    viewer.mockRejectedValue(new Error("sign in"));
    await expect(page()).rejects.toThrow("sign in");
    expect(grant).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("rechecks the agent grant even for a known pilot with a cursor", async () => {
    grant.mockImplementation(() => { throw new Error("access revoked"); });
    await expect(page({cursor:"page two"})).rejects.toThrow("access revoked");
    expect(read).not.toHaveBeenCalled();
  });

  it("returns staff to the same page of calls after signing in again", async () => {
    viewer.mockRejectedValue(new Error("sign in"));
    await expect(page({ cursor: "next/+ page" })).rejects.toThrow("sign in");
    expect(viewer).toHaveBeenCalledWith("/c/kestrel/iris/calls?cursor=next%2F%2B%20page");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["other-user", "kestrel", "iris", "fixture"],
    ["pilot-user", "harbour", "iris", "fixture"],
    ["pilot-user", "kestrel", "other-agent", "fixture"],
    ["pilot-user", "kestrel", "iris", ""],
  ])("hides an unavailable pilot route before reading transcripts %#", async (userId, client, agent, key) => {
    viewer.mockResolvedValue({email: "robin@kestrel.example", userId});
    vi.stubEnv("IRIS_CALL_HISTORY_KEY", key);
    await expect(page({},client,agent)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([{cursor:["a","b"]},{cursor:"a".repeat(2049)}])("refuses invalid pagination before reading records %#", async query => {
    await expect(page(query)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps a usable retry link to the same page on a provider outage", async () => {
    read.mockRejectedValue(new Error("upstream offline"));
    const html = renderToStaticMarkup(await page({cursor:"two /+"}));
    expect(html).toContain("Call history could not be loaded");
    expect(html).toContain("cursor=two%20%2F%2B");
    expect(html).not.toContain("No pilot calls");
    expect(html).not.toContain("upstream offline");
  });

  it("finds an older topic on the UK calendar day and skips unrelated transcripts", async () => {
    const time = Date.parse("2026-11-24T20:00:00Z") / 1000;
    read.mockResolvedValueOnce({ records: [], cursor: "older" }).mockResolvedValueOnce({
      records: [
        { id: "correct", time, turns: [{ who: "You", text: "Check our Services page." }] },
        { id: "tomorrow", time: time + 86400, turns: [{ who: "You", text: "Services tomorrow." }] },
        { id: "other", time, turns: [{ who: "You", text: "Check the homepage." }] },
      ], cursor: null,
    });
    const html = renderToStaticMarkup(await page({ topic: "SERVICES", day: "2026-11-24" }));
    expect(read).toHaveBeenCalledTimes(2);
    expect(html).toContain("Check our Services page.");
    expect(html).not.toContain("Services tomorrow.");
    expect(html).not.toContain("Check the homepage.");
  });

  it("keeps both repeated Sunday hours in UK and excludes adjacent calendar days", async () => {
    const times = ["2026-10-24T22:59:59Z", "2026-10-24T23:00:00Z", "2026-10-25T00:30:00Z",
      "2026-10-25T01:30:00Z", "2026-10-25T23:59:59Z", "2026-10-26T00:00:00Z"];
    read.mockResolvedValue({ records: times.map((utc, i) => ({ id: "call_" + i, time: Date.parse(utc) / 1000,
      turns: [{ who: "You", text: "Services" }] })), cursor: null });
    const html = renderToStaticMarkup(await page({ day: "2026-10-25" }));
    for (const i of [1, 2, 3, 4]) expect(html).toContain('id="call_' + i + '"');
    for (const i of [0, 5]) expect(html).not.toContain('id="call_' + i + '"');
    expect(html).toContain("01:30 BST");
    expect(html).toContain("01:30 GMT");
  });

  it("keeps earlier matches and resumes at the failed provider page", async () => {
    read.mockResolvedValueOnce({
      records: [{ id: "conv_kept", time: 1795559105, turns: [{ who: "You", text: "November checklist" }] }],
      cursor: "older /+",
    }).mockRejectedValueOnce(new Error("provider offline"));
    const html = renderToStaticMarkup(await page({ topic: "November checklist", day: "2026-11-24" }));
    expect(html).toContain("conv_kept");
    expect(html).toContain("Some older calls could not be loaded");
    expect(html).toContain("topic=November%20checklist&amp;day=2026-11-24&amp;cursor=older%20%2F%2B");
    expect(html).not.toContain("No matching calls");
  });

  it("distinguishes an interrupted search with zero matches so far from a completed empty search", async () => {
    read.mockResolvedValueOnce({ records: [], cursor: "older" }).mockRejectedValueOnce(new Error("timeout"));
    const html = renderToStaticMarkup(await page({ topic: "November" }));
    expect(html).toContain("Some older calls could not be loaded");
    expect(html).not.toContain("No matching calls in this range");
    expect(html).toContain("cursor=older");
  });

  it("preserves verified rows and retries the same page when one transcript is unavailable", async () => {
    read.mockResolvedValue({ records: [{ id: "conv_verified", time: null, turns: [{ who: "You", text: "Services" }] }],
      cursor: null, incomplete: true });
    const html = renderToStaticMarkup(await page({ topic: "Services" }));
    expect(html).toContain("conv_verified");
    expect(html).toContain("Some transcripts could not be loaded.");
    expect(html).toContain('href="/c/kestrel/iris/calls?topic=Services"');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("retains filters when more history is available", async () => {
    let pageNumber = 0;
    read.mockImplementation(async () => ({ records: [], cursor: String(++pageNumber) }));
    const html = renderToStaticMarkup(await page({ topic: "Services", day: "2026-11-24" }));
    expect(read).toHaveBeenCalledTimes(8);
    expect(html).toContain("topic=Services&amp;day=2026-11-24&amp;cursor=8");
    expect(html).toContain("Search older calls");
  });

  it("displays the missing date and transcript explicitly while retaining pagination", async () => {
    read.mockResolvedValue({records:[{id:"conv_wait", time:null,turns:[]}],cursor:"older /+"});
    const html=renderToStaticMarkup(await page());
    expect(html).toContain("Call time unavailable");
    expect(html).toContain("No transcript is available for this call.");
    expect(html).toContain("cursor=older%20%2F%2B");
    expect(html).not.toContain("No pilot calls on this page.");
  });
});

describe("finding one Services call among repeated staff tests", () => {
  const records = [
    { id: "conv_first", time: Date.parse("2026-11-25T16:00Z") / 1000, turns: [
      { who: "You", text: "Winter inspection. Check Kestrel Garage's Services page." },
      { who: "Iris", text: "I can review the brake repair title." },
    ] },
    { id: "conv_retry", time: Date.parse("2026-11-25T16:05Z") / 1000, turns: [
      { who: "You", text: "Winter inspection checklist. Check Kestrel Garage’s Services page." },
      { who: "Iris", text: "The main heading mentions brakes and tyres." },
    ] },
    { id: "conv_prior", time: Date.parse("2026-11-24T22:00Z") / 1000, turns: [
      { who: "You", text: "Winter inspection checklist from yesterday." },
    ] },
  ];
  it.each([
    ["same topic, same day", "winter inspection", "2026-11-25", ["conv_first", "conv_retry"]],
    ["specific follow-up", "inspection checklist", "2026-11-25", ["conv_retry"]],
    ["different local day", "inspection checklist", "2026-11-24", ["conv_prior"]],
    ["straight apostrophe", "Kestrel Garage's Services", "2026-11-25", ["conv_first", "conv_retry"]],
    ["smart apostrophe", "Kestrel Garage’s Services", "2026-11-25", ["conv_first", "conv_retry"]],
    ["pasted whitespace", "Winter   inspection", "2026-11-25", ["conv_first", "conv_retry"]],
    ["agent reply", "BRAKES AND TYRES", "2026-11-25", ["conv_retry"]],
    ["unknown topic", "aircraft overhaul", "2026-11-25", []],
  ] as const)("%s", async (_name, topic, day, expected) => {
    read.mockResolvedValue({ records, cursor: null });
    const html = renderToStaticMarkup(await page({ topic, day }));
    expect([...html.matchAll(/<details id="([^"]+)"/g)].map(match => match[1])).toEqual(expected);
    if (expected.length) expect(html).toContain("line-clamp-2");
  });
});

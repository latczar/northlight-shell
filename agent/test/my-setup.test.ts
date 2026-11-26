import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CLIENTS } from "../clients";
import type { JsonObject, ToolContext } from "../src/contracts";
import { mySetup } from "../tools";

const kestrel = CLIENTS.find(client => client.id === "kestrel")!;
const settings = kestrel.agentSettings!.iris;
const auth = { authorization: "Bearer test-token-kestrel-0123456789abcdef" };
type Items = { ready: boolean; items: { id: string; connected: boolean; missing: string[] }[] };

/** A tool context for one agent where only `present` env vars are configured. */
function context(clientId: string, agentId: string, present: string[], agentSettings: JsonObject = {}): ToolContext {
  return { clientId, agentId, settings: agentSettings, hasSecret: (name: string) => present.includes(name) } as unknown as ToolContext;
}

describe("my_setup", () => {
  it("tells Iris what it is missing by name, matching the dashboard's setup route, and never a value", async () => {
    const route = await (await SELF.fetch("https://brain/v1/agents/iris/setup", { headers: auth })).json() as Items;
    const same = (await mySetup.execute(context("kestrel", "iris", [], settings), {})).data as Items;
    expect(same.items.map(i => [i.id, i.missing])).toEqual(route.items.map(i => [i.id, i.missing]));
    // Without a website, Iris says which setting is missing.
    const unset = (await mySetup.execute(context("kestrel", "iris", [], { ...settings, site: "" }), {})).data as Items;
    expect(unset.items.find(i => i.id === "website")).toMatchObject({ connected: false, missing: ["site"] });
  });

  it("reports the calling agent's own setup, not another agent's", async () => {
    const iris = ((await mySetup.execute(context("kestrel", "iris", [], settings), {})).data as Items).items.map(i => i.id);
    expect(iris).toEqual(["website"]);
    const third = ((await mySetup.execute(context("acme", "third", []), {})).data as Items).items.map(i => i.id);
    expect(third).toEqual(["site", "search"]);
  });
});

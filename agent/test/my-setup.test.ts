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
    // The test desk holds the release credential only (vitest.config.ts), so the tool is given the same.
    const route = await (await SELF.fetch("https://brain/v1/agents/iris/setup", { headers: auth })).json() as Items;
    const same = (await mySetup.execute(context("kestrel", "iris", ["KESTREL_RELEASE_GITHUB_TOKEN"], settings), {})).data as Items;
    expect(same.items.map(i => [i.id, i.missing])).toEqual(route.items.map(i => [i.id, i.missing]));
    const data = (await mySetup.execute(context("kestrel", "iris", [], settings), {})).data as Items;
    expect(data.items.find(i => i.id === "release_lookup")).toMatchObject({ connected: false, missing: ["KESTREL_RELEASE_GITHUB_TOKEN"] });
    expect(data.items.find(i => i.id === "preview_repo")).toMatchObject({ connected: false, missing: ["KESTREL_PREVIEW_GITHUB_TOKEN"] });

    // With the release credential set, release lookup flips to connected; the secret's value is never returned.
    const withRelease = await mySetup.execute(context("kestrel", "iris", ["KESTREL_RELEASE_GITHUB_TOKEN"], settings), {});
    expect((withRelease.data as Items).items.find(i => i.id === "release_lookup")).toMatchObject({ connected: true, missing: [] });
    expect(JSON.stringify(withRelease)).not.toContain("kestrel-release-test-only");
  });

  it("reports the calling agent's own setup, not another agent's", async () => {
    const iris = ((await mySetup.execute(context("kestrel", "iris", [], settings), {})).data as Items).items.map(i => i.id);
    expect(iris).toEqual(["website", "release_lookup", "preview_repo"]);
    const third = ((await mySetup.execute(context("acme", "third", []), {})).data as Items).items.map(i => i.id);
    expect(third).toEqual(["site", "search"]);
  });
});

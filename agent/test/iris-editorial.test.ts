import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { AGENTS } from "../agents";
import { CLIENTS } from "../clients";
import { TOOLS } from "../tools";
import { runTurn, decideAction, type TurnDeps } from "../src/loop";
import type { ToolContext } from "../src/contracts";
import { reviewCopy } from "../agents/iris/editorial";
import { requestEditorialRevision } from "../agents/iris/revisions";
import type { Approval } from "../src/dashboard";
import { Store } from "../src/store";
import { noDesk } from "./desk";
const SITE = String(CLIENTS.find(c => c.id === "kestrel")!.agentSettings!.iris.site);

describe("Iris editorial workflow", () => {
  it.each([
    ["/repairs/", "title", true],
    ["/repairs", "title", true],
    ["/services/", "title", false],
    ["/repairs/?view=private", "title", false],
    ["/repairs/", "description", false],
  ] as const)("limits a call draft to the configured page title (%s, %s)", async (path, field, allowed) => {
    const context = {
      agentId: "iris", userId: "staff", mayManageAgent: async () => true,
      settings: { site: "https://shop.example", servicesPagePath: "/repairs/" },
      request: { servicesCallId: "conv_services" },
      actionResult: () => ({ data: { url: "https://shop.example" + path, title: "Repairs", description: "", h1: ["Brakes"] } }),
    } as unknown as ToolContext;
    const result = reviewCopy.approval!(context, { field, proposed: "Brake Repair", reason: "Name the service.", pageActionId: "read" });
    if (allowed) await expect(result).resolves.toMatchObject({ preview: { sourceCall: "conv_services", proposed: "Brake Repair" } });
    else await expect(result).rejects.toThrow("audited Services page");
  });

  it.each([
    ["iris", "submit_seo_copy", undefined, "Kestrel's & Sons"],
    ["iris", "submit_seo_copy", "plain", "Kestrel&#39;s &amp; Sons"],
    ["iris", "other_tool", undefined, "Kestrel&#39;s &amp; Sons"],
    ["another-agent", "submit_seo_copy", undefined, "Kestrel&#39;s &amp; Sons"],
  ] as const)("reads stored evidence once and preserves the decision for %s / %s / %s", async (agent, tool, format, expected) => {
    const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName("kestrel"));
    const id = crypto.randomUUID();
    const preview = { current: "Kestrel&#39;s &amp; Sons", field: "title", proposed: "Proposed &amp; literal", pageTextFormat: format };
    await dashboard.propose({ id, requestedBy: "staff", source: "app", agent, conversationId: id, tool,
      title: "Review title", summary: "Services", previewJson: JSON.stringify(preview) });
    await dashboard.decide(id, false, "reviewer", "Keep the &amp; literal");
    const read = async () => JSON.parse((await dashboard.approvalJson(id))!);
    const first = await read();
    expect(first).toMatchObject({ id, status: "declined", reason: "Keep the &amp; literal",
      preview: { current: expected, proposed: preview.proposed } });
    expect(await read()).toEqual(first);
  });

  it("flags British tyre spelling before staff see the draft", async () => {
    const context = { clientId: "kestrel", agentId: "iris", userId: "staff", mayManageAgent: async () => true,
      settings: { site: SITE, copyLocale: "en-US" }, actionResult: () => ({ data: { url: SITE + "/",
        title: "Tire service", description: "", h1: ["Tires"] } }) } as unknown as ToolContext;
    await expect(reviewCopy.approval!(context, { field: "title", proposed: "Tyres in Milbrook", reason: "Location", pageActionId: "p" }))
      .rejects.toThrow("US spelling");
  });

  it.each([false, true])("preserves a decline and returns the same revision after retry (from call: %s)", async fromCall => {
    const client = CLIENTS.find(c => c.id === "kestrel")!;
    const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id));
    const id = crypto.randomUUID();
    const preview = { url: fromCall ? SITE + "/services/" : SITE + "/", field: "title", proposed: "Original title", ...(fromCall ? { sourceCall: "conv_november" } : {}) };
    const draft = { id, requestedBy: "staff:requester", source: "app" as const, agent: "iris", conversationId: id, tool: "submit_seo_copy",
      title: "Homepage title", summary: "Review the title", previewJson: JSON.stringify(preview) };
    await dashboard.propose(draft);
    const original = async (): Promise<Approval> => JSON.parse((await dashboard.approvalJson(id))!);
    expect((await requestEditorialRevision(env, client, await original())).status).toBe(409);
    await dashboard.decide(id, false, "reviewer", "Mention Milbrook first.");
    const parent = await original();
    expect((await requestEditorialRevision(env, client, { ...parent, reason: "" })).status).toBe(409);
    expect((await requestEditorialRevision(env, client, { ...parent, tool: "build_homepage_preview" })).status).toBe(409);
    const conversationId = "editorial-revision/" + id;
    const conversation = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("kestrel/iris/" + conversationId));
    await runInDurableObject(conversation, instance => {
      instance.model = { async turn() {
        return { content: "No draft available.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      } };
    });
    expect((await requestEditorialRevision(env, client, parent)).status).toBe(503);
    expect(await original()).toEqual(parent);
    await runInDurableObject(conversation, instance => {
      instance.catalog = { ...TOOLS, review_site_page: { ...TOOLS.review_site_page, execute: async () => ({
        data: { url: preview.url, title: "Current title", description: "", h1: ["Auto Repair"] }
      }) } };
      let step = 0;
      instance.model = { async turn(request) {
        expect(request.tools?.map(tool => tool.name).sort()).toEqual(["review_site_page", "submit_seo_copy"]);
        const calls = [
          { id: "page-" + id, name: "review_site_page", args: {} },
          { id: "copy-" + id, name: "submit_seo_copy", args: { pageActionId: "page-" + id, field: "title",
            proposed: "Milbrook auto repair", reason: "Lead with the city." } }
        ];
        const next = calls[step++];
        return { content: next ? "" : "Ready for approval.", toolCalls: next ? [{ id: next.id, type: "function",
          function: { name: next.name, arguments: JSON.stringify(next.args) } }] : [], usage: { inputTokens: 1, outputTokens: 1 } };
      } };
    });
    const result = await requestEditorialRevision(env, client, parent);
    expect(result.status).toBe(200);
    const child = JSON.parse(result.body!);
    expect(child).toMatchObject({ id: "copy-" + id, status: "pending", requestedBy: "staff:requester", preview: { revisionOf: id, reviewerFeedback: parent.reason } });
    expect(child.preview.sourceCall).toBe(preview.sourceCall);
    await runInDurableObject(dashboard, async instance => {
      await expect(instance.propose({ ...draft, singleProposal: true, conversationId, id: crypto.randomUUID() })).rejects.toThrow("already has a revision");
    });
    expect(await requestEditorialRevision(env, client, parent)).toEqual(result);
    expect(await original()).toEqual(parent);
  });

  it("requires revised copy to change the wording on the original page and field", async () => {
    const previous = { id: "original", url: SITE + "/", field: "title", proposed: "Previous title", feedback: "Lead with the city" };
    const context = { clientId: "kestrel", agentId: "iris", settings: { site: previous.url },
      request: { editorialRevision: previous }, actionResult: () => ({ data: {
        url: previous.url, title: "Current title", description: "Current description", h1: ["Auto Repair"] } })
    } as unknown as ToolContext;
    const args = { pageActionId: "page", field: "title", proposed: "Milbrook auto repair", reason: "Lead with the city" };
    for (const change of [{ proposed: "previous TITLE" }, { field: "description" }]) {
      await expect(reviewCopy.approval!(context, { ...args, ...change })).rejects.toThrow("same page and field");
    }
    expect(await reviewCopy.approval!(context, args)).toMatchObject({ preview: { revisionOf: previous.id, reviewerFeedback: previous.feedback } });
  });

  it.each(["approved", "declined", "visitor"])("handles a %s review", async mode => {
    const client = CLIENTS.find(c => c.id === "kestrel")!;
    const conversationId = crypto.randomUUID();
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("kestrel/iris/" + conversationId));
    await runInDurableObject(stub, async (_, state) => {
      const store = new Store(state.storage);
      store.bind(client.id, "iris");
      const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id));
      const page = { url: SITE + "/", title: "Services", description: "", h1: ["Auto Repair"] };
      const steps = [
        { name: "review_site_page", args: {} },
        { name: "submit_seo_copy", args: { pageActionId: "page-" + conversationId, field: "title", proposed: "Auto Repair in Milbrook", reason: "Identify the city." } },
        { name: "post_seo_report", args: { kind: "report", title: "Homepage review", summary: "Checked page title", sourceActionIds: ["page-" + conversationId] } },
      ];
      let step = 0;
      const ids = ["page-", "draft-", "report-"].map(s => s + conversationId);
      const deps: TurnDeps = { client, store, agent: AGENTS["iris"], catalog: { ...TOOLS,
        review_site_page: { ...TOOLS.review_site_page, execute: async () => ({ data: page }) } },
        conversationId, bindings: env, desk: noDesk, modelKey: () => "model", emit: () => {},
        request: mode === "visitor" ? undefined : { id: "weekly", text: "Review the homepage", scheduleId: "iris-weekly-homepage" },
        model: { async turn() {
          const next = steps[step];
          const toolCalls = next ? [{ id: ids[step++], type: "function" as const,
            function: { name: next.name, arguments: JSON.stringify(next.args) } }] : [];
          return { content: next ? "" : "Finished.", toolCalls, usage: { inputTokens: 1, outputTokens: 1 } };
        } } };
      const previous = JSON.parse(await dashboard.snapshots("iris")).snapshots.approved_seo_copy;
      const siteCopy = async () => JSON.parse(await dashboard.snapshots("iris")).snapshots.site_copy?.data;
      const siteBefore = await siteCopy();
      await runTurn(deps, { id: "first", text: "Run iris-weekly-homepage" });
      expect(await dashboard.hasReportFromConversation(conversationId)).toBe(mode !== "visitor");
      const saved = async () => JSON.parse(await dashboard.snapshots("iris")).snapshots.approved_seo_copy;
      expect(await saved()).toEqual(previous);
      if (mode === "visitor") return;
      const yes = mode === "approved";
      await dashboard.decide(ids[1], yes, "tester", "");
      await decideAction(deps, ids[1], yes, "");
      if (yes) expect((await saved()).data).toMatchObject({ current: page.title, status: "approved_for_implementation" });
      else expect(await saved()).toEqual(previous);
      // approved wording waits in the site's Preview; nothing goes Live until someone publishes
      if (yes) expect(await siteCopy()).toMatchObject({ live: siteBefore?.live ?? {}, pending: { "/": { title: { text: "Auto Repair in Milbrook", replaces: page.title } } } });
      else expect(await siteCopy()).toEqual(siteBefore);
    });
  });
});


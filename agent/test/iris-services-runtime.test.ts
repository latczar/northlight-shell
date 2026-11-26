import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { AGENTS } from "../agents";
import { CLIENTS } from "../clients";
import { TOOLS } from "../tools";
import { servicesPreview as preview } from "../agents/iris/services-preview";
import type { ToolContext } from "../src/contracts";
import { decideAction, runTurn, type TurnDeps } from "../src/loop";
import { Store } from "../src/store";
import { noDesk } from "./desk";
import { fixture } from "./fixtures/iris/services-preview";

it.each(["preflight outage", "lost create response"])("recovers a Services approval after %s", async mode => {
  const repo = fixture(mode === "lost create response");
  const client = CLIENTS.find(c => c.id === "kestrel")!;
  const conversationId = crypto.randomUUID();
  const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("kestrel/iris/" + conversationId));
  await runInDurableObject(stub, async (_, state) => {
    const store = new Store(state.storage);
    const userId = "staff:pilot-manager";
    store.bind(client.id, "iris", userId);
    const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id));
    const roles = { "iris": [userId] };
    await dashboard.setApprovers(1, roles, roles);
    const inspect = "inspect-" + conversationId;
    const first = "build-" + conversationId;
    const second = "retry-" + conversationId;
    const args = { ...repo.args, pageActionId: inspect };
    const queue = [
      { id: inspect, name: "review_site_page", args: {} },
      { id: first, name: preview.name, args },
    ];
    // Replace only GitHub transport. The approval, action store and reconciliation are real.
    const wired = (ctx: ToolContext): ToolContext => ({ ...ctx, connection: repo.context.connection });
    const deps: TurnDeps = { store, client, agent: AGENTS["iris"], userId, source: "app", conversationId,
      // The fixture's repo (a root site.json on staging) and a named pilot manager; the production list starts empty.
      settings: { ...client.agentSettings!.iris, ...repo.context.settings, site: client.agentSettings!.iris.site, siteFile: "site.json", servicesPreviewStaff: [userId] },
      bindings: env, desk: noDesk, modelKey: () => "test", emit: () => {},
      catalog: { ...TOOLS, review_site_page: { ...TOOLS.review_site_page, execute: async () => ({ data: {
        url: new URL("/services/", String(client.agentSettings!.iris.site)).href, h1: ["Services"], title: "Services | Kestrel Garage",
      } }) }, [preview.name]: { ...preview,
        approval: (ctx,a) => preview.approval!(wired(ctx),a), writePlan: (ctx,a) => preview.writePlan!(wired(ctx),a),
        execute: (ctx,a) => preview.execute(wired(ctx),a), reconcile: (ctx,a) => preview.reconcile!(wired(ctx),a),
      } }, model: { async turn() {
        const step = queue.shift();
        return { content: step ? "" : "Done.", toolCalls: step ? [{ id:step.id, type:"function" as const,
          function:{ name:step.name, arguments:JSON.stringify(step.args) } }] : [], usage:{ inputTokens:1, outputTokens:1 } };
      } },
    };
    const approve = async (id: string) => {
      expect(store.action(id)?.status, store.action(id)?.error).toBe("awaiting_approval");
      await dashboard.decide(id,true,userId,"");
      return decideAction(deps,id,true,"",undefined,await dashboard.writePlan(id));
    };
    await runTurn(deps,{ id:"initial", text:"Inspect Services and propose the title." });
    if (mode === "preflight outage") {
      repo.setOffline(true);
      expect((await approve(first)).status).toBe("failed");
      expect(repo.writes).toEqual([]);
      repo.setOffline(false);
      queue.push({id:second, name:preview.name, args});
      await runTurn(deps,{id:"retry",text:"Try a fresh proposal."});
      expect((await approve(second)).status).toBe("done");
    } else {
      expect((await approve(first)).status).toBe("uncertain");
      repo.advanceBase();
      await runTurn(deps,{id:"recover",text:"Find the existing preview."});
      expect(store.action(first)).toMatchObject({status:"succeeded",result:{data:{number:123,draft:true}}});
    }
    expect(repo.writes).toEqual(["git/refs","contents/site.json","pulls"]);
  });
});

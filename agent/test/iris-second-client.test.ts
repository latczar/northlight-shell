import { describe, expect, it } from "vitest";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { CLIENTS } from "../clients";
import { validateClient } from "../src/connections";
import { Store } from "../src/store";
import { signUserPass } from "../src/user-auth";
import { client } from "./fixtures/iris/client";

describe("Iris for a second sandbox client", () => {
  it("inspects, reports, revises and approves through signed staff routes within the client's scope", async () => {
    const agent = "iris", who = "staff:editor", cid = crypto.randomUUID();
    const dashboard = env.DASHBOARD.get(env.DASHBOARD.idFromName(client.id));
    const expires = Math.floor(Date.now()/1000) + 300;
    const pass = await signUserPass("test-user-northwind-0123456789abcdef", client.id, who, expires);
    const approver = await signUserPass("test-approver-northwind-0123456789abcdef", client.id, who, expires, "approve");
    const headers = { authorization: "Bearer test-northwind-0123456789abcdef", "content-type": "application/json" };
    const api = (path: string, body?: object, extra = {}) => SELF.fetch("https://brain/v1/" + path, {
      method: body ? "POST" : "GET", headers: { ...headers, ...extra }, body: body ? JSON.stringify(body) : undefined,
    });
    const decide = (id: string, decision: string, reason = "") => api("approvals/" + id, { decision, reason }, { "x-approver-pass": approver });
    async function script(conversation: string, calls: {name: string; args: object; id: string}[]) {
      const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(client.id+"/"+agent+"/"+conversation));
      await runInDurableObject(stub, instance => {
        let step = 0;
        instance.model = { async turn() {
          const next = calls[step++];
          return { content: next ? "" : "Review complete.", toolCalls: next ? [{ id: next.id, type: "function",
            function: { name: next.name, arguments: JSON.stringify(next.args) } }] : [], usage: { inputTokens: 1, outputTokens: 1 } };
        } };
      });
    }
    validateClient(client, CLIENTS.map(c => c.id));
    CLIENTS.push(client);
    try {
      await dashboard.setApprovers(1, { [agent]: [who] }, { [agent]: [who, "staff:second-manager"] });
      const draft = "draft-" + cid, page = "page-" + cid;
      await script(cid, [
        { id: page, name: "review_site_page", args: {} },
        { id: "release-"+cid, name: "find_deployed_pull", args: {} },
        { id: draft, name: "submit_seo_copy", args: {pageActionId:page,field:"description", proposed:"Bicycle repairs and tyres in York",reason:"Name the service and location."} },
        { id: "report-"+cid, name:"post_seo_report",args:{kind:"report",title:"Homepage review",summary:"Reviewed workshop services",sourceActionIds:[page]} },
      ]);
      const chat = await api("agents/"+agent+"/conversations/"+cid+"/messages", {id:cid,text:"Inspect the homepage, check the release, and submit a proposal and report.",userAuth:pass});
      expect(chat.status).toBe(200);
      await chat.text();
      const conversation = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName([client.id, agent, cid].join("/")));
      const release = await runInDurableObject(conversation, (_, state) =>
        new Store(state.storage).action("release-" + cid)?.result?.data);
      expect(release).toMatchObject({mergedPrUrl:"https://github.com/cycle-co/northwind/pull/7"});
      const original = await (await api("approvals/"+draft)).json() as {preview:object; requestedBy:string};
      expect(original).toMatchObject({requestedBy:who,preview:{url:"https://northwind.example/",current:"Bicycle repairs",proposed:"Bicycle repairs and tyres in York"}});
      expect(await dashboard.hasReportFromConversation(cid)).toBe(true);
      expect((await decide(draft,"decline","Lead with York")).status).toBe(200);
      const revisionId = "revision-"+cid;
      await script("editorial-revision/"+draft, [
        { id:"recheck-"+cid,name:"review_site_page",args:{} },
        { id:"duplicate-city-"+cid,name:"submit_seo_copy",args:{pageActionId:"recheck-"+cid,field:"description",proposed:"York cycle workshop in YORK for repairs",reason:"Lead with York."} },
        { id:revisionId,name:"submit_seo_copy",args:{pageActionId:"recheck-"+cid,field:"description",proposed:"York bicycle repairs and tyres",reason:"Lead with York as requested."} },
      ]);
      expect(await (await decide(draft,"revise")).json()).toMatchObject({id:revisionId,requestedBy:who,status:"pending",preview:{revisionOf:draft}});
      expect(await (await decide(draft,"revise")).json()).toMatchObject({id:revisionId});
      expect(await (await decide(revisionId,"approve")).json()).toMatchObject({status:"done"});
      expect(await (await api("approvals/"+draft)).json()).toMatchObject({status:"declined",preview:original.preview});
      const leeHeaders = {authorization:"Bearer test-token-kestrel-0123456789abcdef"};
      expect((await api("approvals/"+revisionId,undefined,leeHeaders)).status).toBe(404);
      const build = await api("agents/"+agent+"/homepage-preview", {first:"York",second:"Cycle Workshop"},{"x-user-pass":pass});
      expect(await build.json()).toMatchObject({status:"already_applied",mergedPrUrl:"https://github.com/cycle-co/northwind/pull/7"});
      const secondPass = await signUserPass("test-user-northwind-0123456789abcdef", client.id, "staff:second-manager", expires);
      for (let attempt = 0; attempt < 2; attempt++) {
        const requests = [pass, secondPass].map(person => api("agents/"+agent+"/homepage-preview",
          {first:"York",second:"Bicycle Repairs"},{"x-user-pass":person}));
        for (const preview of await Promise.all(requests)) {
          expect(await preview.json()).toMatchObject({url:"https://github.com/cycle-co/northwind/pull/8",reviewer:"cycle-editor"});
        }
      }
      const blocked = await env.DESK.send({clientId:client.id,agentId:agent,toolName:"build_homepage_preview",actionId:"scope",
        connection:"northwind_build",method:"POST",url:"https://api.github.com/repos/latczar/northlight-shell/git/refs",headers:{},body:"{}"});
      expect(blocked.status).toBe("refused");
    } finally { CLIENTS.splice(CLIENTS.indexOf(client),1); }
  });
});

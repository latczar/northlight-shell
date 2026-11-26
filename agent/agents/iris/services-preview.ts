import type { JsonObject, PlannedRequest, ToolContext, ToolDefinition } from "../../src/contracts";
import { ToolError } from "../../src/errors";
import { repositorySettings } from "./build";

const fail = (message: string) => new ToolError(message, true);

async function proposal(context: ToolContext, args: JsonObject) {
  const staff = context.settings.servicesPreviewStaff;
  if (!context.userId || !Array.isArray(staff) || !staff.includes(context.userId) || !await context.mayManageAgent?.()) {
    throw fail("This preview requires a signed-in staff pilot manager.");
  }
  const inspection = context.actionResult(String(args.pageActionId))?.data;
  const url = new URL("/services/", String(context.settings.site)).href;
  if (inspection?.url !== url || !Array.isArray(inspection.h1) || typeof inspection.title !== "string" || !inspection.title.trim()) {
    throw fail("Inspect the Services page first.");
  }
  const proposed = args.proposed;
  if (typeof proposed !== "string" || proposed !== proposed.trim() || !proposed || proposed.length > 150 ||
      /[<>\u0000-\u001f\uFFFD]/u.test(proposed) || proposed === inspection.title) throw fail("Provide a different plain-text Services title.");
  return { url, current: inspection.title, proposed };
}

async function prepare(context: ToolContext, args: JsonObject) {
  const title = await proposal(context, args);
  const { repo, base, file: siteFile } = repositorySettings(context.settings);
  const connection = String(context.settings.previewConnection);
  const github = context.connection(connection);
  const root = "https://api.github.com/repos/" + repo;
  let dispatched = false;
  async function read<T>(path: string): Promise<T> {
    try {
      const response = await github.fetch(root + path);
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.json<T>();
    } catch {
      throw new ToolError("GitHub could not verify " + path + ". Check the connection and try again.", !dispatched);
    }
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([context.clientId, context.conversationId, context.actionId, title])));
  const branch = "iris-services-" + Array.from(new Uint8Array(digest).slice(0,12), b => b.toString(16).padStart(2,"0")).join("");
  const request = (method: string, path: string, body: object): PlannedRequest => ({ connection, method, url: root + path, body: JSON.stringify(body) });
  const file = async (ref: string) => {
    const result = await read<{content: string; sha: string}>("/contents/" + siteFile + "?ref=" + encodeURIComponent(ref));
    return { sha: result.sha, text: new TextDecoder().decode(Uint8Array.from(atob(result.content), c => c.charCodeAt(0))) };
  };
  const pinned = context.proposalInputs?.baseSha;
  const baseSha = typeof pinned === "string" ? pinned : (await read<{object:{sha:string}}>("/git/ref/heads/" + base)).object.sha;
  const source = await file(baseSha);
  const site = JSON.parse(source.text);
  if (site.services?.title !== title.current || JSON.stringify(site,null,2) !== source.text.trimEnd()) throw fail("The reviewed Services title or file format changed. Request a fresh review.");
  site.services.title = title.proposed;
  const edited = JSON.stringify(site,null,2) + source.text.slice(source.text.trimEnd().length);
  const content = btoa(Array.from(new TextEncoder().encode(edited), b => String.fromCharCode(b)).join(""));
  const plan = [
    request("POST","/git/refs",{ ref:"refs/heads/" + branch, sha:baseSha }),
    request("PUT","/contents/" + siteFile,{ branch, sha:source.sha, message:"Preview approved Services search title", content }),
    request("POST","/pulls",{ base, head:branch, draft:true, title:"Preview the approved Services search title", body:"Staff approved the Services search title. Review the diff and CI before deciding whether to merge." }),
  ];
  type Pull = {number:number;state:string;draft:boolean;head:{ref:string;sha:string;repo:{full_name:string}};base:{ref:string;repo:{full_name:string}}};
  const lookup = () => read<Pull[]>("/pulls?state=all&base="+encodeURIComponent(base)+"&head="+encodeURIComponent(repo.split("/")[0]+":"+branch));
  async function verifyDiff(ref: string) {
    const diff = await read<{files?:{filename:string}[];behind_by:number}>("/compare/"+baseSha+"..."+ref);
    if (diff.behind_by !== 0 || diff.files?.length !== 1 || diff.files[0].filename !== siteFile || (await file(ref)).text !== edited) throw fail("The preview differs from the approved Services title.");
  }
  async function preview() {
    let pulls = await lookup();
    if (!pulls.length) {
      // Refuse a stale first build. Read-only recovery still uses the immutable approved commit.
      if (typeof pinned === "string" && (await read<{object:{sha:string}}>("/git/ref/heads/" + base)).object.sha !== pinned) throw fail("The target branch advanced. Request a fresh review.");
      for (const item of plan) {
        if (item === plan[2]) await verifyDiff(branch);
        dispatched = true;
        const response = await github.fetch(item.url,{method:item.method,headers:{"content-type":"application/json"},body:item.body});
        if (!response.ok && ![409,422].includes(response.status)) throw new ToolError("GitHub returned HTTP " + response.status + " for the preview.", response.status < 500 && item === plan[0]);
        if (item === plan[0] && !response.ok) {
          const existing = await file(branch);
          if (existing.text !== edited) {
            const comparison = await read<{status:string}>("/compare/"+baseSha+"..."+branch);
            if (existing.text !== source.text || comparison.status !== "identical") throw fail("The preview branch changed. Review it before retrying.");
          }
        }
      }
      pulls = await lookup();
    }
    if (!pulls.length) throw new ToolError("GitHub has not confirmed the draft PR yet.", false);
    return verifiedResult(pulls);
  }
  async function verifiedResult(pulls: Pull[]) {
    const pr = pulls[0];
    if (pulls.length !== 1 || !Number.isSafeInteger(pr.number) || pr.number < 1 || pr.draft !== true || pr.state !== "open" || pr.base.ref !== base || pr.head.ref !== branch ||
        pr.base.repo.full_name !== repo || pr.head.repo.full_name !== repo) throw fail("The matching PR is no longer an open draft. Check its history.");
    await verifyDiff(pr.head.sha);
    return { number:pr.number, url:"https://github.com/"+repo+"/pull/"+pr.number, draft:true, pageUrl:title.url, current:title.current, proposed:title.proposed };
  }
  async function recover() {
    const pulls = await lookup();
    if (!pulls.length) return { status: "unknown" as const, reason: "No reviewable draft PR was found. Check the preview branch before retrying." };
    return { status: "succeeded" as const, result: { data: await verifiedResult(pulls) } };
  }
  return { title, baseSha, plan, preview, recover };
}

export const servicesPreview: ToolDefinition = {
  name:"propose_services_title_preview", label:"Reviewing a Services title preview",
  description:"For an enrolled website manager who requests a Services title preview PR. Inspect /services/ first. Staff approval creates a draft PR for review.",
  needsUser:true, notOnCalls:true, effect:"write", permission:"website.preview", parallelSafe:false, timeoutMs:60000,
  parameters:{ type:"object",additionalProperties:false,required:["pageActionId","proposed"],properties:{pageActionId:{type:"string"},proposed:{type:"string",maxLength:150}}},
  async approval(context,args) {
    const { title: preview, baseSha } = await prepare(context,args);
    return {inputs:{baseSha},title:"Open a draft PR for the Services title",summary:"Approve to open a draft pull request. Publishing requires a separate merge.",preview};
  },
  recoverUncertain: true,
  async reconcile(context, args) { return (await prepare(context, args)).recover(); },
  async writePlan(context,args) { return (await prepare(context,args)).plan; },
  async execute(context,args) { return {data:await (await prepare(context,args)).preview()}; },
};

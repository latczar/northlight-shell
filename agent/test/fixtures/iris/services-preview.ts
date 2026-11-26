import { expect } from "vitest";
import type { ToolContext } from "../../../src/contracts";

export function fixture(loseCreateReply = false) {
  const repo = "latczar/northlight-shell";
  const oldTitle = "Services | Kestrel Garage";
  const original = JSON.stringify({ services: { title: oldTitle, photo: "shop.jpg" }, home: { title: "Milbrook Auto Shop" } }, null, 2);
  let base = "base";
  let offline = false;
  let content = original;
  let branch = "";
  let opened = false;
  const writes: string[] = [];
  const context = {
    userId: "pilot", clientId: "kestrel", conversationId: "staff-test", actionId: "approval-1",
    mayManageAgent: async () => true,
    settings: { site: "https://kestrel.test", servicesPreviewStaff: ["pilot"], repository: repo, baseBranch: "staging", previewConnection: "preview" },
    actionResult: () => ({ data: { url: "https://kestrel.test/services/", h1: ["Services"], title: oldTitle } }),
    connection: () => ({ fetch: async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const path = u.pathname.split(repo + "/")[1];
      if (!init.method || init.method === "GET") {
        if (offline) throw new Error("connection lost");
        if (path === "git/ref/heads/staging") return Response.json({ object: { sha: base } });
        if (path.startsWith("compare/")) return Response.json({ files: [{ filename: "site.json" }], behind_by: path.startsWith("compare/advanced...") ? 1 : 0 });
        if (path === "contents/site.json") return Response.json({ content: btoa(Array.from(new TextEncoder().encode(u.searchParams.get("ref") === "base" ? original : content), byte => String.fromCharCode(byte)).join("")), sha: "blob" });
        if (path === "pulls") return Response.json(opened ? [{ number: 123, state: "open", draft: true, head: { ref: branch, sha: "new", repo: {full_name:repo} }, base: {ref:"staging", repo:{full_name:repo}} }] : []);
      } else {
        const body = JSON.parse(String(init.body));
        writes.push(path);
        if (path === "git/refs") branch = body.ref.slice("refs/heads/".length);
        else if (path === "contents/site.json") content = new TextDecoder().decode(Uint8Array.from(atob(body.content), c => c.charCodeAt(0)));
        else if (path === "pulls") {
          expect(body).toMatchObject({draft:true,head:branch,base:"staging"});
          opened = true;
          if (loseCreateReply) return new Response(null, { status: 502 });
        } else throw Error("Unexpected write " + path);
        return Response.json({});
      }
      throw Error("Unexpected read " + path);
    }}),
  } as unknown as ToolContext;
  return { context, writes, setOffline(value: boolean) { offline = value; }, advanceBase() { base = "advanced"; }, content: () => JSON.parse(content), args: { pageActionId: "inspect", proposed: "Auto Repair Services | Lee's" } };
}

import { describe, expect, it } from "vitest";
import type { ToolContext } from "../src/contracts";
import { servicesPreview } from "../agents/iris/services-preview";
import { fixture } from "./fixtures/iris/services-preview";

describe("Services title approval boundaries", () => {
  it.each([
    ["empty", ""], ["unchanged", "Services | Kestrel Garage"], ["leading whitespace", " Services"],
    ["markup", "<strong>Services</strong>"], ["line break", "Auto\nRepair"],
    ["replacement character", "Auto\uFFFDRepair"], ["over length limit", "a".repeat(151)],
  ])("rejects %s copy before any write", async (_, proposed) => {
    const f = fixture();
    await expect(servicesPreview.execute(f.context, { ...f.args, proposed })).rejects.toThrow("plain-text");
    expect(f.writes).toEqual([]);
  });

  it.each([
    ["homepage", "https://kestrel.test/"], ["another client", "https://other.test/services/"],
    ["unreviewed query variant", "https://kestrel.test/services/?version=old"],
  ])("rejects evidence from %s", async (_, url) => {
    const f = fixture();
    const context = { ...f.context, actionResult: () => ({ data: { url, title: "Services", h1: ["Services"] } }) };
    await expect(servicesPreview.writePlan!(context, f.args)).rejects.toThrow("Inspect the Services page");
    expect(f.writes).toEqual([]);
  });

  it("requires a new review when staging no longer matches the inspected title", async () => {
    const f = fixture();
    const context = { ...f.context, actionResult: () => ({ data: {url:"https://kestrel.test/services/", title:"Old page title", h1:["Services"]} }) };
    await expect(servicesPreview.execute(context, f.args)).rejects.toThrow("fresh review");
    expect(f.writes).toEqual([]);
  });

  it("preserves non-ASCII shop wording at the maximum allowed length", async () => {
    const f = fixture();
    const proposed = "Café & Auto Repair".padEnd(150,"é");
    const result = await servicesPreview.execute(f.context, {...f.args, proposed});
    expect(result.data.proposed).toBe(proposed);
    expect(f.content().services.title).toBe(proposed);
  });
});

type ResponseEdit = (path: string, body: any) => void;
function changedRepository(context: ToolContext, edit: ResponseEdit): ToolContext {
  const upstream = context.connection("preview");
  return { ...context, connection: () => ({ ...upstream, async fetch(url, init) {
    const response = await upstream.fetch(url, init);
    if (init?.method && init.method !== "GET") return response;
    const body = await response.json();
    edit(new URL(url).pathname, body);
    return Response.json(body);
  } }) };
}

describe("read-only draft PR verification", () => {
  const cases: [string, ResponseEdit][] = [
    ["closed PR", (_, p) => { p.state = "closed"; }],
    ["ready-for-review PR", (_, p) => { p.draft = false; }],
    ["renamed head", (_, p) => { p.head.ref = "another-branch"; }],
    ["foreign head repository", (_, p) => { p.head.repo.full_name = "other/shop"; }],
    ["unexpected base branch", (_, p) => { p.base.ref = "main"; }],
    ["foreign base repository", (_, p) => { p.base.repo.full_name = "other/shop"; }],
    ["invalid PR number", (_, p) => { p.number = 0; }],
  ];
  it.each(cases)("refuses to report a %s as the approved preview", async (_, edit) => {
    const f = fixture();
    await servicesPreview.execute(f.context, f.args);
    const writes = [...f.writes];
    const context = changedRepository(f.context, (path, body) => { if (path.endsWith("/pulls")) edit(path, body[0]); });
    await expect(servicesPreview.reconcile!(context, f.args)).rejects.toThrow();
    expect(f.writes).toEqual(writes);
  });

  it.each(["extra file", "diverged branch", "wrong file"])("rejects %s before opening a PR", async problem => {
    const f = fixture();
    const context = changedRepository(f.context, (path, body) => {
      if (!path.includes("/compare/")) return;
      if (problem === "diverged branch") body.behind_by = 1;
      else if (problem === "wrong file") body.files = [{filename:"design.css"}];
      else body.files.push({filename:"design.css"});
    });
    await expect(servicesPreview.execute(context, f.args)).rejects.toThrow("differs from the approved");
    expect(f.writes).not.toContain("pulls");
  });
});

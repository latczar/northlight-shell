import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addPending, discard, emptyState, pagePath, previewCopy, publish, SiteCopy, SITE_COPY_KIND, type SiteCopyState } from "../src/site-copy";
import type { Env } from "../src/conversation";
import { signUserPass } from "../src/user-auth";

const auth = { authorization: "Bearer test-token-kestrel-0123456789abcdef", "content-type": "application/json" };
const APPROVER_KEY = "test-approver-key-kestrel-0123456789abcdef";
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const dashboard = () => env.DASHBOARD.get(env.DASHBOARD.idFromName("kestrel"));
const saved = async () => JSON.parse((await dashboard().snapshot("iris", SITE_COPY_KIND)) ?? "null") as SiteCopyState | null;
const approved = (url: string, field: string, proposed: string, current = "Old") => ({ url, field, proposed, current });

function publishRequest(headers: Record<string, string>, action: unknown = "publish") {
  return SELF.fetch("https://brain/v1/agents/iris/site", { method: "POST", headers: { ...auth, ...headers }, body: JSON.stringify({ action }) });
}

describe("site copy: Live and Preview", () => {
  it("keys pages by path without a trailing slash", () => {
    expect(pagePath("https://site.example/services/")).toBe("/services");
    expect(pagePath("https://site.example/services")).toBe("/services");
    expect(pagePath("https://site.example/")).toBe("/");
    expect(pagePath("https://site.example")).toBe("/");
  });

  it("adds approved wording to Preview only, and Publish makes it Live", () => {
    let state = addPending(undefined, approved("https://site.example/services/", "title", " New title "), 5)!;
    state = addPending(state, approved("https://site.example/", "description", "Home text", "Old home"), 6)!;
    expect(state.live).toEqual({});
    expect(state.pending["/services"].title).toEqual({ text: "New title", replaces: "Old", approvedAt: 5 });
    expect(previewCopy(state)).toEqual({ "/services": { title: "New title" }, "/": { description: "Home text" } });

    const live = publish(state, "lat", 9);
    expect(live).toEqual({ live: { "/services": { title: "New title" }, "/": { description: "Home text" } }, pending: {}, publishedAt: 9, publishedBy: "lat" });
    // a later change waits in Preview on top of what is Live, and Discard drops only that
    const next = addPending(live, approved("https://site.example/services", "title", "Newer title"))!;
    expect(previewCopy(next)["/services"]).toEqual({ title: "Newer title" });
    expect(discard(next)).toEqual(live);
  });

  it("ignores data that is not an approved title or description", () => {
    expect(addPending(undefined, { url: "https://site.example/", field: "heading", proposed: "x" })).toBeUndefined();
    expect(addPending(undefined, { field: "title", proposed: "x" })).toBeUndefined();
  });

  it("publishes only for an admin or an approver of Iris, then serves Live and Preview to the site", async () => {
    await dashboard().saveSnapshot("iris", SITE_COPY_KIND, JSON.stringify(addPending(emptyState(), approved("https://site.example/services/", "title", "Brakes and tyres"))));
    const site = new SiteCopy({} as ExecutionContext, env as unknown as Env);
    expect(await site.pages("kestrel", "live")).toEqual({});
    expect(await site.pages("kestrel", "preview")).toEqual({ "/services": { title: "Brakes and tyres" } });
    expect(await site.pages("no-such-client", "preview")).toEqual({});

    expect((await publishRequest({})).status).toBe(401);
    const someone = await signUserPass(APPROVER_KEY, "kestrel", "not-an-approver", inAnHour(), "approve");
    expect((await publishRequest({ "x-approver-pass": someone })).status).toBe(403);
    const admin = await signUserPass(APPROVER_KEY, "kestrel", "app-admin", inAnHour(), "admin");
    expect((await publishRequest({ "x-admin-pass": admin }, "deploy")).status).toBe(400);
    expect((await saved())?.live).toEqual({});

    await dashboard().setApprovers(Number.MAX_SAFE_INTEGER, { iris: ["approver-1"] }, { iris: ["approver-1"] });
    const approver = await signUserPass(APPROVER_KEY, "kestrel", "approver-1", inAnHour(), "approve");
    const response = await publishRequest({ "x-approver-pass": approver });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ live: { "/services": { title: "Brakes and tyres" } }, pending: {}, publishedBy: "approver-1" });
    expect(await site.pages("kestrel", "live")).toEqual({ "/services": { title: "Brakes and tyres" } });
    expect(await site.pages("kestrel", "preview")).toEqual({ "/services": { title: "Brakes and tyres" } });
  });
});

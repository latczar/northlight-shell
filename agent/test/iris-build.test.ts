import { describe, expect, it, vi } from "vitest";
import { SELF } from "cloudflare:test";
import { buildHomepagePreview } from "../agents/iris/build";
import type { ConnectionHandle } from "../src/contracts";
import { signUserPass } from "../src/user-auth";
import kestrel from "../clients/kestrel/iris.json";

// A root-level site.json in its own repo: the default layout. Kestrel's own monorepo layout is checked at the end.
const config = { settings: { repository: "example-org/example-site", baseBranch: "staging", reviewer: "site-editor" } };

describe("Iris homepage builds", () => {
  it("requires both a signed person and manager rights", async () => {
    const request = (pass: string) => SELF.fetch("https://brain/v1/agents/iris/homepage-preview", { method: "POST",
      headers: { authorization: "Bearer test-token-kestrel-0123456789abcdef", "x-user-pass": pass },
      body: JSON.stringify({ first: "Milbrook", second: "Auto Repair Shop" }) });
    expect((await request("invalid")).status).toBe(401);
    const visitor = await signUserPass("test-signing-key-kestrel-0123456789abcdef", "kestrel", "visitor", Math.floor(Date.now()/1000)+300);
    expect((await request(visitor)).status).toBe(403);
  });

  it("preserves an unfamiliar hero design and asks for review before any write", async () => {
    const site = { home: { hero: { heading_lines: ["Milbrook", "Auto", "Shop"], layout: "stacked" } } };
    const fetch: ConnectionHandle["fetch"] = async (url, init) => {
      expect(init?.method).toBe("GET");
      if (url.endsWith("/git/ref/heads/staging")) return Response.json({ object: { sha: "base" } });
      expect(url).toMatch(/contents\/site\.json\?ref=base$/);
      return Response.json({ content: btoa(JSON.stringify(site, null, 2)) });
    };
    await expect(buildHomepagePreview({ fetch } as ConnectionHandle, "Milbrook", "Auto Shop", config.settings))
      .rejects.toThrow("Review the current design");
  });

  it.each([true, false])("looks up merged PR evidence without writes when the heading matches (linked=%s)", async linked => {
    const lines = ["Milbrook", "Auto Repair Shop"];
    const content = btoa(JSON.stringify({ home: { hero: { heading_lines: lines } } }));
    const calls: string[] = [];
    const fetch: ConnectionHandle["fetch"] = async (url, init) => {
      const endpoint = url.split("example-site/")[1];
      calls.push(endpoint);
      expect(init?.method).toBe("GET");
      if (endpoint === "git/ref/heads/staging") return Response.json({ object: { sha: "merged" } });
      if (endpoint === "contents/site.json?ref=merged") return Response.json({ content });
      if (endpoint === "commits/merged/pulls") return Response.json(linked ? [{ merged_at: "today", merge_commit_sha: "merged",
        base: { ref: "staging" }, head: { ref: "iris-homepage-" + "a".repeat(24) }, html_url: "https://github.com/example-org/example-site/pull/30" }] : []);
      throw Error("Unexpected request: " + endpoint);
    };
    const result = await buildHomepagePreview({ fetch } as ConnectionHandle, lines[0], lines[1], config.settings);
    expect(result).toMatchObject({ status: "already_applied", commit: "merged", sourceUrl: "https://github.com/example-org/example-site/blob/merged/site.json", before: lines });
    if (linked) expect(result).toHaveProperty("mergedPrUrl", "https://github.com/example-org/example-site/pull/30");
    else expect(result).not.toHaveProperty("mergedPrUrl");
    expect(calls).toEqual(["git/ref/heads/staging", "contents/site.json?ref=merged", "commits/merged/pulls"]);
  });

  it("stops on a refused branch write or an existing branch that has diverged", async () => {
    const original = JSON.stringify({ home: { hero: { heading_lines: ["Milbrook", "Auto Shop"] } } }, null, 2);
    for (const status of [403, 422]) {
      const calls: string[] = [];
      const fetch: ConnectionHandle["fetch"] = async (url, init) => {
        const path = new URL(url).pathname.split("example-site/")[1];
        calls.push((init?.method ?? "GET") + " " + path);
        if (path === "git/ref/heads/staging") return Response.json({ object: { sha: "base" } });
        if (path === "contents/site.json" && init?.method === "GET") return Response.json({ sha: "original", content: btoa(original) });
        if (path === "pulls") return Response.json([]);
        if (path === "git/refs") return new Response(null, { status });
        if (path.startsWith("compare/")) return Response.json({ status: "diverged" });
        throw Error("Unexpected request " + path);
      };
      await expect(buildHomepagePreview({ fetch } as ConnectionHandle, "Milbrook", "Auto Repair Shop", config.settings))
        .rejects.toThrow(status === 403 ? "GitHub returned 403" : "existing branch has changed");
      expect(calls.filter(call => !call.startsWith("GET "))).toEqual(["POST git/refs"]);
    }
  });

  it("updates only the two heading lines, reuses a retry and requests the reviewer once", async () => {
    const site = { home: { hero: { heading_lines: ["Milbrook", "Auto Shop"], eyebrow: "Milbrook, North Yorkshire" } } };
    const original = JSON.stringify(site, null, 2) + "\n";
    let content = btoa(original), branch = "", opened = false, requested = false;
    let state = "open";
    const writes: string[] = [];
    const files = [{ filename: "site.json" }];
    const fetch: ConnectionHandle["fetch"] = async (url, init = {}) => {
      const u = new URL(url), method = init.method ?? "GET";
      expect(u.origin + u.pathname).toMatch(/^https:\/\/api\.github\.com\/repos\/example-org\/example-site\//);
      const p = u.pathname.split("example-site/")[1];
      const body = init.body ? JSON.parse(String(init.body)) : {};
      const pr = { number: 30, state, html_url: "https://github.com/example-org/example-site/pull/30", requested_reviewers: requested ? [{ login: "site-editor" }] : [] };
      if (p === "git/ref/heads/staging") return Response.json({ object: { sha: "base" } });
      if (method === "GET" && p === "contents/site.json") {
        const base = u.searchParams.get("ref") === "base";
        return Response.json({ content: base ? btoa(original) : content, sha: base || content === btoa(original) ? "original" : "edited" });
      }
      if (p === "git/refs") {
        if (branch) throw Error("Unexpected second attempt to create the preview branch");
        expect(body.ref).toMatch(/^refs\/heads\/iris-homepage-[a-f0-9]{24}$/);
        branch = body.ref.slice(11);
      } else if (method === "PUT" && p === "contents/site.json") {
        expect(body.branch).toBe(branch);
        content = body.content;
      } else if (p.startsWith("compare/")) return Response.json({ files, behind_by: 0 });
      else if (p === "pulls" && method === "GET") return Response.json(opened ? [pr] : []);
      else if (p === "pulls" && method === "POST") {
        expect(body).toMatchObject({ base: "staging", head: branch });
        opened = true; writes.push("PR"); return Response.json(pr);
      } else if (p === "pulls/30/reviews") return Response.json([]);
      else if (p === "pulls/30/requested_reviewers") {
        expect(body.reviewers).toEqual(["site-editor"]); requested = true;
      } else throw Error("Unexpected request " + method + " " + p);
      writes.push(p);
      return Response.json({});
    };
    const handle = { fetch } as ConnectionHandle;
    for (let i=0; i<2; i++) expect((await buildHomepagePreview(handle, "Milbrook", "Auto Repair Shop", config.settings)).branch).toBe(branch);
    files.push({ filename: "src/styles.css" });
    const handoff = await buildHomepagePreview(handle, "Milbrook", "Auto Repair Shop", config.settings);
    expect(handoff.url).toContain("/pull/30");
    expect(handoff.note).toContain("Review the full diff");
    expect(writes).toEqual(["git/refs", "contents/site.json", "PR", "pulls/30/requested_reviewers"]);
    expect(JSON.parse(atob(content))).toEqual({ home: { hero: { ...site.home.hero, heading_lines: ["Milbrook", "Auto Repair Shop"] } } });
    content = btoa(original); // A reviewer reverted the heading on the open branch.
    await expect(buildHomepagePreview(handle, "Milbrook", "Auto Repair Shop", config.settings)).rejects.toThrow("different content");
    state = "closed";
    branch = ""; // GitHub can delete the head branch when the PR is closed.
    await expect(buildHomepagePreview(handle, "Milbrook", "Auto Repair Shop", config.settings)).rejects.toThrow("was closed");
    expect(writes).toEqual(["git/refs", "contents/site.json", "PR", "pulls/30/requested_reviewers"]);
    const blocked = vi.fn();
    await expect(buildHomepagePreview({ fetch: blocked } as unknown as ConnectionHandle, "<script>", "shop", config.settings)).rejects.toThrow("plain-text");
    expect(blocked).not.toHaveBeenCalled();
  });
  it("reads the site file at Kestrel's monorepo path and refuses a path outside the repo", async () => {
    const paths: string[] = [];
    const site = { home: { hero: { heading_lines: ["Milbrook", "Car Servicing"] } } };
    const fetch: ConnectionHandle["fetch"] = async url => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "base" } });
      if (path.endsWith("/contents/site/site.json")) return Response.json({ content: btoa(JSON.stringify(site, null, 2)) });
      if (path.endsWith("/commits/base/pulls")) return Response.json([]);
      throw Error("Unexpected request " + path);
    };
    const result = await buildHomepagePreview({ fetch } as ConnectionHandle, "Milbrook", "Car Servicing", kestrel.settings);
    expect(result).toMatchObject({ status: "already_applied", sourceUrl: "https://github.com/latczar/northlight-shell/blob/base/site/site.json" });
    const repo = "/repos/latczar/northlight-shell";
    expect(paths).toEqual([repo + "/git/ref/heads/main", repo + "/contents/site/site.json", repo + "/commits/base/pulls"]);
    for (const siteFile of ["../site.json", "site/../site.json", "site.txt", "/site.json"]) {
      await expect(buildHomepagePreview({ fetch } as ConnectionHandle, "Milbrook", "Car Servicing", { ...kestrel.settings, siteFile }))
        .rejects.toThrow("Configure a repository");
    }
  });
});

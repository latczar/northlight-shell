import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { setup } from "../agents/iris";
import { deployedPull } from "../agents/iris/deployed-pull";
import type { ToolContext } from "../src/contracts";

import { CLIENTS } from "../clients";
const client = CLIENTS.find(c => c.id === "kestrel")!;
const settings = client.agentSettings!["iris"];
const sha = "a".repeat(40);
const repo = "latczar/northlight-shell";
const base = { ref: String(settings.baseBranch), repo: { full_name: repo } };
const pull = { number: 30, merged_at: "2026-11-19T17:26:46Z", merge_commit_sha: sha, base };

describe("Iris deployed PR lookup", () => {
  it("reports release access only when the Kestrel release credential is present", () => {
    const releaseStatus = (secret: string) => setup({
      clientId: "kestrel", settings, connections: client.connections, has: name => name === secret,
    }).find(item => item.id === "release_lookup");
    expect(releaseStatus("GITHUB_TOKEN")).toMatchObject({ connected: false, missing: ["KESTREL_RELEASE_GITHUB_TOKEN"] });
    expect(releaseStatus("KESTREL_RELEASE_GITHUB_TOKEN")).toMatchObject({ connected: true, missing: [] });
  });

  it("reports only a merged base-branch PR for the exact deployed commit", async () => {
    const github = vi.fn();
    const marker = vi.fn(async () => Response.json({ commit: sha }));
    const ctx = { settings, connection: (id: string) =>
      ({ fetch: id === "managed_website" ? marker : github }) } as unknown as ToolContext;
    const unrelated = [null, { ...pull, number: undefined }, { ...pull, base: null }, { ...pull, merged_at: null }, { ...pull, merge_commit_sha: "b".repeat(40) },
      { ...pull, base: { ...base, ref: "other-branch" } }, { ...pull, base: { ...base, repo: { full_name: "Other/website" } } }];
    github.mockResolvedValueOnce(Response.json([...unrelated, pull])).mockResolvedValueOnce(Response.json(unrelated));
    expect((await deployedPull.execute(ctx, {})).data.mergedPrUrl).toBe("https://github.com/" + repo + "/pull/30");
    expect((await deployedPull.execute(ctx, {})).data.mergedPrUrl).toBeNull();
    expect(github).toHaveBeenCalledWith("https://api.github.com/repos/" + repo + "/commits/" + sha + "/pulls");
    marker.mockResolvedValueOnce(Response.json({ commit: "../main" }));
    await expect(deployedPull.execute(ctx, {})).rejects.toThrow("valid commit");
    expect(github).toHaveBeenCalledTimes(2);
  });

  it("handles an unreadable deployment marker or GitHub response without claiming a PR", async () => {
    const lookup = vi.fn();
    const ctx = { settings, connection: () =>
      ({ fetch: lookup }) } as unknown as ToolContext;
    lookup.mockResolvedValueOnce(new Response("<html>"));
    await expect(deployedPull.execute(ctx, {})).rejects.toThrow("valid commit");
    expect(lookup).toHaveBeenCalledTimes(1);
    lookup.mockResolvedValueOnce(Response.json({ commit: sha })).mockResolvedValueOnce(Response.json({}));
    await expect(deployedPull.execute(ctx, {})).rejects.toThrow("unreadable pull request list");
  });

  it("enforces the repo, endpoint, agent and method in the actual desk", async () => {
    const url = "https://api.github.com/repos/" + repo + "/commits/" + sha + "/pulls";
    const request = { clientId: "kestrel", agentId: "iris", toolName: "find_deployed_pull", actionId: "test-release",
      connection: "kestrel_release_github", url, method: "GET", headers: {} };
    expect((await env.DESK.send(request)).status).toBe("response");
    for (const change of [{ method: "POST" }, { agentId: "helper" }, { url: url.replace(repo, "other-org/other-repo") },
      { url: url.replace(sha, "main") }, { url: url.replace("/commits/" + sha, "") }]) {
      expect((await env.DESK.send({ ...request, ...change })).status).toBe("refused");
    }
  });
});

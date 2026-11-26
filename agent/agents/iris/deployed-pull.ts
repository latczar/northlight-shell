import type { ToolDefinition } from "../../src/contracts";
import { ToolError } from "../../src/errors";

import { repositorySettings } from "./build";
interface Pull {
  number: number;
  merged_at: string | null;
  merge_commit_sha: string;
  base: { ref: string; repo: { full_name: string } };
}

export const deployedPull: ToolDefinition = {
  name: "find_deployed_pull", label: "Checking the live deployment against GitHub",
  description: "Find the merged PR for the website's currently deployed commit. Use this for release verification alongside review_site_page.",
  permission: "website.release.read", effect: "read", parallelSafe: true, timeoutMs: 20000,
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute(context) {
    const { repo, base } = repositorySettings(context.settings);
    const marker = await context.connection("managed_website").fetch(new URL("/foundry-source.json", String(context.settings.site)).href);
    if (!marker.ok) throw new ToolError("The published deployment marker is unavailable.", true);
    const release = await marker.json<{ commit?: string } | null>().catch(() => null);
    const commit = release?.commit;
    if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) throw new ToolError("The published deployment marker contains no valid commit.", true);
    const response = await context.connection(String(context.settings.releaseConnection)).fetch("https://api.github.com/repos/" + repo + "/commits/" + commit + "/pulls");
    if (!response.ok) throw new ToolError("GitHub could not verify the deployed commit (HTTP " + response.status + ").", true);
    const pulls = await response.json<(Pull | null)[]>().catch(() => null);
    if (!Array.isArray(pulls)) throw new ToolError("GitHub returned an unreadable pull request list.", true);
    const match = pulls.find(pr => pr?.merged_at && Number.isSafeInteger(pr.number) && pr.number > 0 &&
      pr.merge_commit_sha === commit && pr.base?.ref === base && pr.base.repo?.full_name === repo);
    return { data: { commit, mergedPrUrl: match ? "https://github.com/" + repo + "/pull/" + match.number : null } };
  },
};

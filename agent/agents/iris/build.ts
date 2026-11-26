import type { ConnectionHandle, JsonObject, ToolDefinition } from "../../src/contracts";
import { ToolError } from "../../src/errors";

export function repositorySettings(settings: JsonObject) {
  const { repository: repo, baseBranch: base } = settings;
  // The site file's path in the repo: `site.json` at the root by default, or e.g. `site/site.json` in a monorepo.
  const file = settings.siteFile ?? "site.json";
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
      typeof base !== "string" || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(base) ||
      typeof file !== "string" || !/^(?:[\w.-]+\/)*[\w.-]+\.json$/.test(file) ||
      [repo, base, file].some(value => value.split("/").some(segment => segment === "." || segment === ".."))) {
    throw new ToolError("Configure a repository and base branch for this website.", true);
  }
  return { repo, base, file };
}
interface SiteFile { sha: string; content: string }
interface PreviewPR { number: number; state: string; html_url: string; requested_reviewers: { login: string }[] }
const fail = (message: string) => new ToolError(message, true);

export async function buildHomepagePreview(github: ConnectionHandle, first: unknown, second: unknown, settings: JsonObject) {
  const { repo, base, file } = repositorySettings(settings);
  const reviewer = settings.reviewer;
  if (typeof reviewer !== "string" || !/^[\w-]+$/.test(reviewer)) throw fail("Configure a GitHub reviewer for this website.");
  const root = "https://api.github.com/repos/" + repo;
  const lines = [first, second];
  if (!lines.every((s): s is string => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9 '\u2018\u2019&,.!?-]{0,47}$/.test(s) && s.trim() === s))
    throw fail("Provide two short, plain-text heading lines.");
  async function api(path: string, method = "GET", body?: object, allowed: number[] = []) {
    const response = await github.fetch(root + path, { method, headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined });
    if (allowed.includes(response.status)) return response;
    if (!response.ok) throw fail("GitHub returned " + response.status + " for " + method + " " + path + ". Check the preview before retrying.");
    return response;
  }
  const ref = await (await api("/git/ref/heads/" + base)).json<{ object: { sha: string } }>();
  const sha = ref.object.sha;
  const read = async (rev: string) => (await api("/contents/" + file + "?ref=" + rev)).json<SiteFile>();
  const source = await read(sha);
  const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
  const raw = decode(source.content);
  const site = JSON.parse(raw);
  const before = site?.home?.hero?.heading_lines;
  if (!Array.isArray(before) || before.length !== 2 || !before.every(line => typeof line === "string" && line.trim())) {
    throw fail("The homepage no longer has the expected two heading lines. Review the current design before building.");
  }
  if (JSON.stringify(before) === JSON.stringify(lines)) {
    const linked = await api("/commits/" + sha + "/pulls");
    const pulls = await linked.json<{ merged_at: string | null; merge_commit_sha: string; base: { ref: string }; head: { ref: string }; html_url: string }[]>();
    const merged = pulls.find(pr => pr.merged_at && pr.merge_commit_sha === sha && pr.base.ref === base && /^iris-homepage-[0-9a-f]{24}$/.test(pr.head.ref));
    return { status: "already_applied", before, commit: sha, ...(merged ? { mergedPrUrl: merged.html_url } : {}),
      sourceUrl: "https://github.com/" + repo + "/blob/" + sha + "/" + file,
      note: "Both heading lines are already in " + base + ". Report a merged PR only when mergedPrUrl is present. The sourceUrl is the committed file." };
  }
  site.home.hero.heading_lines = lines;
  const edited = JSON.stringify(site, null, 2) + (raw.endsWith("\n") ? "\n" : "");
  site.home.hero.heading_lines = before;
  if (JSON.stringify(site, null, 2) !== raw.trimEnd()) throw fail("The site file uses a new format. Review the change manually.");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sha + edited));
  const branch = "iris-homepage-" + Array.from(new Uint8Array(hash).slice(0, 12), b => b.toString(16).padStart(2, "0")).join("");
  const head = repo.split("/")[0] + ":" + branch;
  const find = async () => (await (await api("/pulls?state=all&base=" + encodeURIComponent(base) + "&head=" + encodeURIComponent(head))).json<PreviewPR[]>())[0];
  let pr = await find();
  if (pr && pr.state !== "open") throw fail("This preview was closed. Review its history: " + pr.html_url);
  const creation = pr ? undefined : await api("/git/refs", "POST", { ref: "refs/heads/" + branch, sha }, [422]);
  const current = await read(branch);
  let needsEdit = !pr && current.sha === source.sha;
  if (needsEdit && !creation?.ok) {
    const comparison = await (await api("/compare/" + sha + "..." + branch)).json<{ status: string }>();
    if (comparison.status !== "identical") {
      // A concurrent request may have just written the expected file.
      if (decode((await read(branch)).content) !== edited) throw fail("The existing branch has changed. Review it before editing.");
      needsEdit = false;
    }
  }
  if (needsEdit) {
    const content = btoa(Array.from(new TextEncoder().encode(edited), b => String.fromCharCode(b)).join(""));
    await api("/contents/" + file, "PUT", { branch, sha: current.sha, message: "Update the homepage heading for local search", content }, [409,422]);
  }
  if (decode((await read(branch)).content) !== edited) throw fail("The preview branch has different content.");
  const changes = await (await api("/compare/" + sha + "..." + branch)).json<{ files?: { filename: string }[]; behind_by: number }>();
  if (changes.files?.length !== 1 || changes.files[0].filename !== file || changes.behind_by !== 0) {
    if (pr?.state === "open") {
      return { url: pr.html_url, branch, before, proposed: lines,
        note: "An open preview already contains this heading and other changes or has diverged. Review the full diff. No edits were made to those changes." };
    }
    throw fail("The branch includes unexpected changes.");
  }
  if (!pr) {
    const created = await api("/pulls", "POST", { base, head: branch, title: "Preview the homepage heading for local SEO",
    body: "Iris proposes changing “" + before.join(" ") + "” to “" + lines.join(" ") + "”. Only the hero heading in " + file + " changes. Please review the wording and both screen sizes before merging into " + base + "." }, [422]);
    pr = created.ok ? await created.json<PreviewPR>() : await find();
  }
  if (!pr || pr.state !== "open") throw fail("This preview was closed or could not be opened. Review its history.");
  if (!pr.requested_reviewers.some(r => r.login === reviewer)) {
    const reviews = await (await api("/pulls/" + pr.number + "/reviews")).json<{ user: { login: string } }[]>();
    if (!reviews.some(r => r.user.login === reviewer)) {
      const sent = await api("/pulls/" + pr.number + "/requested_reviewers", "POST", { reviewers: [reviewer] }, [422]);
      if (!sent.ok && !(await find())?.requested_reviewers.some(r => r.login === reviewer)) {
        throw fail("GitHub could not request the configured reviewer. Check the preview before retrying.");
      }
    }
  }
  return { url: pr.html_url, branch, before, proposed: lines, reviewer, ci: "Check the pull request for its build and test results." };
}

export const buildPreview: ToolDefinition = {
  name: "build_homepage_preview", label: "Opening the homepage preview for review",
  description: "Build a two-line homepage heading change in the configured website repo when a signed-in manager requests a preview.",
  permission: "website.preview", effect: "write", needsUser: true, notOnCalls: true, parallelSafe: false, timeoutMs: 60000,
  parameters: { type: "object", properties: { first: { type: "string" }, second: { type: "string" } }, required: ["first", "second"], additionalProperties: false },
  async execute(context, args) {
    if (!context.userId || !await context.mayManageAgent?.())
      throw fail("A signed-in website manager is required.");
    if (context.settings.confirmHeadingInChat === true) {
      const confirmation = "Preview heading: " + args.first + " | " + args.second;
      if (context.request?.text.trim() !== confirmation) {
        throw fail("Ask the manager what should change. To build a heading preview, have them send the exact two approved lines as: Preview heading: First line | Second line");
      }
    }
    return { data: await buildHomepagePreview(context.connection(String(context.settings.previewConnection)), args.first, args.second, context.settings) };
  },
};

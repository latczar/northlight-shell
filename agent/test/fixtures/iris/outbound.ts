const repository = "cycle-co/northwind";
const root = "/repos/" + repository + "/";
const commit = "a".repeat(40);
const baseContent = btoa(JSON.stringify({ home: { hero: { heading_lines: ["York", "Cycle Workshop"] } } }, null, 2));
const branches = new Map<string, { content: string; number?: number; reviewer?: string }>();

export function northwindResponse(request: Request): Promise<Response> | undefined {
  const url = new URL(request.url);
  if (url.hostname === "northwind.example") {
    const routes: Record<string, Response> = {
      "/foundry-source.json": Response.json({ commit }),
      "/": new Response("<title>Northwind Cycles</title><h1>York Cycle Workshop</h1><meta name='description' content='Bicycle repairs'>", { headers: { "content-type": "text/html" } }),
    };
    return Promise.resolve(routes[url.pathname] ?? new Response(null, { status: 404 }));
  }
  if (url.hostname === "api.github.com" && url.pathname.startsWith(root)) return github(request, url);
}

async function github(request: Request, url: URL) {
  const path = url.pathname.slice(root.length);
  const auth = request.headers.get("authorization");
  if (path === "commits/" + commit + "/pulls" && request.method === "GET" &&
      ["Bearer northwind-read-fixture", "Bearer northwind-write-fixture"].includes(auth ?? "")) {
    return Response.json([{ number: 7, merged_at: "2026-01-01", merge_commit_sha: commit,
      base: { ref: "preview", repo: { full_name: repository } }, head: { ref: "iris-homepage-" + "b".repeat(24) },
      html_url: "https://github.com/" + repository + "/pull/7" }]);
  }
  if (auth !== "Bearer northwind-write-fixture") return new Response(null, { status: 403 });
  type Branch = { content: string; number?: number; reviewer?: string };
  const pull = (branch: Branch) => ({ state: "open", number: branch.number,
    html_url: "https://github.com/" + repository + "/pull/" + branch.number,
    requested_reviewers: branch.reviewer ? [{ login: branch.reviewer }] : [] });
  if (request.method === "GET") {
    if (path === "git/ref/heads/preview") return Response.json({ object: { sha: commit } });
    if (path === "contents/site.json") {
      const ref = url.searchParams.get("ref");
      const content = ref === commit ? baseContent : branches.get(ref ?? "")?.content;
      if (content) return Response.json({ content, sha: content === baseContent ? "base" : "edited" });
    }
    if (path === "pulls" && url.searchParams.get("base") === "preview") {
      const head = url.searchParams.get("head") ?? "";
      const branch = head.startsWith("cycle-co:") && branches.get(head.slice("cycle-co:".length));
      return Response.json(branch && branch.number ? [pull(branch)] : []);
    }
    if (path.startsWith("compare/" + commit + "...")) {
      const changed = branches.get(path.split("...")[1])?.content !== baseContent;
      return Response.json({ status: changed ? "ahead" : "identical", files: changed ? [{ filename: "site.json" }] : [], behind_by: 0 });
    }
    if (/^pulls\/\d+\/reviews$/.test(path)) return Response.json([]);
  } else {
    const body = await request.json() as Record<string, any>;
    if (path === "git/refs" && body.sha === commit && request.method === "POST") {
      const name = String(body.ref).replace(/^refs\/heads\//, "");
      if (branches.has(name)) return new Response(null, { status: 422 });
      branches.set(name, { content: baseContent });
      return Response.json({});
    }
    const branch = branches.get(body.branch ?? body.head);
    if (path === "contents/site.json" && request.method === "PUT" && branch && body.sha === "base") {
      if (branch.content !== baseContent) return new Response(null, { status: 409 });
      branch.content = body.content;
      return Response.json({});
    }
    if (path === "pulls" && request.method === "POST" && body.base === "preview" && branch) {
      if (branch.number) return new Response(null, { status: 422 });
      branch.number = 8 + [...branches.values()].filter(b => b.number).length;
      return Response.json(pull(branch));
    }
    const found = [...branches.values()].find(b => b.number && path === "pulls/" + b.number + "/requested_reviewers");
    if (found && request.method === "POST" && JSON.stringify(body.reviewers) === '["cycle-editor"]') {
      if (found.reviewer) return new Response(null, { status: 422 });
      found.reviewer = "cycle-editor";
      return Response.json({});
    }
  }
  return new Response(null, { status: 404 });
}

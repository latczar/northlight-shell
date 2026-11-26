// The fake brain's sample world: Kestrel Garage and Harbour Cycles. Everything here is labelled "Sample" and uses .example domains.
// Shapes follow the agent (agent/agents/iris/*, src/dashboard.ts, src/learning.ts); only the words are invented.

const min = 60_000, hour = 60 * min, day = 24 * hour;

export const AGENTS = { "iris": { name: "Iris", role: "Website manager and SEO agent" } };

/** Ready when every item that is not optional is connected (agent/src/setup.ts). */
export const isReady = items => items.every(item => item.connected || item.optional);

const SITE = "https://kestrel-garage.example/";
const setupItems = (site, releaseMissing, previewMissing) => [
  { id: "website", label: "Website to review", kind: "setting", connected: Boolean(site), missing: site ? [] : ["site"], unlocks: site || "Set the website before reviewing pages." },
  { id: "release_lookup", label: "GitHub release lookup", kind: "secret", optional: true, connected: !releaseMissing.length, missing: releaseMissing, unlocks: "Verify the PR for the live website commit." },
  { id: "preview_repo", label: "Homepage preview pull requests", kind: "secret", optional: true, connected: !previewMissing.length, missing: previewMissing, unlocks: "Build homepage heading changes for a signed-in website manager." },
];

// People ids are passed in so conversation ids and requesters match the fake Supabase users.
export function buildWorld(now, { admin, manager }) {
  const seoApproval = (id, { requestedBy, source, conversationId, field, current, proposed, reason, status, createdAt, decidedBy, decidedAt }) => ({
    id, agent: "iris", conversationId, tool: "submit_seo_copy", title: `Review page ${field}`,
    summary: `${reason} Approval records this copy for implementation.`, requestedBy, source,
    preview: { url: SITE, field, current, proposed, reason }, status, createdAt,
    ...(status === "pending" ? {} : { decidedBy, reason: "", decidedAt, result: { url: SITE, field, current, proposed, reason, status: "approved_for_implementation" } }),
  });
  const approvals = [
    seoApproval("appr-kestrel-1", { requestedBy: manager, source: "app", conversationId: `web-${manager}`, field: "description",
      current: "Sample current description: Auto repair you can trust.",
      proposed: "Sample proposed description: Brake, suspension and tyre repair in Milbrook. Book a visit today.",
      reason: "Sample: names the town and the main services.", status: "pending", createdAt: now - 20 * min }),
    seoApproval("appr-kestrel-2", { requestedBy: null, source: "scheduled", conversationId: "scheduled-iris-weekly", field: "title",
      current: "Sample current title: Kestrel Garage", proposed: "Sample proposed title: Kestrel Garage | Milbrook",
      reason: "Sample: adds the town to the title.", status: "pending", createdAt: now - 3 * hour }),
    seoApproval("appr-kestrel-0", { requestedBy: manager, source: "app", conversationId: `web-${manager}`, field: "title",
      current: "Sample current title: Kestrel Garage", proposed: "Sample proposed title: Kestrel Garage",
      reason: "Sample: uses the full business name.", status: "done", createdAt: now - 2 * day - hour, decidedBy: manager, decidedAt: now - 2 * day }),
  ];
  const approvalCard = a => ({ id: `approval-${a.id}`, agent: a.agent, kind: "needs_approval", title: a.title, summary: a.summary, data: a.preview,
    conversationId: a.conversationId, requestedBy: a.requestedBy, source: a.source, createdAt: a.createdAt, updatedAt: a.createdAt });
  const card = (id, kind, title, summary, at, conversationId) => ({ id, agent: "iris", kind, title, summary, data: {}, conversationId, createdAt: at, updatedAt: at });
  const done = approvals[2];
  const cards = [
    approvalCard(approvals[0]), approvalCard(approvals[1]),
    { ...approvalCard(done), kind: "status", title: `Done: ${done.title}`, createdAt: now - 2 * day - hour, updatedAt: now - 2 * day },
    card("card-kestrel-report", "report", "Sample: Weekly homepage review", "Sample: title, description and headings read from the live homepage. One change proposed.", now - 3 * hour, "scheduled-iris-weekly"),
    card("card-kestrel-alert", "alert", "Sample: Page check failed", "Sample: the homepage did not answer at 6:00. Iris will try again next week.", now - 4 * day, "scheduled-iris-weekly"),
  ];
  const lessons = [
    { id: "lesson-1", agent: "iris", kind: "preference", text: "Use UK spelling: tyre, not tire.", evidence: "Sample: we're in Milbrook, write tyre.", conversationId: `web-${manager}`, status: "proposed", createdAt: now - 5 * hour },
    { id: "lesson-2", agent: null, kind: "fact", text: "Kestrel Garage is in Milbrook.", evidence: "Sample: the garage is on Mill Lane.", conversationId: `web-${manager}`, status: "active", createdAt: now - 6 * day, decidedAt: now - 5 * day, decidedBy: admin },
  ];
  const snapshots = {
    homepage_seo: { at: now - 3 * hour, data: { url: SITE, businessName: "Kestrel Garage", location: "Milbrook", copyLocale: "en-GB",
      title: "Sample title: Kestrel Garage", description: "Sample current description: Auto repair you can trust.", canonical: SITE,
      h1: ["Sample heading: Milbrook Car Repairs and Servicing"], h1Count: 1 } },
    approved_seo_copy: { at: now - 2 * day, data: { ...done.result } },
  };
  const history = [
    ["user", "Sample: Can you check the homepage description?"],
    ["assistant", "Sample: I read the live homepage. The **description** is short and does not name the town."],
    ["user", "Sample: What would you change?"],
    ["assistant", "Sample: Here is what I suggest:\n\n- Name Milbrook\n- Mention brakes, suspension and tyres\n\nThe page is at [kestrel-garage.example](https://kestrel-garage.example/)."],
    ["user", "Sample: Please send it for review."],
    ["assistant", "Sample: Done. I sent the new description to **review**. Nothing changes on the site until it is approved."],
  ].map(([role, text], i) => ({ seq: i + 1, role, text }));

  return {
    kestrel: { approvals, cards, lessons, snapshots, setup: setupItems(SITE, [], ["KESTREL_PREVIEW_GITHUB_TOKEN"]), history: { [`web-${manager}`]: history } },
    harbour: {
      approvals: [], lessons: [], snapshots: {}, history: {},
      cards: [card("card-harbour-report", "report", "Sample: First homepage review", "Sample: Iris needs the website address before reviewing pages.", now - day, "scheduled-iris-weekly")],
      setup: setupItems("", ["HARBOUR_RELEASE_GITHUB_TOKEN"], ["HARBOUR_PREVIEW_GITHUB_TOKEN"]),
    },
  };
}

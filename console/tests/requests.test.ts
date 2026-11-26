import { describe, expect, it } from "vitest";
import { accessFromRows } from "@/lib/access";
import type { Approval, Card } from "@/lib/brain-types";
import { askedBy, canAskForRevision, canSeeCard, canSeeLessonSource, canSeeRequest, copyDraft, decisionRight, type Who } from "@/lib/requests";

const ALEX = "00000000-0000-4000-8000-000000000002";
const JAMIE = "00000000-0000-4000-8000-000000000003";

const grant = (canApprove: boolean) => accessFromRows([{ client_id: "kestrel", agent_id: "iris", can_approve: canApprove, can_manage: false, revoked_at: null }]);
const alex: Who = { userId: ALEX, admin: false, access: grant(true) };
const jamie: Who = { userId: JAMIE, admin: false, access: grant(false) };
const admin: Who = { userId: "00000000-0000-4000-8000-000000000001", admin: true, access: { grants: [] } };

const request = (over: Partial<Approval>): Approval => ({
  id: "act-1",
  agent: "iris",
  conversationId: `web-${ALEX}`,
  requestedBy: ALEX,
  source: "app",
  tool: "submit_seo_copy",
  title: "Review page description",
  summary: "",
  preview: { field: "description", url: "https://kestrel-garage.example/", current: "Old", proposed: "New" },
  status: "pending",
  createdAt: 0,
  ...over,
});

describe("who sees a request", () => {
  it("is the person who asked and Northlight admins, never another approver", () => {
    expect(canSeeRequest(request({}), alex)).toBe(true);
    expect(canSeeRequest(request({}), admin)).toBe(true);
    expect(canSeeRequest(request({ requestedBy: JAMIE }), alex)).toBe(false);
  });

  it("keeps requests nobody asked for in the app (scheduled, phone) to admins", () => {
    expect(canSeeRequest(request({ requestedBy: null, source: "scheduled" }), alex)).toBe(false);
    expect(canSeeRequest(request({ requestedBy: null, source: "scheduled" }), admin)).toBe(true);
  });

  const card = (over: Partial<Card>): Card => ({ id: "approval-act-1", agent: "iris", kind: "status", title: "Done: Review", summary: "", data: {}, conversationId: "", requestedBy: JAMIE, createdAt: 0, updatedAt: 0, ...over });

  it("keeps a request's card as private as the request, after the decision too", () => {
    expect(canSeeCard(card({}), alex, "kestrel")).toBe(false);
    expect(canSeeCard(card({ requestedBy: ALEX }), alex, "kestrel")).toBe(true);
    expect(canSeeCard(card({ id: "report-1", kind: "report", requestedBy: undefined }), jamie, "kestrel")).toBe(true);
  });

  it("keeps a lesson learned from someone's chat to them, the employee's approvers and admins", () => {
    const fromDana = card({ id: "lesson-card-l1", requestedBy: undefined, conversationId: `web-${ALEX}` });
    expect(canSeeCard(fromDana, jamie, "kestrel")).toBe(false);
    expect(canSeeCard(fromDana, alex, "kestrel")).toBe(true);
    expect(canSeeCard(fromDana, admin, "kestrel")).toBe(true);
    expect(canSeeLessonSource(`web-${JAMIE}`, jamie, "kestrel", "iris")).toBe(true);
    expect(canSeeLessonSource(`web-${ALEX}`, jamie, "kestrel", "iris")).toBe(false);
    expect(canSeeLessonSource(`web-${JAMIE}`, alex, "kestrel", "iris")).toBe(true);
  });
});

describe("copyDraft", () => {
  it("links only an http(s) page address the employee gave", () => {
    expect(copyDraft(request({}))?.url).toBe("https://kestrel-garage.example/");
    expect(copyDraft(request({ preview: { field: "title", url: "javascript:alert(1)", proposed: "New" } }))?.url).toBe("");
    expect(copyDraft(request({ preview: { field: "title", url: "data:text/html,hi", proposed: "New" } }))?.url).toBe("");
    expect(copyDraft(request({ tool: "post_seo_report" }))).toBeNull();
  });
});

describe("decisionRight", () => {
  it("lets the requester decide only with the approve right; otherwise an admin decides", () => {
    expect(decisionRight(request({}), "kestrel", alex)).toBe("decide");
    expect(decisionRight(request({ requestedBy: JAMIE }), "kestrel", jamie)).toBe("waiting");
    expect(decisionRight(request({ requestedBy: JAMIE }), "kestrel", admin)).toBe("decide");
  });

  it("offers nothing on someone else's request, a decided one, or another client's rights", () => {
    expect(decisionRight(request({ requestedBy: JAMIE }), "kestrel", alex)).toBe("none");
    expect(decisionRight(request({ status: "approved" }), "kestrel", alex)).toBe("none");
    expect(decisionRight(request({}), "harbour", alex)).toBe("waiting");
  });
});

describe("canAskForRevision", () => {
  const declined = request({ status: "declined", reason: "Mention free estimates." });

  it("allows a new draft only for a declined copy draft with feedback", () => {
    expect(canAskForRevision(declined, "kestrel", alex)).toBe(true);
    expect(canAskForRevision({ ...declined, reason: " " }, "kestrel", alex)).toBe(false);
    expect(canAskForRevision({ ...declined, status: "pending" }, "kestrel", alex)).toBe(false);
    expect(canAskForRevision({ ...declined, tool: "post_seo_report" }, "kestrel", alex)).toBe(false);
  });

  it("is for whoever could decide it: the approving requester or an admin", () => {
    expect(canAskForRevision({ ...declined, requestedBy: JAMIE }, "kestrel", jamie)).toBe(false);
    expect(canAskForRevision({ ...declined, requestedBy: JAMIE }, "kestrel", alex)).toBe(false);
    expect(canAskForRevision({ ...declined, requestedBy: JAMIE }, "kestrel", admin)).toBe(true);
  });
});

describe("askedBy", () => {
  it("names the person, or says where an app-less request came from", () => {
    expect(askedBy(request({}), alex, {})).toBe("Asked by you");
    expect(askedBy(request({}), admin, { [ALEX]: "Alex Morgan" })).toBe("Asked by Alex Morgan");
    expect(askedBy(request({}), admin, {})).toBe("Asked by someone in the app");
    expect(askedBy(request({ requestedBy: null, source: "scheduled" }), admin, {})).toBe("From a scheduled check");
  });
});

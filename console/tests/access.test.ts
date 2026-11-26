import { describe, expect, it } from "vitest";
import { accessFromRows, canApproveAgent, canManageAgent, canSeeClient, canUseAgent, isAdmin, parseAdmins, parseClients, visibleClients, type AccessRow } from "@/lib/access";

const row = (over: Partial<AccessRow>): AccessRow => ({ client_id: "kestrel", agent_id: "iris", can_approve: false, can_manage: false, revoked_at: null, ...over });

describe("accessFromRows", () => {
  it("grants exactly the active rows: revoked and malformed rows grant nothing", () => {
    const access = accessFromRows([
      row({}),
      row({ agent_id: "scout", revoked_at: "2026-11-24T10:00:00Z" }),
      row({ client_id: "Kestrel Garage's", agent_id: "ledger" }),
    ]);
    expect(canUseAgent(access, "kestrel", "iris")).toBe(true);
    expect(canUseAgent(access, "kestrel", "scout")).toBe(false);
    expect(access.grants).toHaveLength(1);
  });

  it("never treats approving as managing, or a truthy non-boolean as a right", () => {
    const access = accessFromRows([row({ can_approve: true }), row({ agent_id: "ledger", can_manage: "yes" as unknown as boolean })]);
    expect(canApproveAgent(access, "kestrel", "iris")).toBe(true);
    expect(canManageAgent(access, "kestrel", "iris")).toBe(false);
    expect(canManageAgent(access, "kestrel", "ledger")).toBe(false);
  });

  it("keeps rights to their own client", () => {
    const access = accessFromRows([row({ can_approve: true, can_manage: true })]);
    expect(canUseAgent(access, "harbour", "iris")).toBe(false);
    expect(canApproveAgent(access, "harbour", "iris")).toBe(false);
  });
});

describe("clients and admins from settings", () => {
  const clients = parseClients(`[{"id":"kestrel","name":" Kestrel Garage "},{"id":"Bad Id","name":"x"},{"id":"harbour"},{"id":"wren","name":"Wren & Co"}]`);

  it("keeps only well-formed clients, never guessing a name", () => {
    expect(clients).toEqual([{ id: "kestrel", name: "Kestrel Garage" }, { id: "wren", name: "Wren & Co" }]);
    expect(parseClients("not json")).toEqual([]);
    expect(parseClients(undefined)).toEqual([]);
  });

  it("shows a person only the clients where they use an employee", () => {
    const access = accessFromRows([row({})]);
    expect(visibleClients(access, clients)).toEqual([{ id: "kestrel", name: "Kestrel Garage" }]);
    expect(canSeeClient(access, clients, "wren")).toBeUndefined();
  });

  it("matches admins by email without case or spaces", () => {
    const admins = parseAdmins(" Robin@Northlight.example, ,ops@northlight.example,robin@northlight.example");
    expect(admins).toEqual(["robin@northlight.example", "ops@northlight.example"]);
    expect(isAdmin("ROBIN@northlight.example ", admins)).toBe(true);
    expect(isAdmin("", admins)).toBe(false);
    expect(isAdmin("someone@else.example", admins)).toBe(false);
  });
});

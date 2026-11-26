import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServicesDraft } from "../src/app/(app)/c/[client]/[agent]/calls/actions";

const mock = vi.hoisted(() => ({
  viewer: vi.fn(), record: vi.fn(), brain: vi.fn(), synced: vi.fn(),
}));
vi.mock("@/lib/server/session", () => ({ actionViewer: mock.viewer }));
vi.mock("@/lib/server/iris-calls.mjs", () => ({ pilotCall: mock.record }));
vi.mock("@/lib/server/brain", () => ({ callDraft: mock.brain }));
vi.mock("@/lib/server/people", () => ({ brainHasAccess: mock.synced }));

const grant = { clientId: "kestrel", agentId: "iris", canManage: true, canApprove: false };
const userId = "sandbox-user";
const submit = () => createServicesDraft("kestrel", "iris", "conv_november");
const viewer = (canManage: boolean) => ({
  email: "alex@kestrel.example", userId, access: { grants: [{ ...grant, canManage }] },
});
const turn = (who: string, text: string) => ({ who, text });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("IRIS_CALL_HISTORY_KEY", "fixture");
  vi.stubEnv("KESTREL_HISTORY_CALLERS", JSON.stringify([{ userId, phone: "+441632960100", since: 1700000000 }]));
  mock.viewer.mockResolvedValue(viewer(true));
  mock.synced.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("create a Services draft from an owned transcript", () => {
  it("preserves follow-up instructions and attributes only caller speech to the caller", async () => {
    mock.record.mockResolvedValue({ turns: [
      turn("Iris", "I can rewrite the homepage."),
      turn("You", "Review our Services title."), turn("You", "Keep Jamie's wording and design."),
    ] });
    expect(await submit()).toEqual({});
    expect(mock.brain).toHaveBeenCalledWith("kestrel", userId, "conv_november", "Review our Services title.\nKeep Jamie's wording and design.");
  });

  it("checks management access before reading a transcript", async () => {
    mock.viewer.mockResolvedValue(viewer(false));
    expect(await submit()).toHaveProperty("error");
    expect(mock.record).not.toHaveBeenCalled();
    expect(mock.brain).not.toHaveBeenCalled();
  });

  it.each([
    null,
    { turns: [turn("Iris", "We can review Services."), turn("You", "No thanks.")] },
    { turns: [turn("You", "Services"), turn("You", "x".repeat(5000))] },
  ])("rejects missing, unrelated or oversized call input without creating a title", async record => {
    mock.record.mockResolvedValue(record);
    expect(await submit()).toHaveProperty("error");
    expect(mock.brain).not.toHaveBeenCalled();
  });

  it("allows another attempt when the staff grant is still syncing", async () => {
    mock.record.mockResolvedValue({ turns: [turn("You", "Review Services.")] });
    mock.synced.mockResolvedValueOnce(false);
    expect(await submit()).toHaveProperty("error");
    expect(mock.brain).not.toHaveBeenCalled();
    expect(await submit()).toEqual({});
    expect(mock.brain).toHaveBeenCalledTimes(1);
  });
});

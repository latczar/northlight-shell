import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AGENTS } from "../agents";
import { CLIENTS } from "../clients";
import type { ToolDefinition } from "../src/contracts";
import { runTurn } from "../src/loop";
import { Store } from "../src/store";
import { signUserPass } from "../src/user-auth";
import { TOOLS } from "../tools";
import { APPROVER } from "./access";
import { testDeskApi } from "./desk";

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const usage = { inputTokens: 1, outputTokens: 1 };
const choiceTool: ToolDefinition = {
  name: "test_choice_publish", description: "Publish the chosen title", permission: "dashboard.write", effect: "write", parallelSafe: false, timeoutMs: 5_000,
  parameters: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false },
  approval: () => ({ title: "Pick a title", summary: "Only the chosen title is published.", choices: [
    { id: "first", label: "First", detail: "$10 a year", note: "Helper's pick", args: { title: "Chosen first" } },
    { id: "second", label: "Second", detail: "$12 a year", args: { title: "Chosen second" } },
  ], defaultChoice: "first" }),
  async execute(context, args) {
    await context.bindings.IMAGES.put(`choice-runs/${context.actionId}/${crypto.randomUUID()}`, "1");
    return { data: { published: args.title } };
  },
};

async function propose(conversationId: string) {
  const id = `call-${conversationId}`;
  const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(`acme/helper/${conversationId}`));
  await runInDurableObject(stub, async (instance, state) => {
    const catalog = { ...TOOLS, [choiceTool.name]: choiceTool };
    instance.catalog = catalog;
    let step = 0;
    const model = { async turn() { return step++ === 0
      ? { content: "", toolCalls: [{ id, type: "function" as const, function: { name: choiceTool.name, arguments: JSON.stringify({ title: "Original" }) } }], usage }
      : { content: "Waiting for approval", toolCalls: [], usage }; } };
    instance.model = model;
    const store = new Store(state.storage); store.bind("acme", "helper", APPROVER);
    await runTurn({ store, model, client: CLIENTS.find(c => c.id === "acme")!, agent: { ...AGENTS.helper, tools: [...AGENTS.helper.tools, choiceTool.name] }, catalog, conversationId, userId: APPROVER, source: "app", bindings: env, desk: testDeskApi(), modelKey: () => "key", emit: () => {} }, { id: "m1", text: "publish it" });
  });
  return id;
}

const decide = async (id: string, decision: string, choice?: string) => SELF.fetch(`https://brain/v1/approvals/${id}`, {
  method: "POST", headers: { ...auth, "x-admin-pass": await signUserPass("test-approver-key-acme-0123456789abcdef", "acme", "app-admin", Math.floor(Date.now() / 1000) + 3600, "admin") },
  body: JSON.stringify({ decision, choice }),
});

// A separate file gives these HTTP cases an isolated native rate limiter, rather than exhausting the existing approval suite's quota.
describe("approval choice API", () => {
  it("requires a stored choice, executes its exact arguments, and rejects a second different choice", async () => {
    const id = await propose("choice-api");
    const detail = await SELF.fetch(`https://brain/v1/approvals/${id}`, { headers: auth });
    const card = await detail.json();
    expect(card).toMatchObject({ defaultChoice: "first", choices: [{ id: "first", label: "First", detail: "$10 a year", note: "Helper's pick" }, { id: "second", label: "Second", detail: "$12 a year" }] });
    expect(JSON.stringify(card)).not.toContain('"args"');
    const list = await SELF.fetch("https://brain/v1/approvals?status=pending", { headers: auth });
    expect(await list.json()).toMatchObject({ approvals: [expect.objectContaining({ id, defaultChoice: "first", choices: expect.any(Array) })] });
    for (const choice of [undefined, "wrong"]) {
      const response = await decide(id, "approve", choice);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Pick one of the options first." });
    }
    expect((await env.IMAGES.list({ prefix: `choice-runs/${id}/` })).objects).toHaveLength(0);
    const first = await decide(id, "approve", "second");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "done", choice: "second", result: { result: { published: "Chosen second" } } });
    expect((await decide(id, "approve", "second")).status).toBe(200);
    expect((await decide(id, "approve", "first")).status).toBe(409);
    expect((await env.IMAGES.list({ prefix: `choice-runs/${id}/` })).objects).toHaveLength(1);
    const decline = await propose("choice-api-decline");
    expect((await decide(decline, "decline")).status).toBe(200);
    expect((await env.IMAGES.list({ prefix: `choice-runs/${decline}/` })).objects).toHaveLength(0);
  });

  it("names the stored choice in a conflicting approval while retaining the approval record", async () => {
    const id = await propose("choice-conflict-wording");
    expect((await decide(id, "approve", "second")).status).toBe(200);
    const conflict = await decide(id, "approve", "first");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      id, status: "done", choice: "second", error: "Already approved with second.",
      result: { result: { published: "Chosen second" } },
    });
    expect((await env.IMAGES.list({ prefix: `choice-runs/${id}/` })).objects).toHaveLength(1);
  });
});

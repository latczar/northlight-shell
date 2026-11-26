import { testDesk } from "./desk";
import { toolBindings } from "../src/bindings";
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../src/contracts";
import type { ModelAdapter, ModelTurnRequest } from "../src/model";
import { fallbackTool, forget, imageTool, recall, remember } from "../src/tools";
import { signUserPass } from "../src/user-auth";

const SIGNING_KEY = "test-signing-key-acme-0123456789abcdef";
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const pass = (userId: string, clientId = "acme", key = SIGNING_KEY, expiresAt = inAnHour()) => signUserPass(key, clientId, userId, expiresAt);

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    clientId: "acme", agentId: "second", conversationId: "c1", actionId: crypto.randomUUID(),
    signal: new AbortController().signal, bindings: toolBindings(env), actionResult: () => undefined, brokenRule: () => undefined, reserveSpend: async () => true, settings: {}, ...testDesk({ agentId: "second", secrets: {} }), ...overrides,
  };
}

describe("fallback tools", () => {
  it("uses the next provider when the first fails or returns nothing, and truncates long content", async () => {
    const tried: string[] = [];
    const search = fallbackTool({
      name: "web_search", description: "", parameters: {}, permission: "web.read", maxChars: 5,
      providers: [
        { label: "down", async call() { tried.push("down"); throw new Error("503"); } },
        { label: "empty", async call() { tried.push("empty"); return "  "; } },
        { label: "ok", async call() { tried.push("ok"); return "0123456789"; } },
      ],
    });
    const result = await search.execute(context(), { query: "x" });
    expect(tried).toEqual(["down", "empty", "ok"]);
    expect(result.data).toEqual({ source: "ok", content: "01234", truncated: true, untrusted: true });
  });

  it("fails definitely when every provider fails", async () => {
    const search = fallbackTool({
      name: "web_search", description: "", parameters: {}, permission: "web.read",
      providers: [{ label: "down", async call() { throw new Error("503"); } }],
    });
    await expect(search.execute(context(), {})).rejects.toMatchObject({ definite: true });
  });
});

describe("generate_image", () => {
  it("creates one draft per action, even when retried, and reconciles it", async () => {
    let generated = 0;
    const tool = imageTool(async () => { generated++; return new Uint8Array([137, 80, 78, 71]); });
    const ctx = context();
    expect((await tool.reconcile!(ctx, {})).status).toBe("absent");
    const first = await tool.execute(ctx, { prompt: "a bakery storefront at dawn" });
    await tool.execute(ctx, { prompt: "a bakery storefront at dawn" });
    expect(generated).toBe(1);
    expect(first.data).toMatchObject({ imageId: ctx.actionId, status: "draft" });
    expect(await tool.reconcile!(ctx, {})).toMatchObject({ status: "succeeded" });
  });

  it("serves a draft only to the client that created it", async () => {
    const ctx = context({ clientId: "acme" });
    await imageTool(async () => new Uint8Array([1, 2, 3])).execute(ctx, { prompt: "a bakery storefront at dawn" });
    const auth = { authorization: "Bearer test-token-acme-0123456789abcdef" };
    const own = await SELF.fetch(`https://brain/v1/images/${ctx.actionId}`, { headers: auth });
    expect(own.status).toBe(200);
    expect(new Uint8Array(await own.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    const other = context({ clientId: "someone-else" });
    await imageTool(async () => new Uint8Array([9])).execute(other, { prompt: "another client's private draft" });
    expect((await SELF.fetch(`https://brain/v1/images/${other.actionId}`, { headers: auth })).status).toBe(404);
  });
});

describe("memory", () => {
  it("keeps facts per client and person, with idempotent remember and working forget", async () => {
    const ana = context({ userId: "ana" });
    const ben = context({ userId: "ben" });
    await remember.execute(ana, { fact: "Runs a bakery in Denver" });
    await remember.execute(ana, { fact: "Runs a bakery in Denver" }); // same action id: retry
    expect((await recall.execute(ana, { query: "bakery" })).data.facts).toEqual([{ id: ana.actionId, text: "Runs a bakery in Denver" }]);
    expect((await recall.execute(ben, { query: "bakery" })).data.facts).toEqual([]);
    expect((await recall.execute(context({ userId: "ana", clientId: "other" }), { query: "bakery" })).data.facts).toEqual([]);

    await forget.execute(context({ userId: "ana" }), { factId: ana.actionId });
    expect((await recall.execute(ana, { query: "bakery" })).data.facts).toEqual([]);
  });

  it("is not offered without a person, and shows saved facts to every agent of the same client", async () => {
    const requests: ModelTurnRequest[] = [];
    const model: ModelAdapter = {
      async turn(request) {
        requests.push(request);
        return { content: "ok", toolCalls: [], usage: { inputTokens: 10, outputTokens: 2 } };
      },
    };
    await remember.execute(context({ userId: "cara" }), { fact: "Prefers email over phone" });
    for (const name of ["acme/second/m-anon", "acme/helper/m-cara"]) {
      await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(name)), instance => { instance.model = model; });
    }
    const headers = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
    await (await SELF.fetch("https://brain/v1/agents/second/conversations/m-anon/messages", { method: "POST", headers, body: JSON.stringify({ text: "hi" }) })).text();
    await (await SELF.fetch("https://brain/v1/agents/helper/conversations/m-cara/messages", { method: "POST", headers, body: JSON.stringify({ text: "hi", userAuth: await pass("cara") }) })).text();

    const [anonymous, cara] = requests;
    expect(anonymous.tools.map(t => t.name)).not.toContain("remember");
    expect(anonymous.messages[0].content).not.toContain("Prefers email");
    expect(cara.tools.map(t => t.name)).toEqual(expect.arrayContaining(["remember", "recall", "forget"]));
    expect(cara.messages[0].content).toContain("Prefers email over phone");

    // The same conversation id cannot be reused for a different person.
    const reuse = await SELF.fetch("https://brain/v1/agents/helper/conversations/m-cara/messages", { method: "POST", headers, body: JSON.stringify({ text: "hi", userAuth: await pass("dan") }) });
    expect(reuse.status).toBe(409);
  });

  it("rejects forged, tampered, expired and other-client user passes", async () => {
    const headers = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
    const send = async (body: object, path = "https://brain/v1/agents/second/conversations/forge/messages") =>
      (await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify({ text: "what do you know about me?", ...body }) })).status;

    const valid = await pass("erin");
    const [, expiry, signature] = valid.split(".");
    expect(await send({ userAuth: "erin" })).toBe(401); // bare id, the old way
    expect(await send({ userAuth: `mallory.${expiry}.${signature}` })).toBe(401); // someone else's signature
    expect(await send({ userAuth: await pass("erin", "acme", "x".repeat(40)) })).toBe(401); // wrong key
    expect(await send({ userAuth: await pass("erin", "other-client") })).toBe(401); // other client
    expect(await send({ userAuth: await pass("erin", "acme", SIGNING_KEY, Math.floor(Date.now() / 1000) - 1) })).toBe(401); // expired
    expect(await send({ userAuth: await pass("erin", "acme", SIGNING_KEY, inAnHour() + 2 * 86_400) })).toBe(401); // lifetime too long
    // A raw userId is ignored: the turn runs with no person, so memory is not offered.
    const requests: ModelTurnRequest[] = [];
    await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("acme/second/forge")), instance => {
      instance.model = { async turn(request) { requests.push(request); return { content: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } }; } };
    });
    const raw = await SELF.fetch("https://brain/v1/agents/second/conversations/forge/messages", { method: "POST", headers, body: JSON.stringify({ text: "hi", userId: "erin" }) });
    await raw.text();
    expect(raw.status).toBe(200);
    expect(requests[0].tools.map(t => t.name)).not.toContain("recall");

    // The ElevenLabs path checks the same pass.
    const voice = await SELF.fetch("https://brain/v1/chat/completions", {
      method: "POST", headers,
      body: JSON.stringify({ model: "second", messages: [{ role: "user", content: "hi" }], elevenlabs_extra_body: { conversation_id: "v-forge", user_auth: "erin" } }),
    });
    expect(voice.status).toBe(401);
  });
});

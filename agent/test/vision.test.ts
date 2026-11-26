import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { AgentTemplate, ClientConfig, ModelMessage, ToolDefinition, ToolPicture, TurnEvent } from "../src/contracts";
import { ModelProtocolError, ToolError } from "../src/errors";
import { runTurn, type TurnDeps } from "../src/loop";
import { MEDIA_PUBLIC_BASE } from "../src/media";
import type { ModelAdapter, ModelTurnReply, ModelTurnRequest } from "../src/model";
import { Store } from "../src/store";
import { requestInputEstimate, toolPictures, withImages } from "../src/vision";
import { noDesk } from "./desk";
import { AGENTS } from "../agents";
import { TOOLS } from "../tools";
import { checkBackNote } from "../src/jobs";

// The loop runs for real against real conversation storage and the real (local) media bucket; only the model is scripted.

const client: ClientConfig = {
  id: "seer", name: "Seer Co", tokenEnv: "CLIENT_TOKEN_TEST", agents: ["helper"], permissions: [],
  model: { baseURL: "https://model.invalid", model: "fake", secretEnv: "DEEPSEEK_API_KEY", inputCostPerMillion: 1, outputCostPerMillion: 1, maxOutputTokens: 1000, contextWindowTokens: 100_000, images: true },
};
const agent: AgentTemplate = { id: "helper", name: "Helper", role: "test", prompt: "You help.", tools: [] };
const reply = (content: string): ModelTurnReply => ({ content, toolCalls: [], usage: { inputTokens: 100, outputTokens: 10 } });

function scripted(answer: (request: ModelTurnRequest) => ModelTurnReply = () => reply("ok")) {
  const requests: ModelTurnRequest[] = [];
  const model: ModelAdapter = { async turn(request) { requests.push(request); return answer(request); } };
  return { model, requests };
}

async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.newUniqueId());
  return runInDurableObject(stub, async (_instance, state) => fn(new Store(state.storage)));
}

function deps(store: Store, model: ModelAdapter, overrides: Partial<TurnDeps> = {}): TurnDeps {
  const events: TurnEvent[] = [];
  return { store, model, client, agent, catalog: {}, conversationId: "c1", bindings: env, desk: noDesk, modelKey: () => "key", emit: event => events.push(event), ...overrides };
}

let n = 0;
/** Puts a file in the media bucket the way a finished upload leaves it, and returns its key. */
async function file(contentType: string, { owner = client.id, bytes = 10 } = {}): Promise<string> {
  const key = `${owner}/chat-uploads/${String(++n).padStart(16, "0")}-file.bin`;
  await env.MEDIA.put(key, new Uint8Array(bytes), { httpMetadata: { contentType } });
  return key;
}
const link = (key: string) => `${MEDIA_PUBLIC_BASE}/${key}`;
const attached = (...keys: string[]) => `\n\nAttached files:\n${keys.map((key, i) => `#${i + 1}: ${link(key)} (image/png, 800×600, file.bin)`).join("\n")}`;
/** The image addresses each message of a request carries. */
const images = (messages: ModelMessage[]) => messages.map(message => Array.isArray(message.content) ? message.content.flatMap(part => part.type === "image_url" ? [part.image_url.url] : []) : []);
const lastImages = (request: ModelTurnRequest) => images(request.messages).flat();

describe("images a person attaches", () => {
  it("are sent with their message when they are the client's own library images, and only then", async () => {
    await withStore(async store => {
      const mine = await file("image/png");
      const video = await file("video/mp4");
      const theirs = await file("image/png", { owner: "other" });
      const missing = `${client.id}/chat-uploads/${"9".repeat(16)}-gone.png`;
      const text = `What is on #1?${attached(mine, video, theirs, missing)}\nAlso see https://example.com/outside.png`;
      const { model, requests } = scripted();
      await runTurn(deps(store, model), { id: "m1", text });

      const sent = requests[0].messages.at(-1)!;
      expect(sent.content).toEqual([{ type: "text", text }, { type: "image_url", image_url: { url: link(mine) } }]);
      // The saved conversation keeps the person's words as they wrote them.
      expect(store.messages().map(row => row.message)[0]).toEqual({ role: "user", content: text });
    });
  });

  it("stay in view for later messages, newest four only", async () => {
    await withStore(async store => {
      const keys = await Promise.all(Array.from({ length: 5 }, () => file("image/jpeg")));
      const { model, requests } = scripted();
      await runTurn(deps(store, model), { id: "m1", text: `First two${attached(keys[0], keys[1])}` });
      await runTurn(deps(store, model), { id: "m2", text: `Three more${attached(keys[2], keys[3], keys[4])}` });
      await runTurn(deps(store, model), { id: "m3", text: "Which of them shows the roof?" });

      expect(lastImages(requests[0])).toEqual([link(keys[0]), link(keys[1])]);
      // The newest message's three, then the newest of the older ones that still fits: the first image is a link again.
      expect(images(requests[2].messages).filter(urls => urls.length)).toEqual([[link(keys[1])], [link(keys[2]), link(keys[3]), link(keys[4])]]);
    });
  });

  it("do not cost the person their answer when the provider will not open them, and are not sent again", async () => {
    await withStore(async store => {
      const broken = await file("image/png");
      const { model, requests } = scripted(request => {
        if (lastImages(request).length) throw new ModelProtocolError("Model provider returned HTTP 400.", 400);
        return reply("I could not open the image.");
      });
      const result = await runTurn(deps(store, model), { id: "m1", text: `Look${attached(broken)}` });
      expect(result).toMatchObject({ status: "replied", text: "I could not open the image." });
      expect(requests.map(lastImages)).toEqual([[link(broken)], []]);
      // The agent was told why, as a runtime note.
      expect(requests[1].messages.at(-1)!.content).toMatch(/^\[Runtime note, not from the user\] An attached image could not be opened/);
      // The refused request was never billed, so only the answered one counts: 100 tokens in, 10 out, at $1 per million.
      expect(store.spentUsd()).toBeCloseTo(0.00011, 8);

      await runTurn(deps(store, model), { id: "m2", text: "And now?" });
      expect(lastImages(requests[2])).toEqual([]);
    });
  });

  it("a refused image does not take the ones the agent has already seen with it", async () => {
    await withStore(async store => {
      const good = await file("image/png");
      const broken = await file("image/png");
      const { model, requests } = scripted(request => {
        if (lastImages(request).includes(link(broken))) throw new ModelProtocolError("Model provider returned HTTP 400.", 400);
        return reply("ok");
      });
      await runTurn(deps(store, model), { id: "m1", text: `First${attached(good)}` });
      await runTurn(deps(store, model), { id: "m2", text: `Second${attached(broken)}` });
      await runTurn(deps(store, model), { id: "m3", text: "Compare them." });
      expect(requests.map(lastImages)).toEqual([[link(good)], [link(good), link(broken)], [], [link(good)]]);
    });
  });

  it("a refusal that is not about the images fails as before, after one try without them, and blames nothing", async () => {
    await withStore(async store => {
      const keys = await Promise.all(Array.from({ length: 6 }, () => file("image/png")));
      const down = scripted(() => { throw new ModelProtocolError("Model provider returned HTTP 400.", 400); });
      await expect(runTurn(deps(store, down.model), { id: "m1", text: `Look${attached(...keys)}` })).rejects.toThrow("HTTP 400");
      // Once with the newest four, once with none: never a walk back through the older ones.
      expect(down.requests.map(request => lastImages(request).length)).toEqual([4, 0]);
      expect(store.messages().map(row => row.message.content).join("\n")).not.toContain("could not be opened");

      const up = scripted();
      await runTurn(deps(store, up.model), { id: "m2", text: "Again?" });
      expect(lastImages(up.requests[0])).toHaveLength(4);

      const plain = scripted(() => { throw new ModelProtocolError("Model provider returned HTTP 400.", 400); });
      await expect(runTurn(deps(store, plain.model, { client: { ...client, model: { ...client.model, images: false } } }), { id: "m3", text: "Hello" })).rejects.toThrow("HTTP 400");
      expect(plain.requests).toHaveLength(1);
    });
  });

  it("a media bucket that is down or a message full of dead links never fails or stalls the reply", async () => {
    const text = `Look${attached(...Array.from({ length: 40 }, (_, i) => `${client.id}/chat-uploads/${String(i).padStart(16, "a")}-gone.png`))}`;
    const messages = [{ role: "user" as const, content: text }];
    let asked = 0;
    const known = new Map<string, boolean>();
    const dead = await withImages(messages, client.id, { head: async () => { asked++; return null; } }, known, new Set());
    expect(dead).toEqual({ messages, keys: [] });
    expect(asked).toBe(12);

    const down = await withImages(messages, client.id, { head: async () => { throw new Error("R2 is down"); } }, new Map(), new Set());
    expect(down).toEqual({ messages, keys: [] });
  });

  it("are links only for a client whose model does not read images, and on a call", async () => {
    await withStore(async store => {
      const mine = await file("image/png");
      const text = `Look${attached(mine)}`;
      const blind = scripted();
      await runTurn(deps(store, blind.model, { client: { ...client, model: { ...client.model, images: false } } }), { id: "m1", text });
      expect(blind.requests[0].messages.at(-1)!.content).toBe(text);
      expect(blind.requests[0].messages[0].content).not.toContain("Images:");

      const call = scripted();
      await runTurn(deps(store, call.model, { voice: true }), { id: "m2", text: "And on the phone?" });
      expect(lastImages(call.requests[0])).toEqual([]);
      expect(call.requests[0].messages[0].content).not.toContain("Images:");
    });
  });
});

describe("private pictures from a tool", () => {
  it("tells the model that a screenshot's bottom edge is a viewport boundary, not a page defect", async () => {
    const key = `helper/${client.id}/looks/boundary.jpg`;
    await env.IMAGES.put(key, "jpeg", { httpMetadata: { contentType: "image/jpeg" } });
    const result = await toolPictures([{ key, label: "Phone 390×844, the first screen only (the page continues below)" }], "look", env.IMAGES, new Set());
    expect(JSON.stringify(result.message)).toMatch(/bottom edge.*screen ends.*not a fault/);
  });
  async function picture(label: string): Promise<ToolPicture> {
    const key = `helper/${client.id}/looks/${crypto.randomUUID()}.jpg`;
    await env.IMAGES.put(key, label, { httpMetadata: { contentType: "image/jpeg" } });
    return { key, label };
  }
  function picturedTool(pictures: Record<string, ToolPicture[]>): ToolDefinition {
    return {
      name: "look", parameters: { type: "object" }, description: "look", permission: "test", effect: "read", parallelSafe: false, timeoutMs: 1000,
      async execute(_context, args) { return { data: { measured: "all three checks passed" }, pictures: pictures[String(args.which)] }; },
    };
  }
  const call = (id: string, which: string) => ({ id, type: "function" as const, function: { name: "look", arguments: JSON.stringify({ which }) } });
  const options = (tool: ToolDefinition): Partial<TurnDeps> => ({
    agent: { ...agent, tools: ["look"] }, client: { ...client, permissions: ["test"] }, catalog: { look: tool },
  });

  it("shows only the newest pictured result, at most two, after every tool result, never in chat history", async () => {
    const older = await picture("older");
    const newest = await Promise.all(["desktop", "phone", "extra"].map(picture));
    const tool = picturedTool({ older: [older], newest });
    const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.newUniqueId());
    await runInDurableObject(stub, async (instance, state) => {
      const store = new Store(state.storage);
      store.bind(client.id, agent.id);
      store.setMeta("user", "alex");
      let step = 0;
      const { model, requests } = scripted(() => step++ === 0
        ? { ...reply(""), toolCalls: [call("older", "older"), call("newest", "newest"), call("text", "text")] }
        : reply("I saw the preview."));
      await runTurn(deps(store, model, { ...options(tool), userId: "alex" }), { id: "pictures", text: "Check it." });
      const sent = requests[1].messages;
      expect(sent.slice(-5).map(m => m.role)).toEqual(["assistant", "tool", "tool", "tool", "user"]);
      expect(sent.at(-1)?.content).toEqual([
        { type: "text", text: expect.stringContaining("look: desktop; phone") },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${btoa("desktop")}` } },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${btoa("phone")}` } },
      ]);
      expect(store.messages().filter(row => row.message.role === "user")).toHaveLength(1);
      const history = await instance.history(client.id, agent.id, "alex", 100);
      expect(history.messages.map(message => message.text)).toEqual(["Check it.", "I saw the preview."]);
      expect(JSON.stringify(history)).not.toContain("Runtime pictures");
      expect(JSON.stringify(history)).not.toContain("data:image");
    });
  });

  it.each([false, true])("does not resend a previous turn's pictures or inability note (missing: %s)", async missing => {
    await withStore(async store => {
      const pic = await picture("desktop");
      if (missing) await env.IMAGES.delete(pic.key);
      let step = 0;
      const { model, requests } = scripted(() => step++ === 0 ? { ...reply(""), toolCalls: [call("look", "newest")] } : reply("Looked."));
      const configured = deps(store, model, options(picturedTool({ newest: [pic] })));
      await runTurn(configured, { id: "m1", text: "Look." });
      await runTurn(configured, { id: "m2", text: "Something else." });
      expect(lastImages(requests[2])).toEqual([]);
      expect(JSON.stringify(requests[2].messages)).not.toContain("could not be shown");
    });
  });

  it.each([false, true])("keeps pictures or their inability note after an output-rule runtime note (missing: %s)", async missing => {
    await withStore(async store => {
      const pic = await picture("desktop");
      if (missing) await env.IMAGES.delete(pic.key);
      let step = 0;
      const { model, requests } = scripted(request => {
        if (step++ === 0) return { ...reply(""), toolCalls: [call("look", "newest")] };
        const text = step === 2 ? "Forbidden." : "I checked the preview.";
        request.onText?.(text);
        return reply(text);
      });
      const configured = options(picturedTool({ newest: [pic] }));
      configured.client = { ...client, permissions: ["test"], outputRules: [{ id: "forbidden", pattern: "Forbidden", message: "Do not say Forbidden." }] };
      await runTurn(deps(store, model, configured), { id: "m1", text: "Look." });
      expect(requests).toHaveLength(3);
      expect(requests[2].messages).toContainEqual(expect.objectContaining({ role: "user", content: expect.stringContaining("[Runtime note, not from the user] Your reply was stopped") }));
      expect(lastImages(requests[2])).toHaveLength(missing ? 0 : 1);
      expect(JSON.stringify(requests[2].messages).includes("could not be shown the screenshot")).toBe(missing);
    });
  });

  it.each([false, true])("keeps pictures across a job check-back note, but not a newer person's message (missing: %s)", async missing => {
    await withStore(async store => {
      const pic = await picture("desktop");
      if (missing) await env.IMAGES.delete(pic.key);
      let step = 0;
      const { model, requests } = scripted(() => step++ === 0 ? { ...reply(""), toolCalls: [call("look", "newest")] } : reply("Checked."));
      const configured = deps(store, model, options(picturedTool({ newest: [pic] })));
      await runTurn(configured, { id: "job-1", text: "Check it." });
      await runTurn(configured, { id: "job-2", text: checkBackNote("The build was running") });
      expect(lastImages(requests[2])).toHaveLength(missing ? 0 : 1);
      expect(JSON.stringify(requests[2].messages).includes("could not be shown the screenshot")).toBe(missing);
      await runTurn(configured, { id: "person", text: "Something else." });
      expect(lastImages(requests[3])).toEqual([]);
      expect(JSON.stringify(requests[3].messages)).not.toContain("could not be shown");
    });
  });

  it.each(["voice", "off", "missing"] as const)("does not attach screenshots when %s; measures and the reason stay in the tool text", async mode => {
    await withStore(async store => {
      const pic = await picture("desktop");
      if (mode === "missing") await env.IMAGES.delete(pic.key);
      let step = 0;
      const { model, requests } = scripted(() => step++ === 0 ? { ...reply(""), toolCalls: [call("look", "newest")] } : reply("I could not see the screenshot."));
      const override = options(picturedTool({ newest: [pic] }));
      if (mode === "voice") override.voice = true;
      if (mode === "off") override.client = { ...client, permissions: ["test"], model: { ...client.model, images: false } };
      await runTurn(deps(store, model, override), { id: "m1", text: "Look." });
      expect(lastImages(requests[1])).toEqual([]);
      expect(requests[1].messages.findLast(m => m.role === "tool")?.content).toContain("all three checks passed");
      expect(requests[1].messages.findLast(m => m.role === "tool")?.content).toContain("could not be shown the screenshot");
    });
  });

  it("retries without tool pictures when the provider refuses images", async () => {
    await withStore(async store => {
      const pic = await picture("desktop");
      let step = 0;
      const { model, requests } = scripted(request => {
        if (step++ === 0) return { ...reply(""), toolCalls: [call("look", "newest")] };
        if (lastImages(request).length) throw new ModelProtocolError("HTTP 400", 400);
        return reply("I could not see it.");
      });
      await runTurn(deps(store, model, options(picturedTool({ newest: [pic] }))), { id: "m1", text: "Look." });
      expect(requests.map(r => lastImages(r).length)).toEqual([0, 1, 0]);
      expect(requests[2].messages.findLast(m => m.role === "tool")?.content).toContain("could not be shown the screenshot");
    });
  });

  it("keeps the shared four-image request cap when chat and tool images meet", async () => {
    await withStore(async store => {
      const toolPics = await Promise.all(["desktop", "phone"].map(picture));
      const chatPics = await Promise.all(Array.from({ length: 4 }, () => file("image/png")));
      let step = 0;
      const { model, requests } = scripted(() => step++ === 0 ? { ...reply(""), toolCalls: [call("look", "newest")] } : reply("Looked."));
      await runTurn(deps(store, model, options(picturedTool({ newest: toolPics }))), { id: "m1", text: `Check it.${attached(...chatPics)}` });
      expect(lastImages(requests[1])).toHaveLength(4);
      expect(lastImages(requests[1]).filter(url => url.startsWith("data:"))).toHaveLength(2);
    });
  });

  it("skips non-JPEG and oversized bucket objects without reading their bytes", async () => {
    let read = false;
    const tooLarge = { size: 20 * 1024 * 1024 + 1, httpMetadata: { contentType: "image/jpeg" }, arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } };
    const bucket = { get: async () => tooLarge } as unknown as Pick<R2Bucket, "get">;
    expect(await toolPictures([{ key: "private", label: "large" }], "look", bucket, new Set())).toEqual({ keys: [] });
    expect(read).toBe(false);
    const png = await file("image/png");
    expect(await toolPictures([{ key: png, label: "png" }], "look", env.MEDIA, new Set())).toEqual({ keys: [] });
  });
});

describe("image request reservations", () => {
  it("reserves the same for a 700 KB data URL as for a public image URL", () => {
    const request = (url: string): ModelMessage[] => [{ role: "user", content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url } }] }];
    const data = request(`data:image/jpeg;base64,${"a".repeat(700 * 1024)}`);
    const publicImage = request("https://media.example.test/image.jpg");
    expect(requestInputEstimate(data, [])).toBe(requestInputEstimate(publicImage, []));
    expect(requestInputEstimate(data, [])).toBeLessThan(9000);
  });
  it("leaves a normal text request's estimate unchanged", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "Hello there" }];
    const tools = [{ name: "test" }];
    expect(requestInputEstimate(messages, tools)).toBe(new TextEncoder().encode(JSON.stringify({ messages, tools })).length + 256);
  });
});

it("awaits an asynchronous approval refusal: the model gets the reason, with no card or pending action", async () => {
  await withStore(async store => {
    const tool: ToolDefinition = {
      name: "publish", description: "publish", parameters: { type: "object" }, permission: "test", effect: "write", parallelSafe: false, timeoutMs: 1000,
      async approval() { await Promise.resolve(); throw new ToolError("The page look failed: fix missing styles.", true); },
      async execute() { throw new Error("Must not execute"); },
    };
    const cid = `approval-${crypto.randomUUID()}`;
    let step = 0;
    const { model, requests } = scripted(() => step++ === 0
      ? { ...reply(""), toolCalls: [{ id: "publish-refused", type: "function", function: { name: "publish", arguments: "{}" } }] }
      : reply("Fix the styles first."));
    await runTurn(deps(store, model, { client: { ...client, id: cid, permissions: ["test"] }, agent: { ...agent, tools: ["publish"] }, catalog: { publish: tool } }), { id: "m1", text: "Publish." });
    expect(requests[1].messages.at(-1)?.content).toContain("page look failed: fix missing styles");
    expect(store.action("publish-refused")?.status).toBe("failed");
    expect(store.actions("awaiting_approval")).toEqual([]);
    expect(JSON.parse(await env.DASHBOARD.get(env.DASHBOARD.idFromName(cid)).approvals()).approvals).toEqual([]);
  });
});

it.each(["approval", "plan"] as const)("bounds a slow %s by the tool and turn deadlines and never files after timeout", async phase => {
  for (const turnLimit of [false, true]) {
    vi.useFakeTimers();
    try {
      await withStore(async store => {
        let signal: AbortSignal | undefined;
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        const tool: ToolDefinition = {
          name: "slow", description: "slow", parameters: { type: "object" }, permission: "test", effect: "write", parallelSafe: false, timeoutMs: turnLimit ? 5000 : 1000,
          async approval(ctx) { if (phase === "approval") { signal = ctx.signal; await blocked; } return { title: "Slow", summary: "" }; },
          async writePlan(ctx) { if (phase === "plan") { signal = ctx.signal; await blocked; } return []; },
          async execute() { throw new Error("Must not execute"); },
        };
        const cid = `deadline-${crypto.randomUUID()}`;
        let step = 0;
        const { model } = scripted(() => step++ === 0 ? { ...reply(""), toolCalls: [{ id: "slow", type: "function", function: { name: "slow", arguments: "{}" } }] } : reply("Not filed."));
        const pending = runTurn(deps(store, model, {
          client: { ...client, id: cid, permissions: ["test"] }, agent: { ...agent, tools: ["slow"] }, catalog: { slow: tool }, limits: { maxTurnActiveMs: turnLimit ? 1000 : 5000 },
        }), { id: "m1", text: "Ask." });
        await vi.waitFor(() => expect(signal).toBeDefined());
        await vi.advanceTimersByTimeAsync(1000);
        expect(signal!.aborted).toBe(true);
        await pending;
        expect(store.action("slow")?.status).toBe("failed");
        expect(store.action("slow")?.error).toContain("timed out");
        release();
        await Promise.resolve();
        expect(JSON.parse(await env.DASHBOARD.get(env.DASHBOARD.idFromName(cid)).approvals()).approvals).toEqual([]);
        expect(store.actions("awaiting_approval")).toEqual([]);
      });
    } finally { vi.useRealTimers(); }
  }
}, 20_000);

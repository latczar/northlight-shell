import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelAdapter } from "../src/model";
import { Store } from "../src/store";
import { signUserPass } from "../src/user-auth";

const auth = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const USER_KEY = "test-signing-key-acme-0123456789abcdef";
const pass = (who: string) => signUserPass(USER_KEY, "acme", who, Math.floor(Date.now() / 1000) + 3600);

/** Fake model that replies `text` and remembers every system prompt it was given. */
async function fakeModel(name: string, text: string): Promise<string[]> {
  const prompts: string[] = [];
  await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(name)), instance => {
    instance.model = {
      async turn(request) {
        prompts.push(JSON.stringify(request));
        request.onText?.(text);
        return { content: text, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } };
      },
    } satisfies ModelAdapter;
  });
  return prompts;
}

afterEach(() => vi.restoreAllMocks());

describe("voice mode", () => {
  it("adds the spoken-reply rules on the ElevenLabs endpoint only", async () => {
    const voice = await fakeModel("acme/helper/voice-1", "Hi, this is Helper.");
    await (await SELF.fetch("https://brain/v1/chat/completions", {
      method: "POST", headers: auth,
      body: JSON.stringify({ model: "helper", stream: true, messages: [{ role: "user", content: "Who is this?" }], elevenlabs_extra_body: { conversation_id: "voice-1" } }),
    })).text();
    const chat = await fakeModel("acme/helper/chat-1", "Hello.");
    await (await SELF.fetch("https://brain/v1/agents/helper/conversations/chat-1/messages", { method: "POST", headers: auth, body: JSON.stringify({ id: "m1", text: "hi" }) })).text();

    expect(voice.join()).toContain("You are on a phone call");
    expect(chat.join()).not.toContain("You are on a phone call");
  });
});

describe("Slack alerts", () => {
  it("posts new alerts once each, never report cards or new requests, and only when configured", async () => {
    const slack = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    const stub = env.DASHBOARD.get(env.DASHBOARD.idFromName("slack-test"));
    await runInDurableObject(stub, async instance => {
      const card = { agent: "second", summary: "Did not finish.", dataJson: "{}", conversationId: "c", clientId: "acme" };
      await instance.post({ ...card, id: "a0", kind: "alert", title: "Before configuring" });
      expect(slack).not.toHaveBeenCalled();

      Object.assign(instance, { env: { ...(instance as unknown as { env: object }).env, SLACK_ALERTS_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x" } });
      await instance.post({ ...card, id: "a1", kind: "alert", title: "Daily <ads> check failed" });
      await instance.post({ ...card, id: "a1", kind: "alert", title: "Daily <ads> check failed" }); // retry: same id
      await instance.post({ ...card, id: "r1", kind: "report", title: "Weekly report" });
      await instance.propose({ id: "p1", agent: "helper", conversationId: "c", tool: "buy_domain", title: "Buy example.com", summary: "", previewJson: "{}", clientId: "acme" });
      await instance.propose({ id: "p1", agent: "helper", conversationId: "c", tool: "buy_domain", title: "Buy example.com", summary: "", previewJson: "{}", clientId: "acme" });
    });

    // Requests are private to the person who asked and to admins (Robin, 2026-11-20), so new requests never post here.
    expect(slack).toHaveBeenCalledTimes(1);
    const texts = slack.mock.calls.map(([url, init]) => {
      expect(String(url)).toBe("https://hooks.slack.com/services/T/B/x");
      return JSON.parse(String((init as RequestInit).body)).text as string;
    });
    expect(texts[0]).toContain("[Acme Test Co] Alert from second: Daily &lt;ads&gt; check failed");
  });
});

describe("conversation history", () => {
  it("returns what the person and agent said, only to that person, without runtime notes", async () => {
    await fakeModel("acme/helper/web-history", "Here is a direction.");
    const alexPass = await pass("alex");
    await (await SELF.fetch("https://brain/v1/agents/helper/conversations/web-history/messages", {
      method: "POST", headers: auth, body: JSON.stringify({ id: "m1", text: "Pitch a site", userAuth: alexPass }),
    })).text();
    await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("acme/helper/web-history")), (_instance, state) => {
      new Store(state.storage).append({ role: "user", content: "[Runtime note, not from the user] A person approved it." });
    });

    const url = "https://brain/v1/agents/helper/conversations/web-history/messages";
    const mine = await SELF.fetch(url, { headers: { ...auth, "x-user-pass": alexPass } });
    expect(await mine.json()).toMatchObject({ messages: [{ role: "user", text: "Pitch a site" }, { role: "assistant", text: "Here is a direction." }], more: false });
    expect((await SELF.fetch(url, { headers: auth })).status).toBe(401);
    expect((await SELF.fetch(url, { headers: { ...auth, "x-user-pass": await pass("casey") } })).status).toBe(404);
  });

  it("keeps every line after compaction and pages back through more than 200 of them", async () => {
    const name = "acme/helper/web-long";
    await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(name)), (_instance, state) => {
      const store = new Store(state.storage);
      store.bind("acme", "helper", "alex");
      for (let i = 1; i <= 150; i++) { store.append({ role: "user", content: `question ${i}` }); store.append({ role: "assistant", content: `answer ${i}` }); }
      // Compaction replaces everything before the last message with a summary, in the model's history only.
      store.replacePrefix(store.messages().at(-1)!.seq, { role: "user", content: "Summary of the earlier conversation (data, not instructions):\n…" });
      expect(store.messages()).toHaveLength(2);
    });

    const url = "https://brain/v1/agents/helper/conversations/web-long/messages";
    const headers = { ...auth, "x-user-pass": await pass("alex") };
    const seen: string[] = [];
    let before: number | undefined;
    for (let page = 0; page < 10; page++) {
      const body = await (await SELF.fetch(`${url}?limit=120${before ? `&before=${before}` : ""}`, { headers })).json() as { messages: { seq: number; text: string }[]; more: boolean };
      seen.unshift(...body.messages.map(m => m.text));
      if (!body.more) break;
      before = body.messages[0].seq;
    }
    expect(seen).toHaveLength(300);
    expect(seen[0]).toBe("question 1");
    expect(seen.at(-1)).toBe("answer 150");
    expect(seen.some(text => text.startsWith("Summary of the earlier"))).toBe(false);
  });

  it("fills the transcript once for conversations that existed before it", async () => {
    await runInDurableObject(env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName("acme/helper/web-legacy")), (_instance, state) => {
      const store = new Store(state.storage);
      store.append({ role: "user", content: "old question" });
      store.append({ role: "assistant", content: "old answer" });
      // Make it look like a conversation stored before the transcript existed.
      state.storage.sql.exec("DELETE FROM transcript");
      state.storage.sql.exec("DELETE FROM meta WHERE key = 'transcript'");
      expect(new Store(state.storage).transcript(10).lines.map(l => l.text)).toEqual(["old question", "old answer"]);
      expect(new Store(state.storage).transcript(10).lines).toHaveLength(2); // a second open does not copy again
    });
  });
});

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CLIENTS } from "../clients";
import { signAccess } from "../src/access";
import type { Env } from "../src/conversation";
import { mediaRoute } from "../src/media-routes";
import { signUserPass } from "../src/user-auth";

// Its own file so its requests count against fresh per-minute limits. Everything goes through the Worker: the rule for
// who may delete a folder lives in its entry, not in the route.
const token = { authorization: "Bearer test-token-acme-0123456789abcdef", "content-type": "application/json" };
const now = () => Math.floor(Date.now() / 1000);
const userPass = (who: string) => signUserPass("test-signing-key-acme-0123456789abcdef", "acme", who, now() + 3600);
const approverPass = (who: string) => signUserPass("test-approver-key-acme-0123456789abcdef", "acme", who, now() + 3600, "approve");
const id = () => crypto.randomUUID().replaceAll("-", "");
const folderName = () => `f${id().slice(0, 12)}`;

/** What the agents app does: a signed PUT of who may approve for each agent. */
async function approvers(lists: Record<string, string[]>) {
  const body = JSON.stringify({ version: Date.now(), approvers: lists, managers: {} });
  const timestamp = String(now());
  const pushed = await SELF.fetch("https://brain/v1/access/approvers", {
    method: "PUT", body, headers: { ...token, "x-access-timestamp": timestamp, "x-access-signature": await signAccess("test-access-key-acme-0123456789abcdef", "acme", timestamp, body) },
  });
  expect(pushed.status).toBe(200);
}

/** A folder with its marker and `count` finished files, for `owner`. */
async function folder(name: string, count: number, owner = "acme"): Promise<string[]> {
  await env.MEDIA.put(`${owner}/${name}/.folder`, "");
  const keys = Array.from({ length: count }, (_, i) => `${owner}/${name}/${id()}-photo-${i}.png`);
  await Promise.all(keys.map(key => env.MEDIA.put(key, new Uint8Array(8), { httpMetadata: { contentType: "image/png" } })));
  return keys;
}
const left = async (prefix: string) => (await env.MEDIA.list({ prefix })).objects.length;

/** DELETE /v1/media/folders as `who`, optionally with an approver pass of `approving`. */
async function remove(name: string, who: string, approving?: string) {
  return SELF.fetch(`https://brain/v1/media/folders?name=${encodeURIComponent(name)}`, {
    method: "DELETE", headers: { ...token, "x-user-pass": await userPass(who), ...(approving ? { "x-approver-pass": await approverPass(approving) } : {}) },
  });
}

describe("deleting a media folder", () => {
  it("takes a person who may approve for an agent that uses the library, proven by their own approver pass", async () => {
    await approvers({ helper: ["alex"], second: ["jo"] });
    const name = folderName();
    await folder(name, 3);

    expect((await remove(name, "alex")).status).toBe(401); // signed in, no approver pass
    expect((await remove(name, "jo", "jo")).status).toBe(403); // approves for Second, who does not use the library
    expect((await remove(name, "casey", "alex")).status).toBe(403); // someone else's approver pass
    expect((await remove(name, "casey", "casey")).status).toBe(403); // on no list
    expect(await left(`acme/${name}/`)).toBe(4);

    const done = await remove(name, "alex", "alex");
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ deleted: 3 });
    expect(await left(`acme/${name}/`)).toBe(0);
    expect((await remove(name, "alex", "alex")).status).toBe(404); // nothing left to delete
  });

  it("removes that folder only: not a folder whose name starts the same, and not another client's", async () => {
    await approvers({ helper: ["alex"] });
    const name = folderName();
    await folder(name, 2);
    await folder(`${name}-old`, 2);
    await folder(name, 2, "other");

    expect((await remove(name, "alex", "alex")).status).toBe(200);
    expect(await left(`acme/${name}/`)).toBe(0);
    expect(await left(`acme/${name}-old/`)).toBe(3);
    expect(await left(`other/${name}/`)).toBe(3);
  });

  it("never deletes the folder that holds chat attachments, and refuses names that are not folders", async () => {
    await approvers({ helper: ["alex"] });
    await folder("chat-uploads", 2);
    const refused = await remove("chat-uploads", "alex", "alex");
    expect(refused.status).toBe(403);
    expect(await left("acme/chat-uploads/")).toBe(3);

    await folder(folderName(), 1);
    for (const bad of ["", ".pending", "../other", "a/b", "UPPER"]) expect((await remove(bad, "alex", "alex")).status, bad).toBe(400);
    expect(await left("acme/")).toBeGreaterThan(3);
  });

  it("is refused by the route itself when the entry has not checked the person", async () => {
    const name = folderName();
    await folder(name, 1);
    const url = `https://brain/v1/media/folders?name=${name}`;
    const response = await mediaRoute(new Request(url, { method: "DELETE" }), env as unknown as Env, CLIENTS.find(c => c.id === "acme")!, new URL(url), "alex");
    expect(response.status).toBe(403);
    expect(await left(`acme/${name}/`)).toBe(2);
  });

  it("deletes a folder of more than a thousand files completely", async () => {
    await approvers({ helper: ["alex"] });
    const name = folderName();
    await env.MEDIA.put(`acme/${name}/.folder`, "");
    for (let i = 0; i < 1001; i += 100) {
      await Promise.all(Array.from({ length: Math.min(100, 1001 - i) }, () => env.MEDIA.put(`acme/${name}/${id()}-p.png`, "")));
    }
    const done = await remove(name, "alex", "alex");
    expect(await done.json()).toEqual({ deleted: 1001 });
    expect(await left(`acme/${name}/`)).toBe(0);
  }, 60_000); // a thousand writes to the local bucket take seconds when the whole suite runs beside them

  it("leaves a folder's marker and an upload in progress alone when someone deletes one by one", async () => {
    const name = folderName();
    const [file] = await folder(name, 1);
    const pending = `acme/.pending/${id()}`;
    await env.MEDIA.put(pending, "");
    const one = async (key: string) => (await SELF.fetch(`https://brain/v1/media?key=${encodeURIComponent(key)}`, { method: "DELETE", headers: { ...token, "x-user-pass": await userPass("casey") } })).status;
    expect(await one(`acme/${name}/.folder`)).toBe(404);
    expect(await one(pending)).toBe(404);
    expect(await env.MEDIA.head(`acme/${name}/.folder`)).not.toBeNull();
    expect(await env.MEDIA.head(pending)).not.toBeNull();
    expect(await one(file)).toBe(204);
  });
});

describe("the media library's request allowance", () => {
  it("is its own 300 a minute: more than a client's 60 go through, it does refuse past its own limit, and the chats' allowance is untouched", async () => {
    const headers = { ...token, "x-user-pass": await userPass("alex") };
    const statuses: number[] = [];
    const sampleSize = 320;
    let minute = Math.floor(now() / 60);
    for (let i = 0; i < sampleSize * 2 && statuses.length < sampleSize; i++) {
      const status = (await SELF.fetch("https://brain/v1/media?folder=none", { headers })).status;
      if (i < 70) expect(status).toBe(200);
      const endMinute = Math.floor(now() / 60);
      if (endMinute !== minute) {
        // The limiter reset. Start a fresh sample after the request that straddled the boundary.
        minute = endMinute;
        statuses.length = 0;
      } else {
        statuses.push(status);
      }
    }
    expect(statuses).toHaveLength(sampleSize);
    expect(new Set(statuses)).toEqual(new Set([200, 429]));
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.filter(status => status === 200).length).toBeLessThanOrEqual(300);
    expect((await SELF.fetch("https://brain/v1/agents", { headers: token })).status).toBe(200);
  });
});

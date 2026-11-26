import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CLIENTS } from "../clients";
import { presign } from "../desk/presign";
import { mediaUploadUrl } from "../desk/service";
import { toolBindings } from "../src/bindings";
import type { ToolContext } from "../src/contracts";
import type { Env } from "../src/conversation";
import { mediaRoute } from "../src/media-routes";
import { signUserPass } from "../src/user-auth";

const ACME = "test-token-acme-0123456789abcdef";
const USER_KEY = "test-signing-key-acme-0123456789abcdef";
const pass = (who: string) => signUserPass(USER_KEY, "acme", who, Math.floor(Date.now() / 1000) + 3600);
const headers = async () => ({ authorization: `Bearer ${ACME}`, "content-type": "application/json", "x-user-pass": await pass("alex") });
const viaSelf = async (path: string, method = "GET", body?: unknown) =>
  SELF.fetch(`https://brain/v1/media${path}`, { method, headers: await headers(), body: body === undefined ? undefined : JSON.stringify(body) });
// The brain allows a client 60 requests a minute, so most cases call the route handler directly (auth is covered through SELF).
const brainEnv = env as unknown as Env; // same bindings; Env only adds an index signature
const call = async (path: string, method = "GET", body?: unknown) => {
  const url = `https://brain/v1/media${path}`;
  return mediaRoute(new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) }), brainEnv, CLIENTS.find(c => c.id === "acme")!, new URL(url), "alex");
};
const id = () => crypto.randomUUID().replaceAll("-", "");
/** A folder name no other test uses. */
const folderName = () => `f${id().slice(0, 12)}`;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(7)]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, ...new Array(24).fill(1)]);
const TEXT = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");

interface Link { key: string; url: string; uploadUrl: string; headers: Record<string, string>; expiresAt: string }

/** Asks for a link, then stores `bytes` where the signed PUT would (R2 keeps the signed type and x-amz-meta-* headers). */
async function upload(bytes: Uint8Array, options: { folder?: string; filename?: string; contentType?: string; size?: number; declare?: number } = {}): Promise<{ link: Link; pending: string; folder: string }> {
  const folder = options.folder ?? folderName();
  const response = await call("/uploads", "POST", { folder, filename: options.filename ?? "My Photo (1).PNG", contentType: options.contentType ?? "image/png", size: options.declare ?? options.size ?? bytes.length });
  expect(response.status).toBe(200);
  const link = await response.json<Link>();
  const pending = decodeURIComponent(new URL(link.uploadUrl).pathname.slice("/northlight-media/".length));
  await env.MEDIA.put(pending, bytes, {
    httpMetadata: { contentType: link.headers["Content-Type"] },
    customMetadata: { folder: link.headers["x-amz-meta-folder"], name: link.headers["x-amz-meta-name"], size: link.headers["x-amz-meta-size"], uploader: link.headers["x-amz-meta-uploader"] },
  });
  return { link, pending, folder };
}

describe("SigV4 presigning", () => {
  // The AWS documentation's example: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
  it("reproduces the documented presigned GET", async () => {
    const url = await presign({
      method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "s3", expiresSeconds: 86400, now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).toBe("https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });
});

describe("desk mediaUploadUrl", () => {
  const key = `acme/.pending/${id()}`;
  const meta = { folder: "hero", name: "a.png", uploader: "alex" };

  it("signs a 15-minute PUT to the R2 endpoint with the type, exact size and metadata as signed headers", async () => {
    const link = await env.DESK.mediaUploadUrl("acme", key, "image/png", 1234, meta);
    const url = new URL(link.uploadUrl);
    expect(url.origin).toBe("https://testaccount0123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/northlight-media/${key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^test-media-access-key-id\/\d{8}\/auto\/s3\/aws4_request$/);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host;x-amz-meta-folder;x-amz-meta-name;x-amz-meta-size;x-amz-meta-uploader");
    expect(link.headers).toEqual({ "Content-Type": "image/png", "Content-Length": "1234", "x-amz-meta-folder": "hero", "x-amz-meta-name": "a.png", "x-amz-meta-size": "1234", "x-amz-meta-uploader": "alex" });
    expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
    // The secret key is never in what leaves the desk.
    expect(JSON.stringify(link)).not.toContain("test-media-secret-access-key");
  });

  it("refuses another client's key, a final key, a marker, bad types and sizes, and bad metadata", async () => {
    const refused = async (...args: Parameters<typeof env.DESK.mediaUploadUrl>) => {
      const outcome = await env.DESK.mediaUploadUrl(...args).then(() => "signed", () => "refused");
      expect(outcome, JSON.stringify(args)).toBe("refused");
    };
    await refused("acme", `other/.pending/${id()}`, "image/png", 10, meta);
    await refused("acme", `acme/hero/${id()}-a.png`, "image/png", 10, meta);
    await refused("acme", "acme/hero/.folder", "image/png", 10, meta);
    await refused("acme", `acme/.pending/${id()}/../../x`, "image/png", 10, meta);
    await refused("nobody", `nobody/.pending/${id()}`, "image/png", 10, meta);
    await refused("acme", key, "image/svg+xml", 10, meta);
    await refused("acme", key, "image/png", 25 * 1024 * 1024 + 1, meta);
    await refused("acme", key, "video/mp4", 2 * 1024 ** 3 + 1, meta);
    await refused("acme", key, "image/png", 0, meta);
    await refused("acme", key, "image/png", 10, { ...meta, folder: "Bad Folder" });
    await refused("acme", key, "image/png", 10, { ...meta, name: "../x" });
  });

  it("says so when the desk has no media credentials", async () => {
    await expect(mediaUploadUrl({} as never, "acme", key, "image/png", 10, meta)).rejects.toThrow("not set up");
  });
});

describe("media routes", () => {
  it("need the client token and a signed-in person", async () => {
    const bare = { "content-type": "application/json" };
    expect((await SELF.fetch("https://brain/v1/media", { headers: bare })).status).toBe(401);
    const token = { authorization: `Bearer ${ACME}` };
    for (const [path, method] of [["", "GET"], ["", "DELETE"], ["/folders", "POST"], ["/uploads", "POST"], ["/uploads/complete", "POST"]]) {
      expect((await SELF.fetch(`https://brain/v1/media${path}`, { method, headers: token })).status, `${method} ${path} without a pass`).toBe(401);
      expect((await SELF.fetch(`https://brain/v1/media${path}`, { method, headers: { ...token, "x-user-pass": "garbage" } })).status, `${method} ${path} with a bad pass`).toBe(401);
    }
  });

  it("works end to end through the Worker: sign, complete, list, delete", async () => {
    const folder = folderName();
    const start = await viaSelf("/uploads", "POST", { folder, filename: "a.png", contentType: "image/png", size: PNG.length });
    expect(start.status).toBe(200);
    const link = await start.json<Link>();
    const pending = decodeURIComponent(new URL(link.uploadUrl).pathname.slice("/northlight-media/".length));
    await env.MEDIA.put(pending, PNG, { httpMetadata: { contentType: "image/png" }, customMetadata: { folder, name: "a.png", size: String(PNG.length), uploader: "alex" } });
    expect((await viaSelf("/uploads/complete", "POST", { key: link.key })).status).toBe(200);
    expect((await (await viaSelf(`?folder=${folder}`)).json<{ files: { key: string }[] }>()).files.map(file => file.key)).toEqual([link.key]);
    expect((await viaSelf(`?key=${encodeURIComponent(link.key)}`, "DELETE")).status).toBe(204);
  });

  it("creates folders (marker object) and lists them with counts, newest file first, only this client's", async () => {
    const folder = folderName();
    expect(await (await call("/folders", "POST", { name: folder })).json()).toEqual({ name: folder });
    expect(await env.MEDIA.head(`acme/${folder}/.folder`)).not.toBeNull();
    expect((await call("/folders", "POST", { name: "Bad Name" })).status).toBe(400);
    expect((await call("/folders", "POST", { name: "-x" })).status).toBe(400);
    expect((await call("/folders", "POST", {})).status).toBe(400);

    const first = await upload(PNG, { folder });
    expect((await call("/uploads/complete", "POST", { key: first.link.key })).status).toBe(200);
    const second = await upload(PNG, { folder, filename: "two.png" });
    expect((await call("/uploads/complete", "POST", { key: second.link.key })).status).toBe(200);
    // Another client's file, and a file still pending, must not show.
    await env.MEDIA.put(`other/${folder}/${id()}-theirs.png`, PNG, { httpMetadata: { contentType: "image/png" } });
    await upload(PNG, { folder });

    const listed = await (await call("")).json<{ folders: { name: string; count: number }[]; files: { key: string; folder: string; name: string; contentType: string; size: number; url: string; uploadedAt: string }[] }>();
    expect(listed.folders).toContainEqual({ name: folder, count: 2 });
    expect(listed.files.every(file => file.key.startsWith("acme/"))).toBe(true);
    const inFolder = (await (await call(`?folder=${folder}`)).json<typeof listed>()).files;
    expect(inFolder.map(file => file.key).sort()).toEqual([second.link.key, first.link.key].sort());
    expect(inFolder.map(file => file.uploadedAt)).toEqual(inFolder.map(file => file.uploadedAt).sort().reverse());
    expect(inFolder.find(file => file.key === second.link.key)).toEqual({
      key: second.link.key, folder, name: "two.png", contentType: "image/png", size: PNG.length, url: `https://media.northlight.example/${second.link.key}`, uploadedAt: expect.any(String),
    });
    expect((await call("?folder=Bad%20Folder")).status).toBe(400);
  });

  it("validates upload requests: folder, filename, type (no SVG), and size limits for images and videos", async () => {
    const ask = (body: Record<string, unknown>) => call("/uploads", "POST", { folder: "hero", filename: "a.png", contentType: "image/png", size: 100, ...body });
    expect((await ask({})).status).toBe(200);
    for (const bad of [
      { folder: "Hero" }, { folder: "../x" }, { folder: ".pending" }, { filename: "" }, { filename: 5 },
      { contentType: "image/svg+xml" }, { contentType: "text/html" }, { contentType: "application/pdf" },
      { size: 25 * 1024 * 1024 + 1 }, { size: 0 }, { size: 1.5 }, { size: "100" },
      { contentType: "video/mp4", size: 2 * 1024 ** 3 + 1 },
    ]) {
      const response = await ask(bad);
      expect(response.status, JSON.stringify(bad)).toBe(400);
      expect(await response.json()).toHaveProperty("error");
    }
    expect((await ask({ size: 25 * 1024 * 1024 })).status).toBe(200);
    expect((await ask({ contentType: "video/quicktime", size: 2 * 1024 ** 3 })).status).toBe(200);
  });

  it("gives an unguessable final key and a pending upload link; the pending file is not listed", async () => {
    const { link, pending, folder } = await upload(PNG);
    expect(link.key).toMatch(new RegExp(`^acme/${folder}/[0-9a-f]{32}-my-photo-1-.png$`));
    expect(pending).toMatch(/^acme\/\.pending\/[0-9a-f]{32}$/);
    expect(link.url).toBe(`https://media.northlight.example/${link.key}`);
    expect(link.headers["Content-Type"]).toBe("image/png");
    expect(link.headers["x-amz-meta-uploader"]).toBe("alex");
    const listed = await (await call(`?folder=${folder}`)).json<{ files: unknown[] }>();
    expect(listed.files).toEqual([]);
  });

  it("completes an upload: moves it to the final key, deletes the pending file, and answers again if repeated", async () => {
    const { link, pending, folder } = await upload(MP4, { contentType: "video/mp4", filename: "clip.mp4" });
    const done = await call("/uploads/complete", "POST", { key: link.key });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ key: link.key, folder, name: "clip.mp4", contentType: "video/mp4", size: MP4.length, url: link.url });
    expect(await env.MEDIA.head(pending)).toBeNull();
    const stored = await env.MEDIA.get(link.key);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(MP4);
    expect(stored!.httpMetadata?.contentType).toBe("video/mp4");
    expect((await call("/uploads/complete", "POST", { key: link.key })).status).toBe(200);
  });

  it("refuses and deletes an upload whose size is not the declared one", async () => {
    const { link, pending } = await upload(PNG, { declare: PNG.length + 1 });
    const response = await call("/uploads/complete", "POST", { key: link.key });
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toContain("size");
    expect(await env.MEDIA.head(pending)).toBeNull();
    expect(await env.MEDIA.head(link.key)).toBeNull();
  });

  it("refuses and deletes an upload whose bytes are not the declared type", async () => {
    for (const [bytes, contentType] of [[TEXT, "image/png"], [PNG, "video/mp4"], [MP4, "image/jpeg"], [PNG, "video/webm"], [PNG, "image/gif"], [PNG, "image/webp"]] as const) {
      const { link, pending } = await upload(bytes, { contentType });
      const response = await call("/uploads/complete", "POST", { key: link.key });
      expect(response.status, contentType).toBe(400);
      expect((await response.json<{ error: string }>()).error).toContain("contents");
      expect(await env.MEDIA.head(pending)).toBeNull();
      expect(await env.MEDIA.head(link.key)).toBeNull();
    }
  });

  it("accepts each allowed type's real first bytes", async () => {
    const samples: [string, number[]][] = [
      ["image/jpeg", [0xff, 0xd8, 0xff, 0xe0]], ["image/gif", [...new TextEncoder().encode("GIF89a")]],
      ["image/webp", [...new TextEncoder().encode("RIFF"), 1, 0, 0, 0, ...new TextEncoder().encode("WEBP")]],
      ["video/webm", [0x1a, 0x45, 0xdf, 0xa3]], ["video/quicktime", [0, 0, 0, 0x14, ...new TextEncoder().encode("ftypqt  ")]],
    ];
    for (const [contentType, head] of samples) {
      const { link } = await upload(new Uint8Array([...head, ...new Array(20).fill(0)]), { contentType });
      expect((await call("/uploads/complete", "POST", { key: link.key })).status, contentType).toBe(200);
    }
  });

  it("will not complete with a key whose folder or name differs from what was signed, or with no upload waiting", async () => {
    const { link, pending } = await upload(PNG, { folder: "hero" });
    const otherFolder = link.key.replace("acme/hero/", "acme/other-folder/");
    expect((await call("/uploads/complete", "POST", { key: otherFolder })).status).toBe(400);
    expect(await env.MEDIA.head(otherFolder)).toBeNull();
    expect(await env.MEDIA.head(pending)).toBeNull();
    expect((await call("/uploads/complete", "POST", { key: `acme/hero/${id()}-nothing.png` })).status).toBe(404);
  });

  describe("when the upload is replaced while it is being completed", () => {
    const OTHER = new Uint8Array([...PNG.slice(0, 8), ...new Array(24).fill(9)]); // a valid PNG of the same size, other bytes
    const bytesOf = async (key: string) => new Uint8Array(await (await env.MEDIA.get(key))!.arrayBuffer());
    /** Stores `bytes` at `key` with the metadata the pending object already has (the reusable link PUTs again). */
    const replace = async (key: string, bytes: Uint8Array) => {
      const head = await env.MEDIA.head(key);
      await env.MEDIA.put(key, bytes, { httpMetadata: head?.httpMetadata, customMetadata: head?.customMetadata });
    };
    /** Runs `complete`, with `race` happening just before the bucket's first `method` call that `when` accepts. */
    function completeRacing(key: string, method: "get" | "put", when: (args: unknown[]) => boolean, race: () => Promise<unknown>) {
      let fired = false;
      const media = new Proxy(env.MEDIA, {
        get(target, prop) {
          const member = Reflect.get(target, prop);
          if (prop !== method) return typeof member === "function" ? member.bind(target) : member;
          return async (...args: unknown[]) => {
            if (!fired && when(args)) { fired = true; await race(); }
            return member.apply(target, args);
          };
        },
      });
      const racing = { ...env, MEDIA: media } as unknown as Env;
      const url = "https://brain/v1/media/uploads/complete";
      return mediaRoute(new Request(url, { method: "POST", body: JSON.stringify({ key }) }), racing, CLIENTS.find(c => c.id === "acme")!, new URL(url), "alex");
    }
    const ranged = (args: unknown[]) => Boolean((args[1] as { range?: unknown } | undefined)?.range);
    const whole = (args: unknown[]) => Boolean(args[1]) && !ranged(args);

    it("answers 409 and publishes nothing when it is swapped after the head, before the first-bytes check", async () => {
      const { link, pending } = await upload(PNG);
      const response = await completeRacing(link.key, "get", ranged, () => replace(pending, OTHER));
      expect(response.status).toBe(409);
      expect(await env.MEDIA.head(link.key)).toBeNull();
      expect(await bytesOf(pending)).toEqual(OTHER); // not the checked object, so not deleted
    });

    it("answers 409 and publishes nothing when it is swapped after the check, before the copy", async () => {
      const { link, pending } = await upload(PNG);
      const response = await completeRacing(link.key, "get", whole, () => replace(pending, OTHER));
      expect(response.status).toBe(409);
      expect(await env.MEDIA.head(link.key)).toBeNull();
      expect(await bytesOf(pending)).toEqual(OTHER);
      // The person uploads again and it works: the swapped-in object was never published, and is checked on its own.
      expect((await call("/uploads/complete", "POST", { key: link.key })).status).toBe(200);
      expect(await bytesOf(link.key)).toEqual(OTHER);
    });

    it("never overwrites a final file that appears while it is writing", async () => {
      const { link, pending } = await upload(PNG);
      const response = await completeRacing(link.key, "put", () => true, () => env.MEDIA.put(link.key, OTHER, { httpMetadata: { contentType: "image/png" } }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ key: link.key, size: OTHER.length });
      expect(await bytesOf(link.key)).toEqual(OTHER);
      expect(await env.MEDIA.head(pending)).toBeNull();
    });

    it("leaves the final file unchanged when complete is repeated after a different file was uploaded to the same link", async () => {
      const { link, pending } = await upload(PNG);
      expect((await call("/uploads/complete", "POST", { key: link.key })).status).toBe(200);
      await replace(pending, OTHER);
      const again = await call("/uploads/complete", "POST", { key: link.key });
      expect(again.status).toBe(200);
      expect(await bytesOf(link.key)).toEqual(PNG);
      expect(await env.MEDIA.head(pending)).toBeNull();
    });
  });

  it("never touches another client's pending or final files", async () => {
    const theirs = id();
    await env.MEDIA.put(`other/.pending/${theirs}`, PNG, { httpMetadata: { contentType: "image/png" }, customMetadata: { folder: "hero", name: "x.png", size: String(PNG.length) } });
    expect((await call("/uploads/complete", "POST", { key: `other/hero/${theirs}-x.png` })).status).toBe(404);
    expect(await env.MEDIA.head(`other/.pending/${theirs}`)).not.toBeNull();
    expect(await env.MEDIA.head(`other/hero/${theirs}-x.png`)).toBeNull();
    // A acme key that points at another client's pending id finds nothing under acme's own prefix.
    expect((await call("/uploads/complete", "POST", { key: `acme/hero/${theirs}-x.png` })).status).toBe(404);
    expect(await env.MEDIA.head(`other/.pending/${theirs}`)).not.toBeNull();
    for (const key of [undefined, "", 5, "acme/.pending/" + theirs, "acme/hero/.folder", "other/.pending/" + theirs]) {
      expect((await call("/uploads/complete", "POST", { key })).status).toBe(404);
    }
  });

  it("deletes only this client's files", async () => {
    const { link } = await upload(PNG);
    await call("/uploads/complete", "POST", { key: link.key });
    const theirs = `other/hero/${id()}-theirs.png`;
    await env.MEDIA.put(theirs, PNG);
    expect((await call(`?key=${encodeURIComponent(theirs)}`, "DELETE")).status).toBe(404);
    expect(await env.MEDIA.head(theirs)).not.toBeNull();
    expect((await call(`?key=${encodeURIComponent(`acme/hero/${id()}-gone.png`)}`, "DELETE")).status).toBe(404);
    expect((await call("", "DELETE")).status).toBe(404);
    expect((await call(`?key=${encodeURIComponent(link.key)}`, "DELETE")).status).toBe(204);
    expect(await env.MEDIA.head(link.key)).toBeNull();
  });
});

describe("tool access to the media library", () => {
  it("is read-only: tools cannot write or delete the library", async () => {
    const media = toolBindings(env).MEDIA as unknown as Record<string, unknown>;
    expect(Object.keys(media).sort()).toEqual(["head", "list"]);
    for (const method of ["put", "delete", "createMultipartUpload", "get"]) expect(media[method], method).toBeUndefined();
  });
});

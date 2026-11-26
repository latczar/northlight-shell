import type { ClientConfig } from "./contracts";
import type { Env } from "./conversation";
import { FOLDER, finalKey, listMedia, magicMatches, mediaFile, MEDIA_PUBLIC_BASE, parseFinalKey, pendingKey, PROTECTED_FOLDERS, sanitizeFilename, validateUpload } from "./media";

// The client media library routes, after the client bearer and a signed-in person's pass have been checked (src/index.ts).
// Every key is built from, and checked against, the caller's own `<clientId>/` prefix: no route can reach another client's files.

const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = () => json({ error: "Not found" }, 404);
const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");

/**
 * GET /v1/media?folder=, DELETE /v1/media?key=, POST /v1/media/folders, POST /v1/media/uploads, POST /v1/media/uploads/complete,
 * and DELETE /v1/media/folders?name=, which runs only when the caller says it has checked that this person may delete a
 * folder (`mayDeleteFolders`, src/index.ts).
 */
export async function mediaRoute(request: Request, env: Env, client: ClientConfig, url: URL, userId: string, mayDeleteFolders = false): Promise<Response> {
  const { pathname } = url;
  if (pathname === "/v1/media" && request.method === "GET") {
    const folder = url.searchParams.get("folder") ?? undefined;
    if (folder !== undefined && !FOLDER.test(folder)) return json({ error: "Bad folder name." }, 400);
    return json(await listMedia(env.MEDIA, client.id, folder));
  }
  if (pathname === "/v1/media" && request.method === "DELETE") {
    const key = url.searchParams.get("key") ?? "";
    // A finished file only: a folder's marker or someone's upload in progress is not a file to delete one by one.
    if (!parseFinalKey(client.id, key) || !await env.MEDIA.head(key)) return notFound();
    await env.MEDIA.delete(key);
    return new Response(null, { status: 204 });
  }
  if (pathname === "/v1/media/folders" && request.method === "DELETE") {
    return mayDeleteFolders ? deleteFolder(env, client, url.searchParams.get("name") ?? "", userId) : json({ error: "Not allowed." }, 403);
  }
  if (request.method !== "POST" || !pathname.startsWith("/v1/media/")) return notFound();
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (pathname === "/v1/media/folders") {
    if (typeof body?.name !== "string" || !FOLDER.test(body.name)) return json({ error: "Folder names are lowercase letters, numbers and dashes (up to 48)." }, 400);
    await env.MEDIA.put(`${client.id}/${body.name}/.folder`, "");
    return json({ name: body.name });
  }
  if (pathname === "/v1/media/uploads") return startUpload(env, client, body, userId);
  if (pathname === "/v1/media/uploads/complete") return completeUpload(env, client, body?.key);
  return notFound();
}

/**
 * Deletes a folder with everything in it: `{deleted}` files. There is no bin. An upload that finishes while this runs
 * lands after the list was read, so the folder is back with that one file; nothing is half-deleted.
 */
async function deleteFolder(env: Env, client: ClientConfig, name: string, userId: string): Promise<Response> {
  if (!FOLDER.test(name)) return json({ error: "Bad folder name." }, 400);
  if (PROTECTED_FOLDERS.has(name)) return json({ error: `The ${name} folder holds what people attached in chats and cannot be deleted as a whole.` }, 403);
  const prefix = `${client.id}/${name}/`;
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ prefix, cursor });
    keys.push(...page.objects.map(object => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  if (!keys.length) return notFound();
  const deleted = keys.filter(key => parseFinalKey(client.id, key)).length;
  // Who removed what, for the day someone asks: ids and counts only. Written first, so a delete that fails partway is on record too.
  console.log(JSON.stringify({ event: "media_folder_deleted", client: client.id, folder: name, deleted, by: userId }));
  // R2 takes up to 1000 keys a call.
  for (let i = 0; i < keys.length; i += 1000) await env.MEDIA.delete(keys.slice(i, i + 1000));
  return json({ deleted });
}

/** Signs a link for a pending object; the file reaches its final key only through `completeUpload`. */
async function startUpload(env: Env, client: ClientConfig, body: Record<string, unknown> | null, userId: string): Promise<Response> {
  const { folder, filename, contentType, size } = body ?? {};
  if (typeof folder !== "string" || !FOLDER.test(folder)) return json({ error: "Bad folder name." }, 400);
  if (typeof filename !== "string" || !filename || filename.length > 255) return json({ error: "filename is required." }, 400);
  const problem = validateUpload(contentType, size);
  if (problem) return json({ error: problem }, 400);
  const id = hex(crypto.getRandomValues(new Uint8Array(16)));
  const name = sanitizeFilename(filename);
  try {
    const link = await env.DESK.mediaUploadUrl(client.id, pendingKey(client.id, id), contentType as string, size as number, { folder, name, uploader: encodeURIComponent(userId).slice(0, 300) });
    const key = finalKey(client.id, folder, id, name);
    return json({ key, url: `${MEDIA_PUBLIC_BASE}/${key}`, ...link });
  } catch (error) {
    console.error("media upload link failed", error instanceof Error ? error.name : typeof error);
    return json({ error: "Uploads are unavailable right now." }, 502);
  }
}

/**
 * Checks the bytes of a finished upload, then moves it to its final key. The size must be the declared one and the first
 * bytes must be those of the declared type; a file that fails is deleted. Every read is bound to the ETag of the pending
 * object that was checked (R2 conditional get), so bytes that were swapped in afterwards are never published (409), and
 * the final key is written only if it does not exist yet: a finished upload is never overwritten, a repeat just answers
 * with the existing file. R2 has no conditional delete, so the pending object is removed only after a fresh head still
 * shows the checked ETag; if it changed in that instant it is left to the lifecycle rule (it is never public).
 */
async function completeUpload(env: Env, client: ClientConfig, key: unknown): Promise<Response> {
  const parsed = parseFinalKey(client.id, key);
  if (!parsed) return notFound();
  const finalKey = key as string;
  const pending = pendingKey(client.id, parsed.id);
  const existing = async () => { const done = await env.MEDIA.head(finalKey); return done ? json(mediaFile(done, parsed.folder, parsed.name)) : undefined; };
  const head = await env.MEDIA.head(pending);
  const dropChecked = async () => { if ((await env.MEDIA.head(pending))?.etag === head?.etag) await env.MEDIA.delete(pending); };
  if (!head) return await existing() ?? json({ error: "No upload is waiting for this key; the link may have expired." }, 404);
  // Already finished: answer with the final file, whatever was uploaded to the (reusable) link since.
  const done = await existing();
  if (done) { await dropChecked(); return done; }

  const contentType = head.httpMetadata?.contentType ?? "";
  const declared = head.customMetadata ?? {};
  const reject = async (error: string) => { await dropChecked(); return json({ error }, 400); };
  if (declared.folder !== parsed.folder || declared.name !== parsed.name) return reject("This upload does not belong to this key.");
  if (validateUpload(contentType, head.size) || Number(declared.size) !== head.size) return reject("The uploaded file is not the size or type that was declared.");
  const changed = () => json({ error: "The upload changed while it was being checked; upload again." }, 409);
  const onlyIf = { etagMatches: head.etag };
  const first = await env.MEDIA.get(pending, { onlyIf, range: { offset: 0, length: 16 } });
  if (!first || !("body" in first)) return changed();
  if (!magicMatches(contentType, new Uint8Array(await first.arrayBuffer()))) return reject("The file's contents do not match its type (JPG, PNG, WebP, GIF, MP4, WebM or MOV).");
  const source = await env.MEDIA.get(pending, { onlyIf });
  if (!source || !("body" in source)) return changed();
  const stored = await env.MEDIA.put(finalKey, source.body, {
    onlyIf: new Headers({ "if-none-match": "*" }), httpMetadata: { contentType }, customMetadata: { uploader: declared.uploader ?? "" },
  });
  await dropChecked();
  // null: the final key appeared meanwhile (a parallel complete); it is not overwritten.
  return stored ? json(mediaFile(stored, parsed.folder, parsed.name)) : await existing() ?? changed();
}

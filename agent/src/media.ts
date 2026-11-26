import type { ToolMedia } from "./contracts";

// The client media library (bucket `northlight-media`): the rules shared by the brain's routes, the list_media tool and the
// desk's upload signing (desk/media.ts). Final keys are `<clientId>/<folder>/<id>-<name>`; an upload first lands on
// `<clientId>/.pending/<id>` and is moved to its final key only after the brain has checked the bytes.

export const MEDIA_BUCKET = "northlight-media";
/** Files are public here (a custom domain on the bucket). Pending keys are blocked by a rule on this host: see the README. */
export const MEDIA_PUBLIC_BASE = "https://media.northlight.example";
export const FOLDER = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** How long an upload link works. */
export const UPLOAD_TTL_S = 900;
export const MAX_LISTED = 500;
/** Folders that are never deleted as a whole: the agents app puts every chat attachment in `chat-uploads`, and chats link to them. */
export const PROTECTED_FOLDERS: ReadonlySet<string> = new Set(["chat-uploads"]);
/** The tool an agent has when it works from the library; its approvers may delete a folder. */
export const MEDIA_TOOL = "list_media";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 2 * 1024 ** 3;
// No SVG: it can carry scripts.
const TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/webm", "video/quicktime"];

const FINAL = /^([a-z0-9][a-z0-9-]{0,47})\/([a-z0-9]{16,64})-([a-z0-9][a-z0-9.-]{0,99})$/;
const PENDING = /^\.pending\/([a-z0-9]{16,64})$/;
const MARKER = /^([a-z0-9][a-z0-9-]{0,47})\/\.folder$/;
/** What a desk-signed upload may carry as metadata: the folder and name come from the brain's own checks. */
export const FILE_NAME = /^[a-z0-9][a-z0-9.-]{0,99}$/;

/** Why this upload is refused, or undefined when the type and size are allowed. */
export function validateUpload(contentType: unknown, size: unknown): string | undefined {
  if (typeof contentType !== "string" || !TYPES.includes(contentType)) return "Only JPG, PNG, WebP, GIF, MP4, WebM and MOV files can be uploaded.";
  if (typeof size !== "number" || !Number.isInteger(size) || size < 1) return "size must be the file's size in bytes.";
  if (size > (contentType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES)) return contentType.startsWith("image/") ? "Images can be up to 25 MB." : "Videos can be up to 2 GB.";
  return undefined;
}

export const sanitizeFilename = (filename: string): string =>
  filename.split(/[\\/]/).pop()!.toLowerCase().replace(/[^a-z0-9.]+/g, "-").slice(-100).replace(/^[-.]+/, "") || "file";

export const pendingKey = (clientId: string, id: string) => `${clientId}/.pending/${id}`;
export const finalKey = (clientId: string, folder: string, id: string, name: string) => `${clientId}/${folder}/${id}-${name}`;

const under = (clientId: string, key: unknown) => typeof key === "string" && key.startsWith(`${clientId}/`) ? key.slice(clientId.length + 1) : undefined;

/** The parts of one of this client's final keys; undefined for anything else (another client's key, a pending key, a marker). */
export function parseFinalKey(clientId: string, key: unknown): { folder: string; id: string; name: string } | undefined {
  const match = under(clientId, key)?.match(FINAL);
  return match ? { folder: match[1], id: match[2], name: match[3] } : undefined;
}

/** The upload id of one of this client's pending keys. */
export const parsePendingKey = (clientId: string, key: unknown): string | undefined => under(clientId, key)?.match(PENDING)?.[1];

const at = (b: Uint8Array, offset: number, text: string) => [...text].every((c, i) => b[offset + i] === c.charCodeAt(0));
const starts = (b: Uint8Array, bytes: number[]) => bytes.every((v, i) => b[i] === v);

/** Whether the file's first bytes are those of the type it claims. */
export function magicMatches(contentType: string, b: Uint8Array): boolean {
  switch (contentType) {
    case "image/jpeg": return starts(b, [0xff, 0xd8, 0xff]);
    case "image/png": return starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/gif": return at(b, 0, "GIF8") && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61;
    case "image/webp": return at(b, 0, "RIFF") && at(b, 8, "WEBP");
    case "video/mp4": case "video/quicktime": return at(b, 4, "ftyp");
    case "video/webm": return starts(b, [0x1a, 0x45, 0xdf, 0xa3]);
    default: return false;
  }
}

export interface MediaFile { key: string; folder: string; name: string; contentType: string; size: number; url: string; uploadedAt: string }

export function mediaFile(object: R2Object, folder: string, name: string): MediaFile {
  return {
    key: object.key, folder, name, contentType: object.httpMetadata?.contentType ?? "application/octet-stream", size: object.size,
    url: `${MEDIA_PUBLIC_BASE}/${object.key}`, uploadedAt: object.uploaded.toISOString(),
  };
}

/**
 * One client's library, newest file first: every folder with its file count, and the files (of one folder, or all) up to
 * the cap. Pending uploads and unrecognised keys are never listed. shortcut: reads the client's whole prefix on each
 * call; add a per-folder index when a library passes a few thousand files.
 */
export async function listMedia(media: ToolMedia, clientId: string, folder?: string): Promise<{ folders: { name: string; count: number }[]; files: MediaFile[] }> {
  const counts = new Map<string, number>();
  const files: MediaFile[] = [];
  let cursor: string | undefined;
  do {
    const page = await media.list({ prefix: `${clientId}/`, cursor, include: ["httpMetadata"] });
    for (const object of page.objects) {
      const marker = object.key.slice(clientId.length + 1).match(MARKER);
      if (marker) { counts.set(marker[1], counts.get(marker[1]) ?? 0); continue; }
      const parsed = parseFinalKey(clientId, object.key);
      if (!parsed) continue;
      counts.set(parsed.folder, (counts.get(parsed.folder) ?? 0) + 1);
      if (!folder || folder === parsed.folder) files.push(mediaFile(object, parsed.folder, parsed.name));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  files.sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  return { folders: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)), files: files.slice(0, MAX_LISTED) };
}

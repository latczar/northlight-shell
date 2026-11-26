import type { PlannedRequest } from "./contracts";

// What the brain and the desk Worker (desk/) say to each other over the `DESK` service binding. Names and
// identifiers only go one way; a credential value never leaves the desk.

/** One request a tool made, as the brain forwards it. The desk checks it again from scratch. */
export interface DeskRequest {
  clientId: string;
  agentId: string;
  toolName: string;
  actionId: string;
  connection: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  redirect?: "follow" | "manual" | "error";
  /** Fingerprints of approved writes this request may match (each may run once). Absent: nothing approved. */
  approved?: string[];
  /** Record a write instead of sending it (computing a write plan). */
  planning?: boolean;
}

export type DeskReply =
  /** `consumed`: the approved fingerprint this request used up. */
  | { status: "response"; response: Response; consumed?: string }
  | { status: "planned"; planned: PlannedRequest }
  /** Not sent. `definite`: the effect did not happen. */
  | { status: "refused"; message: string; definite: boolean };

export interface DeskApi {
  /** Env var name -> set or not, for every name in this agent's connections. Never a value. */
  presence(clientId: string, agentId: string): Promise<Record<string, boolean>>;
  /** Non-secret identifiers (a connection's `ids`) that are set: connection id -> name -> value. */
  ids(clientId: string, agentId: string): Promise<Record<string, Record<string, string>>>;
  send(request: DeskRequest): Promise<DeskReply>;
  /**
   * A presigned S3 PUT (15 minutes, not single-use) for the client's pending upload `key` (`<clientId>/.pending/<id>`).
   * The type, exact size and `meta` (folder, name, uploader) are signed headers: R2 refuses a PUT that differs.
   */
  mediaUploadUrl(clientId: string, key: string, contentType: string, size: number, meta: MediaUploadMeta): Promise<MediaUploadLink>;
}

export interface MediaUploadMeta { folder: string; name: string; uploader: string }

/** The PUT address and the exact headers the browser must send with it (a browser sets Content-Length itself from the body). */
export interface MediaUploadLink {
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
}

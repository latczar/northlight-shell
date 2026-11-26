import { WorkerEntrypoint } from "cloudflare:workers";
import type { DeskApi, DeskReply, DeskRequest, MediaUploadLink, MediaUploadMeta } from "../src/desk-api";
import { ids, mediaUploadUrl, presence, send, type DeskEnv } from "./service";

// The front desk Worker: the only place service credentials live. The brain reaches it over a service binding
// (`DESK`, entrypoint Desk); it has no public URL. See "Desk Worker" in the README.

export class Desk extends WorkerEntrypoint<DeskEnv> implements DeskApi {
  async presence(clientId: string, agentId: string): Promise<Record<string, boolean>> {
    return presence(this.env, clientId, agentId);
  }

  async ids(clientId: string, agentId: string): Promise<Record<string, Record<string, string>>> {
    return ids(this.env, clientId, agentId);
  }

  async send(request: DeskRequest): Promise<DeskReply> {
    return send(this.env, request);
  }

  async mediaUploadUrl(clientId: string, key: string, contentType: string, size: number, meta: MediaUploadMeta): Promise<MediaUploadLink> {
    return mediaUploadUrl(this.env, clientId, key, contentType, size, meta);
  }
}

export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<DeskEnv>;

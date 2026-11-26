import "server-only";
import { canSeeClient, canUseAgent } from "@/lib/access";
import { apiViewer, type Viewer } from "./session";

/**
 * For the chat routes: the signed-in person and the client, or the error to send. An employee or business this person may
 * not use answers 404, the same as one that does not exist.
 */
export async function agentRoute(request: Request, params: Promise<{ client: string; agent: string }>): Promise<{ viewer: Viewer; clientId: string; agentId: string } | Response> {
  const viewer = await apiViewer(request);
  if (viewer instanceof Response) return viewer;
  const { client: clientId, agent: agentId } = await params;
  if (!canSeeClient(viewer.access, viewer.clients, clientId) || !canUseAgent(viewer.access, clientId, agentId)) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  return { viewer, clientId, agentId };
}

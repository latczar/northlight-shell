import { agentRoute } from "@/lib/server/agent-route";
import { BrainError, getJob } from "@/lib/server/brain";

/** GET: the current or latest background job of the signed-in person's conversation with this employee. */
export async function GET(request: Request, { params }: { params: Promise<{ client: string; agent: string }> }) {
  const found = await agentRoute(request, params);
  if (found instanceof Response) return found;
  try {
    return Response.json({ job: await getJob(found.clientId, found.agentId, found.viewer.userId) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof BrainError ? error.message : "Northlight's service failed." }, { status: error instanceof BrainError ? error.status : 502 });
  }
}

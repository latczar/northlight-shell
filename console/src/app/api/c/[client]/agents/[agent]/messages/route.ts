import { agentRoute } from "@/lib/server/agent-route";
import { BrainError, listMessages } from "@/lib/server/brain";

/** GET: one page of the signed-in person's own conversation with this employee (`?before=<seq>` for older lines). */
export async function GET(request: Request, { params }: { params: Promise<{ client: string; agent: string }> }) {
  const found = await agentRoute(request, params);
  if (found instanceof Response) return found;
  const raw = new URL(request.url).searchParams.get("before");
  const before = raw === null ? undefined : Number(raw);
  if (before !== undefined && !(Number.isSafeInteger(before) && before > 0)) return Response.json({ error: "before must be a message number." }, { status: 400 });
  try {
    return Response.json(await listMessages(found.clientId, found.agentId, found.viewer.userId, before), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof BrainError ? error.message : "Northlight's service failed." }, { status: error instanceof BrainError ? error.status : 502 });
  }
}

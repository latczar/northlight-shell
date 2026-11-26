import { agentRoute } from "@/lib/server/agent-route";
import { BrainError, startJob } from "@/lib/server/brain";
import { brainHasAccess, PeopleError } from "@/lib/server/people";

const MESSAGE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * POST {id, text}: hands the message to the employee as a background job and answers at once (202). The same id is the
 * same message, so a retry never sends it twice. The conversation is always the signed-in person's own.
 */
export async function POST(request: Request, { params }: { params: Promise<{ client: string; agent: string }> }) {
  const found = await agentRoute(request, params);
  if (found instanceof Response) return found;
  const body = await request.json().catch(() => null) as { id?: unknown; text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (typeof body?.id !== "string" || !MESSAGE_ID.test(body.id) || /^\.+$/.test(body.id)) return Response.json({ error: "The message has no valid id. Reload the page." }, { status: 400 });
  if (!text || text.length > 8000) return Response.json({ error: "The message was empty or too long (8,000 characters at most)." }, { status: 400 });
  try {
    // The brain applies its own copy of who approves and manages; start nothing while it still holds an older copy of
    // this person's access (a send failed). A job that is already running is not stopped.
    if (!(await brainHasAccess(found.viewer.userId, found.clientId))) {
      return Response.json({ error: "Your access was just changed and Northlight's service has not taken the change yet. Try again in a minute." }, { status: 503 });
    }
    const result = await startJob(found.clientId, found.agentId, found.viewer.userId, { id: body.id, text });
    return result.ok
      ? Response.json({ job: result.value.job, ...(result.value.queued ? { queued: true } : {}) }, { status: 202 })
      : Response.json({ error: result.message }, { status: result.status });
  } catch (error) {
    if (error instanceof PeopleError) return Response.json({ error: error.message }, { status: 503 });
    return Response.json({ error: error instanceof BrainError ? error.message : "Northlight's service failed." }, { status: error instanceof BrainError ? error.status : 502 });
  }
}

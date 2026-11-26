"use server";
import { hasServicesRequest } from "@/lib/services-call";
import { canManageAgent } from "@/lib/access";
import { historyCaller } from "@/lib/server/pilot-call-access";
import { pilotCall } from "@/lib/server/iris-calls.mjs";
import { callDraft } from "@/lib/server/brain";
import { brainHasAccess } from "@/lib/server/people";
import { actionViewer } from "@/lib/server/session";

export async function createServicesDraft(client: string, agent: string, id: string) {
  const viewer = await actionViewer();
  if ("error" in viewer) return {error:viewer.error};
  const caller = historyCaller(viewer.email,client,agent,viewer.userId);
  if (!caller || !canManageAgent(viewer.access,client,agent)) return {error:"Website manager access is required."};
  try {
    const record = await pilotCall(process.env.IRIS_CALL_HISTORY_KEY!, id, caller);
    if (!record) return {error:"Call unavailable."};
    if (!hasServicesRequest(record.turns)) {
      return { error: "This call has no Services request." };
    }
    const callerTurns = record.turns.filter((turn: { who: string }) => turn.who === "You");
    const remarks = callerTurns.map((turn: { text: string }) => turn.text).join("\n");
    if (remarks.length > 5000) {
      return { error: "This call is too long to turn into a draft here. Open staff chat to choose the Services changes to review." };
    }
    if (!await brainHasAccess(viewer.userId,client)) return {error:"Staff access is updating. Try again shortly."};
    await callDraft(client,viewer.userId,id,remarks);
    return {};
  } catch { return {error:"Iris could not open the draft. Try again to resume this request."}; }
}

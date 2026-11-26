"use server";
import { canSeeClient, canUseAgent } from "@/lib/access";
import { CallStartError, startBrowserCall, type CallStart } from "@/lib/server/iris-voice";
import { actionViewer } from "@/lib/server/session";

/** Opens a browser call to Iris for the signed-in person. Only Kestrel Garage's Iris has a voice agent. */
export async function startIrisCall(client: string, agent: string): Promise<CallStart | { error: string }> {
  const viewer = await actionViewer();
  if ("error" in viewer) return { error: viewer.error };
  if (client !== "kestrel" || agent !== "iris" || !canSeeClient(viewer.access, viewer.clients, client) || !canUseAgent(viewer.access, client, agent)) {
    return { error: "You do not have access to Iris." };
  }
  try {
    return await startBrowserCall(client, viewer.userId);
  } catch (error) {
    return { error: error instanceof CallStartError ? error.message : "The call could not be started. Try again." };
  }
}

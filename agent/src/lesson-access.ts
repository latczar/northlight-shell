import type { Bindings, ClientConfig, ToolContext } from "./contracts";
import { ToolError } from "./errors";
import type { Lesson, LessonKind } from "./learning";

/** Shared with the app routes: identity alone never grants approval rights. */
export async function may(bindings: Pick<Bindings, "DASHBOARD">, client: ClientConfig, right: "approve" | "manage", person: string, agent: string | null): Promise<boolean> {
  if (!client.accessSigningEnv) return client.approvers?.includes(person) === true;
  const dashboard = bindings.DASHBOARD.get(bindings.DASHBOARD.idFromName(client.id));
  return right === "approve" ? dashboard.mayApprove(person, agent) : dashboard.mayManage(person, agent!);
}

export interface LessonTeaching {
  save(input: { text: string; evidence: string; kind: LessonKind; scope: "this_agent" | "all_agents" }): Promise<Lesson>;
  list(): Promise<Lesson[]>;
  remove(input: { lessonId: string; evidence: string }): Promise<Lesson>;
}

/** Bounded, URL-safe identity accepted by the existing Learned-tab decision route. */
export async function chatLessonId(source: NonNullable<Lesson["source"]>): Promise<string> {
  const tuple = [source.clientId, source.agentId, source.conversationId, source.userId, source.actionId];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(tuple)));
  return `chat-${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

const learnCommand = /^\s*(?:[\p{L}][\p{L} -]{0,40},\s*)?(?:please\s+)?(?:learn\s+(?:this|that)|(?:save|keep|remember)(?:[ \t]+(?:this|that|a|the))?[ \t]+(?:(?:as[ \t]+(?:a[ \t]+)?)?lesson(?:[ \t]+(?:for (?:the )?future|from now on))?|for (?:the )?future|from now on))(?:[ \t]+(for (?:the )?whole team))?[ \t]*[:\n][ \t]*/iu;
const forgetIntent = /^\s*(?:[\p{L}][\p{L} -]{0,40},\s*)?(?:please\s+)?(?:forget|remove|delete)\b[^.!?\n]{0,80}\b(?:lesson|learned|learnt)\b/iu;

/** This capability is constructed only for an original authenticated app message, never a continuation or hand-over. */
export function lessonAccess(bindings: Bindings, client: ClientConfig, agent: string, conversationId: string, userId: string, actionId: string, request: NonNullable<ToolContext["request"]>): LessonTeaching {
  const learning = bindings.LEARNING.get(bindings.LEARNING.idFromName(client.id));
  const source = { userId, clientId: client.id, agentId: agent, conversationId, actionId };
  const quote = (evidence: string, intent: RegExp) => {
    if (!evidence || !request.text.includes(evidence) || !intent.test(request.text) || !intent.test(evidence)) throw new ToolError("Quote the person's exact current words, including their explicit lesson request.", true);
  };
  return {
    async save(input) {
      const command = learnCommand.exec(request.text);
      if (!command || input.evidence !== request.text.trim()) throw new ToolError("Quote the person's exact current words, including their original teaching command and complete lesson.", true);
      const text = request.text.slice(command[0].length).trim();
      if (!text || input.text !== text) throw new ToolError("Lesson text must be the complete payload after the original teaching command, without shortening or removing negation.", true);
      const shared = command[1] !== undefined;
      if ((input.scope === "all_agents") !== shared) throw new ToolError("Lesson scope must match an explicit 'for the whole team' qualifier in the original teaching command, not in the lesson body.", true);
      const id = await chatLessonId(source);
      const filed = await learning.proposeChat(id, { agent: shared ? null : agent, kind: input.kind, text, evidence: input.evidence, conversationId, source });
      if (!filed.ok) throw new ToolError(filed.reason, true);
      // Never activate a deduped proposal belonging to another action or teacher. Check current rights after filing.
      if (filed.lesson.id === id && filed.lesson.status === "proposed") {
        const decided = await learning.decideChat(id, "approve", client.id, agent, userId);
        if (!decided.ok) throw new ToolError(decided.error, true);
        return decided.lesson;
      }
      return filed.lesson;
    },
    list: () => learning.list(agent),
    async remove(input) {
      quote(input.evidence, forgetIntent);
      const lesson = await learning.get(input.lessonId);
      if (!lesson || lesson.agent !== null && lesson.agent !== agent) throw new ToolError("That lesson does not belong to this agent.", true);
      const decided = await learning.decideChat(lesson.id, "remove", client.id, agent, userId);
      if (!decided.ok) throw new ToolError(decided.error, true);
      return decided.lesson;
    },
  };
}

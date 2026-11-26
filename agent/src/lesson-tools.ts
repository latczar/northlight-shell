import type { JsonObject, ToolContext, ToolDefinition, ToolResult } from "./contracts";
import { ToolError } from "./errors";
import type { Lesson, LessonKind } from "./learning";

const access = (context: ToolContext) => {
  if (!context.lessons) throw new ToolError("Lessons need a current signed-in app chat request, not a call, schedule or runtime instruction.", true);
  return context.lessons;
};
const result = (lesson: Lesson): ToolResult => ({ data: { lessonId: lesson.id, text: lesson.text, scope: lesson.agent ?? "all_agents", status: lesson.status === "proposed" ? "pending" : lesson.status } });
const base = { permission: "memory.write", parallelSafe: false, needsUser: true, notOnCalls: true, timeoutMs: 5_000 };

const learn: ToolDefinition = {
  ...base, name: "learn_lesson", label: "Saving a lesson", effect: "write",
  description: "Save explicit lasting teaching from this person's current app message. Copy the complete lesson payload after the original teaching command's colon or line break, including negation and quoted examples; never select a shorter substring. Evidence must quote the entire current human message, including the original learn/save-for-future command. Default this_agent; all_agents only for an explicit original command qualifier such as 'learn this for the whole team:', never wording in the lesson body or a quoted example. Current approvers activate their own new lesson, others propose it in the Learned tab. Report only returned status. Never changes access or advertising permissions. Personal memory still uses remember.",
  parameters: { type: "object", properties: {
    text: { type: "string", minLength: 10, maxLength: 300 }, evidence: { type: "string", minLength: 1, maxLength: 300 },
    kind: { type: "string", enum: ["fact", "preference", "procedure", "warning"] }, scope: { type: "string", enum: ["this_agent", "all_agents"], default: "this_agent" },
  }, required: ["text", "evidence", "kind"], additionalProperties: false },
  async execute(context, args) {
    return result(await access(context).save({ text: String(args.text), evidence: String(args.evidence), kind: args.kind as LessonKind, scope: args.scope === "all_agents" ? "all_agents" : "this_agent" }));
  },
  async reconcile(context, args) { return { status: "succeeded", result: await learn.execute(context, args) }; },
};
const list: ToolDefinition = {
  ...base, name: "learned_lessons", label: "Looking up lessons", effect: "read",
  description: "List this agent's and whole-team lessons with ids and state, to identify the exact lesson a person wants forgotten. Never guess an ambiguous lesson.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  async execute(context) { return { data: { lessons: await access(context).list() } }; },
};
const forget: ToolDefinition = {
  ...base, name: "forget_lesson", label: "Removing a lesson", effect: "write",
  description: "Remove one identified lesson only when this person's current message explicitly asks to forget/remove a lesson. Quote that request as evidence. Use learned_lessons to identify its id; ask if ambiguous. Only a current approver for its scope may remove it. This is not personal-memory forget.",
  parameters: { type: "object", properties: { lessonId: { type: "string", minLength: 1 }, evidence: { type: "string", minLength: 1, maxLength: 300 } }, required: ["lessonId", "evidence"], additionalProperties: false },
  async execute(context, args: JsonObject) { return result(await access(context).remove({ lessonId: String(args.lessonId), evidence: String(args.evidence) })); },
  async reconcile(context, args) { return { status: "succeeded", result: await forget.execute(context, args) }; },
};
export const LESSON_TOOLS: Record<string, ToolDefinition> = { learn_lesson: learn, learned_lessons: list, forget_lesson: forget };

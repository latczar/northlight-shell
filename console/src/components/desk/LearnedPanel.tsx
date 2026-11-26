import { BookOpen } from "lucide-react";
import { LoadFailed } from "@/components/LoadFailed";
import { Section } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/Notice";
import { Status } from "@/components/ui/Status";
import type { Lesson } from "@/lib/brain-types";
import { formatAgo, formatFull } from "@/lib/format";
import type { Part } from "@/lib/server/workspace";
import { LessonActions } from "./LessonActions";

const KIND: Record<Lesson["kind"], string> = { fact: "Fact", preference: "Preference", procedure: "How to", warning: "Watch out" };

/*
 What the employee learned from people's words. A proposed lesson waits for someone who approves for this employee; an
 active one shapes its work. Each says where it came from, in the person's own words.
*/
export function LearnedPanel({ lessons, clientId, agentId, agentName, canDecide }: { lessons: Part<Lesson[]>; clientId: string; agentId: string; agentName: string; canDecide: boolean }) {
  if (!lessons.ok) return <LoadFailed title="What it learned could not be loaded" reason={lessons.error} />;
  const proposed = lessons.value.filter(l => l.status === "proposed");
  const active = lessons.value.filter(l => l.status === "active");
  const row = (lesson: Lesson) => (
    <li key={lesson.id} className="flex flex-col gap-3 px-4 py-4 @xl:flex-row @xl:items-start @xl:gap-6 md:px-6">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Status tone={lesson.status === "proposed" ? "attention" : "ok"}>{lesson.status === "proposed" ? "Waiting for approval" : "In use"}</Status>
          <span className="text-meta text-ink-3">
            {KIND[lesson.kind]} · {lesson.agent === null ? "every employee" : agentName} ·{" "}
            <time dateTime={new Date(lesson.createdAt).toISOString()} title={formatFull(lesson.createdAt)}>
              {formatAgo(lesson.createdAt)}
            </time>
          </span>
        </div>
        <p className="mt-1 text-title text-pretty text-ink">{lesson.text}</p>
        {lesson.evidence && <p className="mt-0.5 text-small text-pretty text-ink-2">From: “{lesson.evidence}”</p>}
      </div>
      {canDecide && <LessonActions clientId={clientId} agentId={agentId} lessonId={lesson.id} proposed={lesson.status === "proposed"} agentName={agentName} />}
    </li>
  );
  if (!proposed.length && !active.length) {
    return (
      <EmptyState icon={BookOpen} title={`${agentName} has not learned anything yet`}>
        When you tell {agentName} to remember how you like things done, the lesson waits here for approval before it is used.
      </EmptyState>
    );
  }
  return (
    <div className="@container flex flex-col gap-10">
      {proposed.length > 0 && (
        <Section title="Waiting for approval">
          <ul className="flex flex-col divide-y divide-rule rounded-lg border border-rule bg-card">{proposed.map(row)}</ul>
        </Section>
      )}
      {active.length > 0 && (
        <Section title="In use">
          <ul className="flex flex-col divide-y divide-rule rounded-lg border border-rule bg-card">{active.map(row)}</ul>
        </Section>
      )}
      {!canDecide && <p className="text-small text-ink-2">People who approve for {agentName} decide what it keeps.</p>}
    </div>
  );
}

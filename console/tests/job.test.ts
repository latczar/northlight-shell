import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, JobStatus } from "@/lib/brain-types";
import { formatElapsed, transition, watchJob, type JobEvent } from "@/lib/job";

const job = (status: JobStatus, over: Partial<Job> = {}): Job => ({ id: "job-1", status, startedAt: 0, updatedAt: 0, steps: [], current: null, queued: 0, ...over });

describe("transition", () => {
  it("announces nothing on the first look after a page load", () => {
    expect(transition(undefined, job("needs_approval"))).toBeNull();
    expect(transition(undefined, job("done"))).toBeNull();
  });

  it("announces a request for a decision once, and the end once", () => {
    expect(transition(job("running"), job("needs_approval"))).toBe("approval");
    expect(transition(job("needs_approval"), job("needs_approval"))).toBeNull();
    expect(transition(job("needs_approval"), job("done"))).toBe("ended");
    expect(transition(job("done"), job("done"))).toBeNull();
  });

  it("treats a new job that already ended as news", () => {
    expect(transition(job("done"), job("failed", { id: "job-2" }))).toBe("ended");
  });
});

describe("formatElapsed", () => {
  it("never shows negative time from a clock behind the brain's", () => {
    expect(formatElapsed(-5000)).toBe("0s");
    expect(formatElapsed(136_000)).toBe("2m 16s");
    expect(formatElapsed(3_900_000)).toBe("1h 05m");
  });
});

describe("watchJob", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function watch(answers: (Job | null | Error)[], hidden = () => false) {
    const events: JobEvent[] = [];
    const trouble: boolean[] = [];
    let calls = 0;
    const w = watchJob({
      fetchJob: async () => {
        const next = answers[Math.min(calls++, answers.length - 1)];
        if (next instanceof Error) throw next;
        return next;
      },
      fetchMessages: async () => {},
      onJob: () => {},
      onEvent: event => events.push(event),
      onTrouble: t => trouble.push(t),
      isHidden: hidden,
      intervalMs: 1000,
      hiddenPauseMs: 5000,
    });
    return { w, events, trouble, calls: () => calls };
  }

  it("follows a job until it ends, says so once, then stops checking", async () => {
    const { w, events, calls } = watch([job("running"), job("needs_approval"), job("done")]);
    w.start(job("running"));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual(["approval", "ended"]);
    const after = calls();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls()).toBe(after);
  });

  it("keeps checking while messages wait behind a finished job", async () => {
    const { w, calls } = watch([job("done", { queued: 1 }), job("running"), job("done")]);
    w.start(job("running"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls()).toBe(3);
  });

  it("tells the person after two failed checks in a row, and again when checks work", async () => {
    const { w, trouble } = watch([new Error("down"), new Error("down"), job("running"), job("done")]);
    w.start(job("running"));
    await vi.advanceTimersByTimeAsync(4000);
    expect(trouble).toEqual([true, false]);
  });

  it("clears the trouble warning when a new message restarts the watch", async () => {
    const { w, trouble } = watch([new Error("down"), new Error("down"), job("running")]);
    w.start(job("running"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(trouble).toEqual([true]);
    w.start(job("running", { id: "job-2" }));
    expect(trouble).toEqual([true, false]);
  });

  it("pauses in a tab hidden past the limit and resumes when shown", async () => {
    let hidden = true;
    const { w, calls } = watch([job("running")], () => hidden);
    w.start(job("running"));
    await vi.advanceTimersByTimeAsync(5000);
    const beforePause = calls();
    // past the 5 s limit the next timer pauses instead of checking
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls()).toBe(beforePause);
    hidden = false;
    w.visibilityChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls()).toBe(beforePause + 1);
  });
});

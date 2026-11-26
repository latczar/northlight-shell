import { DurableObject } from "cloudflare:workers";
import { AGENTS } from "../agents";
import { CLIENTS } from "../clients";
import { TOOLS } from "../tools";
import type { AdminStuckStep, AgentTemplate, Bindings, ClientConfig, JsonObject, ToolDefinition, TurnEvent } from "./contracts";
import type { DeskApi } from "./desk-api";
import { ModelProtocolError, SafeConfigurationError, ToolError } from "./errors";
import { brainBindings, toolBindings } from "./bindings";
import { checkStuckAction, decideAction, forgetPendingSince, prepareSpokenAction, rehearseTurn, runTurn, type Decision, type TurnDeps, type TurnResult } from "./loop";
import { pickLessons, type Lesson } from "./learning";
import { memoryName, type Fact } from "./memory";
import {
  applyProgress, checkBackNote, humanize, isActive, JOB_ACTIVE_MESSAGE, JOB_MAX_MS, type Job, type JobInput, jobBusy, jobDueAt, jobView,
  type JobView, loadJob, loadQueue, MAX_QUEUED, newJob, saveJob, saveQueue, SEGMENT_WATCHDOG_MS,
} from "./jobs";
import { limitsFor } from "./limits";
import { MAX_TRANSCRIPT_CHARS, reviewConversation } from "./review";
import { ProviderAdapter, type ModelAdapter } from "./model";
import type { Scheduler } from "./scheduler";
import { agentSettings } from "./settings";
import { Store } from "./store";
import { adminStuckStep, legacyRequestOrigin, stuckStep } from "./stuck";
import { decideApproval, type DecisionReply, type RunDecision } from "./approvals";
import type { Approval } from "./dashboard";
import { approvedCallers } from "./phone";
import { approvalBlocks, decisionText, NO_REPLY, postSlack, retryBlocks, SLACK_USER, type SlackDecision, type SlackTarget, toSlackText, updateCard } from "./slack";
import {
  ACK_AFTER_MS, BRIEFING_FRESH_MS, CHECK_IN_WAIT_MS, isCheckIn, isOutcome, isYes, JOB_RUNNING_SPOKEN, pick, PROGRESS_AFTER_MS, repeats, STILL_CHECKING, STILL_WORKING,
} from "./voice";

export interface Env extends Bindings {
  CONVERSATIONS: DurableObjectNamespace<Conversation>;
  SCHEDULER: DurableObjectNamespace<Scheduler>;
  /** Requests per client per minute (wrangler `ratelimits`). */
  CLIENT_LIMITER: RateLimit;
  /** Read-only call progress polling, separate from live turns. */
  STATUS_LIMITER: RateLimit;
  /** Status polls per signed person, before the client-wide status allowance. */
  STATUS_PERSON_LIMITER: RateLimit;
  /** Media library requests per client per minute, apart from the chats' allowance (an upload is two requests a file). */
  MEDIA_LIMITER: RateLimit;
  /** Lead list, export and share requests per client per minute, apart from the chats' allowance (a shared link is open to whoever has it). */
  LEADS_LIMITER: RateLimit;
  /** Leads a single site may send per minute. */
  LEAD_INTAKE_LIMITER: RateLimit;
  /** The desk Worker (service binding `DESK`): holds every service credential. Never given to tools. */
  DESK: DeskApi;
  [secret: string]: unknown;
}

const FACTS_IN_PROMPT = 20;
/** How old a call's notes (facts, lessons, settings) may be and still be used for its next reply. */
const CALL_NOTES_MS = 60_000;
/** A review runs after this many answered messages from a person, or once the conversation has been quiet this long. */
const REVIEW_EVERY_TURNS = 4;
const REVIEW_AFTER_QUIET_MS = 2 * 60_000;
/** Transcript lines a review looks back over at most. */
const REVIEW_LINES = 80;
/** A failed or postponed review (model error, daily allowance used) tries again after this long. */
const REVIEW_RETRY_MS = 60 * 60_000;
const REVIEW_RUNNING_MS = 5 * 60_000;
/** A spoken yes that is not finished is tried again after this long, doubling up to an hour. */
const SPOKEN_YES_RETRY_MS = 60_000;
/** What the approval records beside the caller as its reason. */
const SPOKEN_YES_REASON = "said yes on a call";
/** How long a call's record of its approved caller is believed after the call started: four times the longest call ElevenLabs allows (30 minutes), so an old call's id is no way back in. */
const CALL_RECORD_MS = 2 * 60 * 60_000;

/** A confirmed caller's approval candidate, saved with its action before filing; eligibility is checked before deciding. */
interface SpokenYes { id: string; by: string; name: string; settingsHash: string; tries: number; card?: true }

/** Decline reasons waiting for a review, oldest first. */
function pendingDeclines(store: Store): { title: string; reason: string }[] {
  try { return JSON.parse(store.meta("pendingDeclines") || "[]") as { title: string; reason: string }[]; } catch { return []; }
}

/**
 * A message's own words, without what is written around them: the header line the phone and Slack routes add (src/index.ts
 * completions, src/slack.ts handleMessage), Slack's attached-files line and the agents app's "Attached files:" list (its
 * links hold media folder names). A site is justified only by what the person said. It only ever removes text, so it can
 * never add a match.
 * shortcut: matches those writers' wording, so a reworded header or list would be read as the person's words; have the
 * routes pass the raw words in TurnRequest.request when they are next changed.
 */
const ownWords = (text: string): string => text
  .replace(/^\[(?:Phone call|Slack (?:direct message|thread reply|channel message)) from [^\n]*\]\n/, "")
  .replace(/\n\nAttached files \(read them with read_slack_file before acting on them\): [\s\S]*$/, "")
  .replace(/\n\nAttached files:\n[\s\S]*$/, "");

export interface TurnRequest {
  clientId: string;
  agentId: string;
  conversationId: string;
  userId?: string;
  source?: AdminStuckStep["source"];
  input: { id: string; text: string };
  /** The ElevenLabs endpoint: replies are spoken. */
  voice?: boolean;
  /** A fresh provider transcript, not an individual response stream opening. */
  voiceStart?: boolean;
  /** Optional per-call identifier supplied separately from the reusable conversation route. */
  voiceSession?: string;
  /** Voice turns of a client with approved callers (ClientConfig.phone): the caller's first name, from phone-start. */
  caller?: string;
  /** A Slack message (src/slack.ts): the job's replies and approval cards are posted back here. */
  slack?: SlackTarget & { addressed?: boolean };
  /**
   * The trusted request this input belongs to when it is not the input's own words (ToolContext.request): a schedule's
   * reviewed task, one id for every attempt of a run, or the request a confirmed call handed over. Absent: the input's own words.
   */
  request?: TurnDeps["request"];
}

function chatTeacher(request: TurnRequest): TurnDeps["teacher"] {
  return request.source === "app" && request.userId && request.userId !== "team" && !request.voice && !request.slack && !request.request
    ? { inputId: request.input.id, text: ownWords(request.input.text) } : undefined;
}

/** One caller request on the line: what a voice turn says goes here. `lost` once the caller's side is gone. */
interface Listener {
  lost: boolean;
  /** `onHeard` runs once the caller's side has taken the event. */
  write(event: TurnEvent, onLost?: () => void, onHeard?: () => void): void;
  close(): void;
}

/** A voice turn that has not finished: it keeps running whatever happens to the request that started it. */
interface VoiceRun {
  inputId: string;
  /** The caller's words this turn answers: its own, after any that were still waiting their turn. */
  text: string;
  /** The turn has begun (it can no longer be replaced by newer words). */
  started: boolean;
  /** Newer words replaced this request before it began: it says nothing and starts nothing. */
  superseded: boolean;
  /** The caller spoke again before hearing any of this running turn: the newest request wins, so it says no more, stops (`stop`) and its reply is forgotten. */
  silenced: boolean;
  /** Stops this turn's model work when it is silenced (TurnDeps.overtaken), so the newest request is not kept waiting behind it. */
  stop: AbortController;
  /** The answer words it was not allowed to say while silenced. */
  dropped: string;
  /** Says one of this turn's events to the caller. */
  speak(event: TurnEvent): void;
  /** Answer words of this turn reached the caller's side. A line said before a lookup does not count. */
  heard: boolean;
  /** Lines said before lookups so far: words sent before the latest one are not the answer. */
  leads: number;
  startedAt: number;
  finished: boolean;
  done: Promise<void>;
}

/** One conversation: its history, actions and spend live in this object's own SQLite. */
export class Conversation extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve();
  /** True while this object is running a job segment (in memory: a restart clears it, which is how a crashed segment is told from a live one). */
  private driving = false;
  /** The voice request now on the line (in memory): ElevenLabs cancels a request when the caller speaks and sends the new words as the next one. */
  private listener?: Listener;
  /** Voice turns not finished yet, oldest first. */
  private voiceRuns: VoiceRun[] = [];
  /** Tool events carry catalogue names, never model words or arguments. Kept only while the turn runs. */
  private callSteps: { name: string; label: string }[] = [];
  private registeringCall?: Promise<void>;
  /** When the earliest turn overtaken by newer words started: a change it read back was never heard, so the next turn asks in full. */
  private unheardSince?: number;
  /** Spoken yeses are finished one sweep at a time (settleSpokenYeses). */
  private settling: Promise<void> = Promise.resolve();
  /** Test seam: the model adapter used for new turns. */
  model: ModelAdapter = new ProviderAdapter();
  /** Test seam: the tool catalog for new turns and approval decisions. */
  catalog: Record<string, ToolDefinition> = TOOLS;
  /** Test seams: how long a lookup runs before its progress line, how long the caller waits before the acknowledgement, and how long a check-in waits for the running turn. */
  progressAfterMs = PROGRESS_AFTER_MS;
  ackAfterMs = ACK_AFTER_MS;
  checkInWaitMs = CHECK_IN_WAIT_MS;
  /** A phone call's notes for its next reply (in memory): facts, every active lesson and the settings, as read once the reply before was out. */
  private callNotes?: { at: number; facts: Fact[]; lessons: Lesson[]; settings: JsonObject };
  /** Test seam: how old those notes may be and still be used. */
  callNotesMs = CALL_NOTES_MS;
  /** Test seam: posts one message to Slack (the runtime's own post, through the desk's slack_reply connection). */
  slackPost = (client: ClientConfig, target: SlackTarget, message: { text: string; blocks?: unknown[] }, key: string): Promise<boolean> =>
    postSlack(this.env.DESK, client, target, message, key);

  /** Runs one user message through the loop; events stream back as NDJSON. Turns queue in order. */
  async turn(request: TurnRequest): Promise<ReadableStream<Uint8Array>> {
    const { client, agent, store } = this.open(request);
    if (request.voice) return this.voiceTurn(request, client, agent, store);
    if (jobBusy(store)) throw new Error(JOB_ACTIVE_MESSAGE);

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    // A disconnected listener must not stop the turn; writes to it are simply dropped.
    const emit = (event: TurnEvent) => { writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => {}); };
    void this.enqueue(store, client, agent, request, emit).finally(() => writer.close().catch(() => {}));
    return readable;
  }

  /**
   * A phone turn. The caller's words may arrive while their last request is still being worked on (ElevenLabs cancelled that
   * request and sent the new words). A check-in ("hello?") hears that we are still on it and then the answer. For any other
   * words the newest request wins, as on Retell and Pipecat: a running turn the caller has heard none of is stopped (its
   * model work is dropped, a lookup under way finishes and stays), says nothing and is forgotten, so the model sees
   * everything they said as unanswered and replies once, without waiting behind it. An answer they began to hear is
   * finished first, and a line telling them work was started or filed is always said.
   */
  private async voiceTurn(request: TurnRequest, client: ClientConfig, agent: AgentTemplate, store: Store): Promise<ReadableStream<Uint8Array>> {
    if (request.source === "app" && request.userId && request.userId !== "team" && !request.caller && request.conversationId.startsWith(`voice-${request.userId}-`)) {
      const startedAt = Number(store.meta("appCallStartedAt") || Date.now());
      store.setMeta("appCallStartedAt", String(startedAt));
      store.setMeta("appCallActivityAt", String(Date.now()));
      if (!store.meta("appCallRegistered") && !this.registeringCall) {
        this.registeringCall = this.env.DASHBOARD.get(this.env.DASHBOARD.idFromName(client.id))
          .registerAppCall(agent.id, request.conversationId, request.userId, startedAt)
          .then(() => { store.setMeta("appCallRegistered", "1"); })
          .catch(error => { console.error("call registry failed", error instanceof Error ? error.name : typeof error); })
          .finally(() => { this.registeringCall = undefined; });
        this.ctx.waitUntil(this.registeringCall);
      }
    }
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const listener: Listener = {
      lost: false,
      write: (event, onLost, onHeard) => {
        writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).then(onHeard, () => { listener.lost = true; onLost?.(); });
      },
      close: () => { writer.close().catch(() => {}); },
    };
    // This request is the one on the line now; the one before it is over.
    this.listener?.close();
    this.listener = listener;

    const { input } = request;
    const checkIn = isCheckIn(input.text);
    const again = this.voiceRuns.some(run => run.inputId === input.id);
    // An answer (or the start of one) that nobody was on the line to hear.
    let lost = store.meta("unheard");
    let replayed = false;
    if (lost) {
      const from = { inputId: store.meta("unheardId") ?? "", heard: store.meta("unheardPart") === "1", startedAt: Number(store.meta("unheardSince") || 0) };
      store.setMeta("unheard", "");
      // The same words sent again get their stored reply from the loop, so only different words meet the old answer.
      if (from.inputId !== input.id && (checkIn || again || from.heard || isOutcome(lost))) {
        replayed = true;
        const event: TurnEvent = { type: "text", delta: lost };
        listener.write(event, () => this.keep(store, from, event));
      } else if (from.inputId !== input.id) {
        // New words before any of it was heard: it is never said. A turn still running forgets its reply when it ends.
        const running = this.voiceRuns.find(run => run.inputId === from.inputId && !run.finished);
        if (running) running.dropped = lost;
        else store.forgetReply(lost);
        this.unheardSince = Math.min(this.unheardSince ?? Infinity, from.startedAt);
      }
    }

    const last = this.voiceRuns.at(-1);
    if (last && (again || checkIn)) {
      if (!again) listener.write({ type: "text", delta: pick(STILL_CHECKING, input.id) });
      void this.hold(listener, last);
      return readable;
    }
    if (lost && checkIn) {
      listener.close();
      return readable;
    }

    const run: VoiceRun = { inputId: input.id, text: input.text, started: false, superseded: false, silenced: false, stop: new AbortController(), dropped: "", speak: () => {}, heard: false, leads: 0, startedAt: 0, finished: false, done: Promise.resolve() };
    run.speak = event => this.say(store, run, event);
    // Requests still waiting their turn are replaced by these words (ElevenLabs sends several within a second when the caller cuts in).
    // Within the same call, waiting words go in front of these, unless these only repeat them.
    // A turn already running whose answer the caller has heard none of is stopped: the newest request wins.
    for (const other of this.voiceRuns) {
      if (!other.started) {
        if (!other.superseded && !repeats(input.text, other.text)) run.text = `${other.text} ${run.text}`;
        other.superseded = true;
      } else if (!other.finished && !other.heard) {
        other.silenced = true;
        other.stop.abort();
        this.unheardSince = Math.min(this.unheardSince ?? Infinity, other.startedAt);
      }
    }
    const asked: TurnRequest = run.text === input.text ? request : { ...request, input: { id: input.id, text: run.text } };
    // A space separates this answer from words the caller has just heard before it.
    const lead = replayed || this.voiceRuns.some(other => other.started && !other.silenced);
    this.voiceRuns.push(run);
    run.done = this.enqueue(store, client, agent, asked, event => {
      if (event.type === "tool") {
        if (event.status === "started") this.callSteps.push({ name: event.name, label: this.catalog[event.name]?.label ?? humanize(event.name) });
        else {
          const index = this.callSteps.findIndex(step => step.name === event.name);
          if (index !== -1) this.callSteps.splice(index, 1);
        }
        if (store.meta("appCallStartedAt")) store.setMeta("appCallActivityAt", String(Date.now()));
      }
      if (run.superseded) return;
      if (event.type === "lead") {
        // What the caller has heard of this turn so far was a line before a lookup, not its answer: newer words still win.
        run.leads++;
        run.heard = false;
        if (this.voiceRuns.at(-1) !== run && !run.silenced) {
          run.silenced = true;
          run.stop.abort();
          this.unheardSince = Math.min(this.unheardSince ?? Infinity, run.startedAt);
        }
        return;
      }
      const answer = event.type === "text" && !event.transient;
      if (run.silenced && !(answer && isOutcome(event.delta))) {
        if (answer) run.dropped += event.delta;
        return;
      }
      run.speak(event);
      if (run.silenced) run.speak({ type: "text", delta: " ", transient: true });
    }, lead, () => {
      if (run.superseded) return false;
      run.started = true;
      run.startedAt = Date.now();
      // A change read back in a held answer was never heard: the full question is asked again.
      if (this.unheardSince !== undefined) {
        forgetPendingSince(store, this.unheardSince);
        this.unheardSince = undefined;
      }
      return true;
    }, run.stop.signal)
      .finally(() => {
        run.finished = true;
        this.voiceRuns = this.voiceRuns.filter(other => other !== run);
        this.callSteps.length = 0;
        if (store.meta("appCallStartedAt")) store.setMeta("appCallActivityAt", String(Date.now()));
        // Overtaken by newer words before the caller heard it: the next turn sees their words as unanswered.
        if (run.silenced && run.dropped.trim()) store.forgetReply(run.dropped);
      });
    void run.done.then(() => {
      if (this.listener === listener) this.listener = undefined;
      listener.close();
      // A change the caller said yes to is filed for approval during the call: its card goes to the client's Slack channel.
      this.ctx.waitUntil(this.deliverApprovals(store, run.startedAt)
        .catch(error => console.error("call approval card failed", error instanceof Error ? error.name : typeof error)));
      // A change their yes itself approved gets its one-line note there instead.
      if (store.meta("spokenYeses")) this.ctx.waitUntil(this.settleSpokenYeses(store));
    });
    return readable;
  }

  /** A check-in's wait: stay on the line until the latest running turn is done, or give up after a while and leave its answer for the next request. */
  private async hold(listener: Listener, last: VoiceRun): Promise<void> {
    let timer: number | null = null;
    await Promise.race([last.done, new Promise<void>(resolve => { timer = setTimeout(resolve, this.checkInWaitMs); })]);
    clearTimeout(timer);
    if (!last.finished) listener.write({ type: "text", delta: STILL_WORKING });
    if (this.listener === listener) this.listener = undefined;
    listener.close();
  }

  /** Gives a voice turn's event to whoever is on the line; spoken answer words nobody can hear are kept for the next request. */
  private say(store: Store, run: VoiceRun, event: TurnEvent): void {
    const answer = event.type === "text" && !event.transient && event.delta.trim() !== "";
    const leads = run.leads;
    if (this.listener && !this.listener.lost) this.listener.write(event, () => this.keep(store, run, event), answer ? () => {
      if (run.leads === leads) run.heard = true;
    } : undefined);
    else this.keep(store, run, event);
  }

  /** `heard`: the caller already heard the start of this answer, so the rest is still owed to them. */
  private keep(store: Store, from: Pick<VoiceRun, "inputId" | "heard" | "startedAt">, event: TurnEvent): void {
    if (event.type !== "text" || event.transient) return;
    store.setMeta("unheard", (store.meta("unheard") ?? "") + event.delta);
    store.setMeta("unheardId", from.inputId);
    store.setMeta("unheardPart", from.heard ? "1" : "");
    store.setMeta("unheardSince", String(from.startedAt));
  }

  /**
   * Queues one turn behind whatever runs here and answers through `emit` (a `done` or `error` event ends it); never rejects.
   * `lead`: a voice turn that follows words the caller has just heard, so a space separates them. `overtaken`: stops the turn.
   */
  private enqueue(store: Store, client: ClientConfig, agent: AgentTemplate, request: TurnRequest, emit: (event: TurnEvent) => void, lead = false, claim?: () => boolean, overtaken?: AbortSignal): Promise<void> {
    // Tasks the agent handed over with start_in_background; they start once the reply is done, so the call never waits for the work.
    const tasks: { text: string; request?: TurnDeps["request"] }[] = [];
    const queuedAt = Date.now();
    const run = this.queue.then(async () => {
      // The caller has spoken again since this request was accepted: only their newest words are answered.
      if (claim && !claim()) return { status: "stopped", text: "" } satisfies TurnResult;
      // A job in this conversation (typed chat) owns it: the call cannot start a second loop beside it.
      if (request.voice && jobBusy(store)) {
        emit({ type: "text", delta: JOB_RUNNING_SPOKEN });
        return { status: "stopped", text: JOB_RUNNING_SPOKEN } satisfies TurnResult;
      }
      if (lead) emit({ type: "text", delta: " ", transient: true });
      const onCall = request.voice === true && request.conversationId.startsWith("phone-");
      // Whose yes on this call can approve a change (ToolDefinition.spokenYes): one of the client's approved callers (checked
      // here as well as where the call came in), on the line of the agent its people work with, who is exactly one of those
      // people and may approve. The channel is where the note goes in place of the card.
      const named = client.phone?.spokenApprovalAgent === agent.id && onCall && client.slack?.channel && client.slack.agent === agent.id && request.caller && Object.values(approvedCallers(this.env, client)).includes(request.caller)
        ? client.slack.people.filter(person => person.name === request.caller) : [];
      const approver = named.length === 1 && client.approvers?.includes(named[0].id) ? named[0] : undefined;
      const extra: Partial<TurnDeps> = request.voice ? {
        startInBackground: (text, request) => {
          if (Number(store.meta("callJobs") || 0) + tasks.length >= MAX_QUEUED) throw new ToolError("Too many jobs were started on this call. Tell the caller to try again in a few minutes.", true);
          tasks.push({ text, request });
        },
        briefing: this.freshBriefing(store),
        overtaken,
        progressAfterMs: this.progressAfterMs,
        ackAfterMs: this.ackAfterMs,
        // Calls of a client that reports to Slack: the card is posted before she says it is waiting there.
        ...(client.slack?.channel && onCall ? { postApproval: (id: string) => this.postApprovalCard(store, id) } : {}),
        ...(approver ? {
          prepareSpoken: (id, settingsHash) => {
            store.setMeta("conversation", request.conversationId);
            this.saveSpokenYes(store, id, { id, by: approver.id, name: approver.name, settingsHash, tries: 0 });
            store.setMeta("spokenYesAt", String(Date.now() + SPOKEN_YES_RETRY_MS));
            // The caller invokes this inside the intent transaction; arm after that synchronous transaction completes.
            return Promise.resolve().then(() => this.arm(store));
          },
          approveSpoken: (id, run) => this.approveSpoken(store, client, id,
            (_client, _agent, _conversation, _id, approve, reason, hash, plan) => run(approve, reason, hash, plan)),
        } satisfies Partial<TurnDeps> : {}),
      } : {};
      extra.request = request.request ?? { id: request.input.id, text: ownWords(request.input.text), at: queuedAt };
      extra.teacher = chatTeacher(request);
      await this.register(store, client.id, agent.id, request.conversationId);
      let result: TurnResult;
      try {
        result = await this.runQueued(store, client, agent, request, emit, extra, queuedAt);
      } finally {
        // Handed over means accepted: a turn that failed after that still starts the job (ids are fixed, so a retry starts nothing twice).
        await this.startTasks(store, request, tasks);
      }
      // Only a signed-in person can teach; interrupted or refused turns do not count.
      if (request.userId && result.status === "replied") await this.queueReview(store, request.conversationId);
      return result;
    })
      .then(result => emit({ type: "done", status: result.status, text: result.text, ...(result.timing ? { timing: result.timing } : {}) }))
      .catch(error => {
        const safe = error instanceof ModelProtocolError || error instanceof SafeConfigurationError;
        // Our own errors never carry secrets or message text; log unexpected ones for diagnosis.
        if (!safe) console.error("turn failed", error instanceof Error ? `${error.name}: ${error.message}` : typeof error);
        emit({ type: "error", message: safe ? error.message : "Something went wrong. Please try again." });
      });
    this.queue = run;
    return run;
  }

  /** The call briefing set at the start of the call, while it is still current: under 15 minutes old, and no approved change has gone through on this call since (src/loop.ts execute). */
  private freshBriefing(store: Store): string | undefined {
    if (store.meta("briefingDropped")) return undefined;
    return Date.now() - Number(store.meta("briefingAt") || 0) < BRIEFING_FRESH_MS ? store.meta("briefing") || undefined : undefined;
  }

  /**
   * Called when a phone call starts (src/phone.ts): this object and its tables exist before the caller's first words arrive.
   * For a client with approved callers it also saves who phone-start matched the number to: completions() takes the caller
   * from here (callCaller), never from its request.
   * The call's model is fixed here, once, by its first start: one of the client's `callTestModels` (checked by phone-start)
   * for a test call, the client's own for every ordinary start. A call that has already started (an earlier start, its
   * practice request, or words that arrived with no start) keeps what it has, whatever a later start asks for. Returns the
   * test model the call is tied to, none for the client's own. A test start that finds another saves nothing, its caller
   * neither. Binds nothing.
   */
  async warm(caller?: string, testModel?: string): Promise<string | undefined> {
    const store = new Store(this.ctx.storage);
    const started = store.meta("callStarted") || store.meta("rehearsed") || this.voiceRuns.length > 0 || store.messages().length > 0;
    if (!started) {
      if (testModel) store.setMeta("testModel", testModel);
      store.setMeta("callStarted", "1");
    }
    const tied = store.meta("testModel");
    if (testModel && tied !== testModel) return tied;
    if (caller) {
      store.setMeta("caller", caller);
      store.setMeta("callerAt", String(Date.now()));
    }
    return tied;
  }

  /** The client as this call runs it: a call tied to a test model at its start (warm) answers with that model, every other call with the client's own. */
  private callClient(client: ClientConfig, store: Store): ClientConfig {
    const models = client.callTestModels ?? {};
    const name = store.meta("testModel") ?? "";
    return Object.hasOwn(models, name) ? { ...client, model: models[name] } : client;
  }

  /** The approved caller saved when this phone call started, while that call can still be running. None for a conversation that did not start as a phone call. */
  async callCaller(): Promise<string | undefined> {
    const store = new Store(this.ctx.storage);
    return Date.now() - Number(store.meta("callerAt") || 0) <= CALL_RECORD_MS ? store.meta("caller") || undefined : undefined;
  }

  /**
   * Warm-up of a phone call (src/briefing.ts): the data its first questions will ask for, used for 15 minutes. It does not
   * bind the conversation: whose it is is fixed by the call's first message (an approved caller's call belongs to the team).
   */
  async setBriefing(clientId: string, agentId: string, text: string): Promise<void> {
    if (!CLIENTS.find(c => c.id === clientId)?.agents.includes(agentId) || !AGENTS[agentId]) throw new Error("Unknown client or agent.");
    const store = new Store(this.ctx.storage);
    store.setMeta("briefing", text);
    store.setMeta("briefingAt", String(Date.now()));
  }

  /**
   * Reads a phone call's notes as the call starts (src/phone.ts), so its first reply finds them here as every later reply does
   * (measured 2026-11-13: 0.23 to 0.52 s of a first reply went on this read). They are used under the same rule: only while
   * under a minute old, and never for a plain yes. Binds nothing; a failure leaves the first reply to read them itself.
   */
  async keepCallNotes(clientId: string, agentId: string, userId?: string): Promise<void> {
    const { client, agent } = this.known(clientId, agentId);
    const asked = Date.now();
    const notes = await this.readNotes(client, agent, userId);
    // Notes a reply finished reading after this read began are at least as new: they stay.
    if (!this.callNotes || this.callNotes.at < asked) this.callNotes = notes;
  }

  /**
   * Sends a phone call's practice request (src/loop.ts rehearseTurn) once its briefing is in, with the notes and briefing the
   * first reply will have (its lessons are chosen without the caller's words, which are not here yet). One per call: a
   * repeated phone-start sends no second one. Not started once the caller has spoken, since their words are already on the
   * way to the model; one already under way is left to finish. It runs beside the turns, never in their queue, binds nothing
   * and saves nothing to the conversation but its own cost and the mark that it went.
   */
  async rehearse(clientId: string, agentId: string, conversationId: string, userId?: string): Promise<void> {
    const { client, agent } = this.known(clientId, agentId);
    const store = new Store(this.ctx.storage);
    if (store.meta("rehearsed")) return;
    store.setMeta("rehearsed", "1");
    const { facts, lessons, settings } = this.callNotes ?? await this.readNotes(client, agent, userId);
    if (this.voiceRuns.length || store.messages().length) return;
    await rehearseTurn({
      store, model: this.model, client: this.callClient(client, store), agent, catalog: this.catalog, conversationId, userId, bindings: brainBindings(this.env), desk: this.env.DESK,
      facts: facts.map(({ id, text }) => ({ id, text })), lessons: pickLessons(lessons, "").map(({ kind, text }) => ({ kind, text })), settings,
      modelKey: name => this.modelKey(name), emit: () => {}, briefing: this.freshBriefing(store),
    });
  }

  /** The client and agent a call-start request names; throws when they do not exist together. */
  private known(clientId: string, agentId: string): { client: ClientConfig; agent: AgentTemplate } {
    const client = CLIENTS.find(c => c.id === clientId);
    const agent = AGENTS[agentId];
    if (!client || !agent || !client.agents.includes(agent.id)) throw new Error("Unknown client or agent.");
    return { client, agent };
  }

  /**
   * Starts one job per task of a voice turn, each in its own conversation (`<call>-job-<n>`, same client, agent and person), so the
   * call stays free to talk while it runs. `n` is fixed per job id: a repeat of the turn finds the same job and starts nothing twice.
   */
  private async startTasks(store: Store, request: TurnRequest, tasks: { text: string; request?: TurnDeps["request"] }[]): Promise<void> {
    for (const [i, task] of tasks.entries()) {
      const input = { id: `${request.input.id}-bg${i + 1}`, text: task.text };
      let n = Number(store.meta(`callJob-${input.id}`) || 0);
      if (!n) {
        n = Number(store.meta("callJobs") || 0) + 1;
        store.setMeta("callJobs", String(n));
        store.setMeta(`callJob-${input.id}`, String(n));
      }
      const conversationId = `${request.conversationId}-job-${n}`;
      try {
        await this.env.CONVERSATIONS.get(this.env.CONVERSATIONS.idFromName(`${request.clientId}/${request.agentId}/${conversationId}`))
          .startJob({ clientId: request.clientId, agentId: request.agentId, conversationId, userId: request.userId, source: request.source, input, request: task.request ?? { id: input.id, text: "" } });
        const conversations = JSON.parse(store.meta("callJobConversations") || "[]") as string[];
        if (!conversations.includes(conversationId)) store.setMeta("callJobConversations", JSON.stringify([...conversations, conversationId]));
      } catch (error) {
        console.error("background job not started", error instanceof Error ? error.message.slice(0, 80) : typeof error);
      }
    }
  }

  /** Facts, every active lesson of this agent and its settings, read together. */
  private async readNotes(client: ClientConfig, agent: AgentTemplate, userId?: string) {
    const [facts, lessons, settings] = await Promise.all([
      // What another agent learned shows up here too.
      userId ? this.env.MEMORY.get(this.env.MEMORY.idFromName(memoryName(client.id, userId))).recent(FACTS_IN_PROMPT) : [],
      // Approved lessons reach every run, scheduled jobs included.
      this.env.LEARNING.get(this.env.LEARNING.idFromName(client.id)).active(agent.id),
      agentSettings(this.env, client, agent.id),
    ]);
    return { at: Date.now(), facts, lessons, settings };
  }

  /**
   * Chat/jobs read notes fresh. Calls also refresh lessons each reply so cross-chat teaching is eligible immediately.
   * A call's facts/settings may use notes from its start or previous reply for under a minute; a plain yes reads them
   * fresh because an approved change must see current settings.
   */
  private async runQueued(store: Store, client: ClientConfig, agent: AgentTemplate, request: TurnRequest, emit: (event: TurnEvent) => void, extra: Partial<TurnDeps> = {}, queuedAt?: number): Promise<TurnResult> {
    const began = Date.now();
    const kept = request.voice && !isYes(request.input.text) && this.callNotes && began - this.callNotes.at <= this.callNotesMs ? this.callNotes : undefined;
    const notes = kept ?? await this.readNotes(client, agent, request.userId);
    const { facts, settings } = notes;
    // Cross-chat teaching must be eligible on the next call reply too; only facts/settings use the call cache.
    const lessons = kept ? await this.env.LEARNING.get(this.env.LEARNING.idFromName(client.id)).active(agent.id) : notes.lessons;
    return runTurn({
      store, model: this.model, client: request.voice ? this.callClient(client, store) : client, agent, catalog: this.catalog, conversationId: request.conversationId,
      userId: request.userId, source: request.source, bindings: brainBindings(this.env), desk: this.env.DESK, facts: facts.map(({ id, text }) => ({ id, text })), emit,
      lessons: pickLessons(lessons, request.input.text).map(({ kind, text }) => ({ kind, text })),
      settings,
      modelKey: name => this.modelKey(name), voice: request.voice,
      ...(request.voice ? { afterWords: async () => { this.callNotes = await this.readNotes(client, agent, request.userId); } } : {}),
      ...extra,
      ...(request.voice && queuedAt !== undefined ? { waited: { queueMs: began - queuedAt, prepMs: Date.now() - began } } : {}),
    }, request.input);
  }

  /** The client, agent and bound store of a request; throws when they do not exist or the conversation belongs to someone else. */
  private open(request: Pick<TurnRequest, "clientId" | "agentId" | "userId">): { client: ClientConfig; agent: AgentTemplate; store: Store } {
    const { client, agent } = this.known(request.clientId, request.agentId);
    const store = new Store(this.ctx.storage);
    store.bind(client.id, agent.id, request.userId);
    return { client, agent, store };
  }

  /** Lists this conversation with the client's dashboard, so a staff reset can find it. Retried on the next turn if it fails. */
  private async register(store: Store, clientId: string, agentId: string, conversationId: string): Promise<void> {
    if (store.meta("registered")) return;
    try {
      await this.env.DASHBOARD.get(this.env.DASHBOARD.idFromName(clientId)).registerConversation(agentId, conversationId);
      store.setMeta("registered", "1");
    } catch (error) {
      console.error("conversation registry failed", error instanceof Error ? error.name : typeof error);
    }
  }

  /**
   * Staff reset only (POST /v1/agents/:agent/reset): erases this conversation completely. True when it had content.
   * Spend already counted here goes with it; the client's daily allowance lives in the Usage object and is untouched.
   */
  async wipe(clientId: string, agentId: string): Promise<boolean> {
    const owner = new Store(this.ctx.storage).meta("owner");
    if (owner !== undefined && owner !== `${clientId}/${agentId}`) throw new Error("Conversation belongs to another client or agent.");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return owner !== undefined;
  }

  /** The model's API key. The brain's one service credential: everything else lives in the desk Worker. */
  private modelKey(name: string): string {
    const value = this.env[name];
    if (typeof value !== "string" || !value) throw new SafeConfigurationError(`A required secret is not configured: ${name}.`);
    return value;
  }

  /** Carries out a person's approve/decline on one of this conversation's proposals, queued behind any running turn. */
  async decide(clientId: string, agentId: string, conversationId: string, actionId: string, approve: boolean, reason: string, proposedSettingsHash?: string, approvedPlan: string[] = [], spokenApproval = false): Promise<Decision> {
    const client = CLIENTS.find(c => c.id === clientId);
    const agent = AGENTS[agentId];
    if (!client || !agent) throw new Error("Unknown client or agent.");
    const store = new Store(this.ctx.storage);
    if (store.meta("owner") !== `${clientId}/${agentId}`) throw new Error("Conversation belongs to another client or agent.");
    const userId = store.meta("user") || undefined;
    store.setMeta("conversation", conversationId);
    const run = this.queue.then(async () => {
      const decision = await decideAction({
        store, model: this.model, client, agent, catalog: this.catalog, conversationId, userId, bindings: brainBindings(this.env), desk: this.env.DESK,
        settings: await agentSettings(this.env, client, agentId), modelKey: name => this.modelKey(name), emit: () => {}, spokenApproval,
      }, actionId, approve, reason, proposedSettingsHash, approvedPlan);
      // The agent was mid-task when it asked: whatever the outcome, its job carries on and tells the person.
      await this.resumeAfterDecision(store, actionId, decision.status).catch(error => console.error("resume after approval failed", error instanceof Error ? error.name : typeof error));
      return decision;
    });
    this.queue = run.catch(() => {});
    // A decline with a reason is the clearest correction there is: queue it until a review succeeds, and review now.
    if (!approve && reason.trim()) {
      store.setMeta("conversation", conversationId);
      store.setMeta("pendingDeclines", JSON.stringify([...pendingDeclines(store), { title: store.action(actionId)?.tool ?? "proposal", reason: reason.trim() }]));
      this.ctx.waitUntil(run.then(() => this.review(store, conversationId)).catch(() => {}));
    }
    return run;
  }

  /** Owner reads do not wait for running work; backfill is idempotent. */
  async stuck(clientId: string, agentId: string, conversationId: string, userId: string) {
    const store = new Store(this.ctx.storage);
    const owner = store.meta("owner");
    if (owner === undefined) return { steps: [] };
    if (owner !== `${clientId}/${agentId}` || store.meta("user") !== userId) throw new Error("Conversation belongs to another person.");
    const steps = (await Promise.all(store.actions("uncertain").map(action =>
      stuckStep(action, this.catalog[action.tool], agentId, conversationId, { clientId, bindings: toolBindings(brainBindings(this.env)) })
    ))).filter(step => step !== undefined);
    const dashboard = this.env.DASHBOARD.get(this.env.DASHBOARD.idFromName(clientId));
    for (const step of steps) {
      await dashboard.putStuck(adminStuckStep(step, store.meta("user") || undefined, store.meta(`action-source-${step.actionId}`) as TurnDeps["source"]));
      // A concurrent check may have cleared it while the backfill was in flight.
      if (store.action(step.actionId)?.status !== "uncertain") await dashboard.removeStuck(agentId, conversationId, step.actionId);
    }
    await this.register(store, clientId, agentId, conversationId);
    return { steps };
  }

  /** Internal admin reconciliation only: never binds or registers a conversation, and never waits for its queue. */
  async currentStuck(clientId: string, agentId: string, conversationId: string): Promise<AdminStuckStep[]> {
    if (!this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length) return [];
    const owner = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'owner'").toArray()[0]?.value;
    if (owner === undefined) return [];
    if (owner !== `${clientId}/${agentId}`) throw new Error("Conversation belongs to another client or agent.");
    const store = new Store(this.ctx.storage);
    const actions = store.actions("uncertain");
    const steps = await Promise.all(actions.map(action =>
      stuckStep(action, this.catalog[action.tool], agentId, conversationId, { clientId, bindings: toolBindings(brainBindings(this.env)) })
    ));
    return steps.filter(step => step !== undefined).map(step =>
      adminStuckStep(step, store.meta("user") || undefined, store.meta(`action-source-${step.actionId}`) as TurnDeps["source"]));
  }

  /** Legacy approval ownership comes only from this chat's persisted binding, never its caller-chosen id. */
  async approvalOrigin(clientId: string, agentId: string, conversationId: string): Promise<Pick<AdminStuckStep, "requestedBy" | "source">> {
    if (!this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length) return legacyRequestOrigin(conversationId);
    const store = new Store(this.ctx.storage);
    const userId = store.meta("owner") === `${clientId}/${agentId}` ? store.meta("user") || undefined : undefined;
    return legacyRequestOrigin(conversationId, userId === SLACK_USER ? undefined : userId);
  }

  async checkStuck(clientId: string, agentId: string, conversationId: string, actionId: string, person: string, admin: boolean) {
    const { client, agent } = this.known(clientId, agentId);
    const store = new Store(this.ctx.storage);
    if (store.meta("owner") !== `${clientId}/${agentId}` || !admin && store.meta("user") !== person) {
      return { status: 404, body: { error: "Not found" } };
    }
    if (loadJob(store)?.status === "running" || loadQueue(store).length > 0) {
      return { status: 409, body: { error: "This chat is busy with another task right now. Try again when it has finished." } };
    }
    const run = this.queue.then(async () => {
      // A staff reset may have changed ownership while this check waited behind a plain turn.
      if (store.meta("owner") !== `${clientId}/${agentId}` || !admin && store.meta("user") !== person) {
        return { status: 404, body: { error: "Not found" } };
      }
      return checkStuckAction({
        store, model: this.model, client, agent, catalog: this.catalog, conversationId,
        userId: store.meta("user") || undefined, bindings: brainBindings(this.env), desk: this.env.DESK,
        settings: await agentSettings(this.env, client, agentId), modelKey: name => this.modelKey(name), emit: () => {},
      }, actionId, person);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * A decision on a proposal resumes the job that waits for it, with a runtime note saying what happened (approved and done, failed,
   * declined, stale), so the agent can tell the person. No job waiting (the proposal came from a voice turn): an approval that went
   * through starts one, as the one-off follow-up did before. Marked per action, so a repeated decision starts nothing twice.
   */
  private async resumeAfterDecision(store: Store, actionId: string, status: Decision["status"]): Promise<void> {
    const marker = `resumed-${actionId}`;
    if (status === "missing" || store.meta(marker)) return;
    const said = {
      done: "A person approved it and it went through. Continue with the next step of your work.",
      failed: "A person approved it but it did not go through. Tell them plainly what happened and what happens next.",
      uncertain: "A person approved it but the result is uncertain. Do not repeat it; tell them a person will check.",
      declined: "A person declined it. Tell them plainly, then ask what they would like instead or carry on with whatever does not need it.",
      stale: "It was not run because the settings changed after it was proposed. Tell them and offer to propose it again.",
    }[status];
    const text = `[Runtime note, not from the user] ${store.action(actionId)?.tool ?? "request"} (${actionId}): ${said}`;
    const job = loadJob(store);
    if (job?.status === "needs_approval") {
      // Other proposals of the same job still wait: it resumes after the last one is decided.
      if (store.actions("awaiting_approval").some(action => action.createdAt >= job.startedAt)) return;
      saveJob(store, { ...job, status: "running", segment: job.segment + 1, input: { id: `${job.id}#${job.segment + 1}`, text }, dueAt: Date.now(), error: undefined });
    } else if (status === "done") {
      this.submit(store, { id: `approved-${actionId}`, text }, store.meta(`action-request-${actionId}`), store.meta(`action-source-${actionId}`) as TurnDeps["source"]);
    } else {
      return;
    }
    store.setMeta(marker, "1");
    await this.arm(store);
  }

  /**
   * POST .../jobs: starts a job for the message, or queues it behind the running one. Deduped by message id: the same id
   * returns the same job and starts nothing. The segments run from the alarm, not from this request.
   */
  async startJob(request: TurnRequest): Promise<{ job: JobView; queued?: true; slackEngaged?: true }> {
    const { client, store } = this.open(request);
    await this.register(store, client.id, request.agentId, request.conversationId);
    store.setMeta("conversation", request.conversationId);
    if (request.slack) {
      const { addressed, ...target } = request.slack;
      store.setMeta("slack", JSON.stringify(target));
      // A thread she was talked to in (or a DM) also hears about failures; channel chatter never does.
      if (addressed || !target.threadTs) store.setMeta("slackEngaged", "1");
    }
    // Stamped when first received and kept: a message queued behind a job is as old as its arrival, not as its turn. One sent
    // while a job is still busy here is marked `queued`: it cannot answer a question that job has not asked yet.
    const busy = jobBusy(store);
    const trusted = request.request ?? { id: request.input.id, text: ownWords(request.input.text) };
    if (!store.meta(`user-request-${trusted.id}`)) store.setMeta(`user-request-${trusted.id}`, JSON.stringify({ ...trusted, at: trusted.at ?? Date.now(), ...(busy ? { queued: true } : {}) }));
    if (!store.meta(`job-teacher-${request.input.id}`) && !store.meta(`job-source-${request.input.id}`)) {
      store.setMeta(`job-teacher-${request.input.id}`, JSON.stringify(chatTeacher(request) ?? null));
    }
    const { job, queued } = this.submit(store, request.input, trusted.id, request.source ?? "other");
    await this.arm(store);
    // Slack: whether this thread is one she was talked to in or answered in (src/slack.ts reacts 👀 on those).
    const engaged = request.slack && store.meta("slackEngaged") ? { slackEngaged: true as const } : {};
    return queued ? { job, queued: true, ...engaged } : { job, ...engaged };
  }

  /** GET .../job: the conversation's latest job, or null. Only the person who owns the conversation may read it. */
  async jobState(clientId: string, agentId: string, userId: string): Promise<{ job: JobView | null }> {
    const store = new Store(this.ctx.storage);
    const owner = store.meta("owner");
    if (owner === undefined) return { job: null };
    if (owner !== `${clientId}/${agentId}` || store.meta("user") !== userId) throw new Error("Conversation belongs to another person.");
    const job = loadJob(store);
    return { job: job ? jobView(job, loadQueue(store).length) : null };
  }

  /** No identity is inferred from a call id, even when it resembles the signed person's id. */
  async callState(clientId: string, agentId: string, conversationId: string, userId: string) {
    const store = new Store(this.ctx.storage);
    if (store.meta("owner") !== `${clientId}/${agentId}` || store.meta("user") !== userId || !store.meta("appCallStartedAt")) return null;
    const ownJob = await this.callJobState(clientId, agentId, userId);
    const childIds = JSON.parse(store.meta("callJobConversations") || "[]") as string[];
    const jobs = await Promise.all(childIds.map(async id => {
      const job = await this.env.CONVERSATIONS.get(this.env.CONVERSATIONS.idFromName(`${clientId}/${agentId}/${id}`))
        .callJobState(clientId, agentId, userId);
      return job ? { conversationId: id, ...job } : null;
    }));
    return {
      conversationId, startedAt: Number(store.meta("appCallStartedAt")), lastActivityAt: Number(store.meta("appCallActivityAt")),
      turnRunning: this.voiceRuns.length > 0, current: this.callSteps.at(-1)?.label ?? null,
      jobs: [...(ownJob ? [{ conversationId, ...ownJob }] : []), ...jobs.filter(job => job !== null)],
    };
  }

  async callJobState(clientId: string, agentId: string, userId: string) {
    const store = new Store(this.ctx.storage);
    if (store.meta("owner") !== `${clientId}/${agentId}` || store.meta("user") !== userId) return null;
    const job = loadJob(store);
    if (!job) return null;
    const view = jobView(job, loadQueue(store).length);
    if (job.status === "stopped") delete view.error;
    const approvalId = job.status === "needs_approval"
      ? store.actions("awaiting_approval").find(action => action.createdAt >= job.startedAt)?.id : undefined;
    return { ...view, done: view.steps.filter(step => step.state === "done").length, ...(approvalId ? { approvalId } : {}) };
  }

  private submit(store: Store, input: JobInput, requestId?: string, source?: TurnDeps["source"]): { job: JobView; queued: boolean } {
    const job = loadJob(store);
    const queue = loadQueue(store);
    if (job && queue.some(waiting => waiting.id === input.id)) return { job: jobView(job, queue.length), queued: true };
    if (job?.id === input.id || store.input(input.id)) {
      if (!job) throw new Error("This message id was already used.");
      return { job: jobView(job, queue.length), queued: false };
    }
    if (requestId) store.setMeta(`job-request-${input.id}`, requestId);
    store.setMeta(`job-source-${input.id}`, source ?? "other");
    if (job && (isActive(job) || queue.length)) {
      if (queue.length >= MAX_QUEUED) throw new Error("Too many messages are waiting behind the running job.");
      saveQueue(store, [...queue, input]);
      return { job: jobView(job, queue.length + 1), queued: true };
    }
    const started = newJob(input, store.spentUsd());
    saveJob(store, started);
    return { job: jobView(started, 0), queued: false };
  }

  /** Sets the one alarm to the soonest of the job's next segment and the review's quiet time. */
  private async arm(store: Store): Promise<void> {
    const due = [Number(store.meta("reviewAt") || 0) || undefined, jobDueAt(store), store.meta("slackDecisions") ? Date.now() : undefined,
      store.meta("spokenYeses") ? Number(store.meta("spokenYesAt") || 0) : undefined]
      .filter((at): at is number => at !== undefined);
    if (due.length) await this.ctx.storage.setAlarm(Math.max(Math.min(...due), Date.now()));
    else await this.ctx.storage.deleteAlarm();
  }

  /** `at` 0: no review is due. */
  private async armReview(store: Store, at: number): Promise<void> {
    store.setMeta("reviewAt", String(at));
    await this.arm(store);
  }

  /** Runs the next segment of the job, queued behind anything else on this conversation. Alarm only. */
  private async advanceJob(store: Store): Promise<void> {
    this.driving = true;
    try {
      const run = this.queue.then(() => this.runSegment(store));
      this.queue = run.catch(() => {});
      await run;
    } finally {
      this.driving = false;
    }
  }

  /**
   * One segment of the job: the loop runs until the agent ends it with a final reply (done), asks to check back later
   * (waiting), proposes something a person must approve (needs_approval) or hits a limit or an error. A running job
   * found by an alarm while nothing is driving it was interrupted by a restart: it runs again from its saved input,
   * and the loop's recovery answers any tool call left open.
   */
  private async runSegment(store: Store): Promise<void> {
    const [clientId, agentId] = (store.meta("owner") ?? "").split("/");
    const client = CLIENTS.find(c => c.id === clientId);
    const agent = AGENTS[agentId ?? ""];
    if (!client || !agent) return;
    const now = Date.now();
    let job = loadJob(store);
    if (!job || !isActive(job)) {
      // The last job ended: the next queued message starts its own.
      const [next, ...rest] = loadQueue(store);
      if (!next) return;
      saveQueue(store, rest);
      job = newJob(next, store.spentUsd(), now);
    } else if (job.status === "waiting") {
      if (job.dueAt > now) return;
      job = { ...job, status: "running", segment: job.segment + 1, input: { id: `${job.id}#${job.segment + 1}`, text: checkBackNote(job.reason) } };
    } else if (job.status !== "running") {
      return;
    }

    const limits = limitsFor(client, agent);
    const limit = job.usedMs >= JOB_MAX_MS ? `${JOB_MAX_MS / 60_000}-minute time limit` : store.spentUsd() - job.spendBase >= limits.maxJobCostUsd ? `$${limits.maxJobCostUsd} spending limit` : undefined;
    if (limit) return this.endJob(store, job, "stopped", `I stopped this job because it reached its ${limit}. Tell me how you'd like to continue.`, true);

    saveJob(store, { ...job, status: "running", tool: undefined, dueAt: now + SEGMENT_WATCHDOG_MS });
    const conversationId = store.meta("conversation") ?? "";
    const userId = store.meta("user") || undefined;
    const segmentMs = Math.min(limits.maxTurnActiveMs, JOB_MAX_MS - job.usedMs);
    const patch = (change: (current: Job) => void) => {
      const current = loadJob(store);
      if (current?.id !== job!.id) return;
      change(current);
      saveJob(store, current);
    };
    let result: TurnResult | undefined;
    let failure: string | undefined;
    const teacher: TurnDeps["teacher"] = JSON.parse(store.meta(`job-teacher-${job.id}`) || "null") ?? undefined;
    try {
      result = await this.runQueued(store, client, agent, { clientId: client.id, agentId: agent.id, conversationId, userId, source: store.meta(`job-source-${job.id}`) as TurnDeps["source"], input: job.input }, () => {}, {
        request: JSON.parse(store.meta(`user-request-${store.meta(`job-request-${job.id}`) ?? ""}`) || "null") ?? { id: job.id, text: "" },
        teacher: teacher?.inputId === job.input.id ? teacher : undefined,
        job: { update: progress => patch(current => applyProgress(current, progress)), tool: label => patch(current => { current.tool = label ?? undefined; }) },
        limits: { maxCostUsd: job.spendBase + limits.maxJobCostUsd, maxTurnActiveMs: segmentMs },
        budgetMessage: `I stopped this job because it reached its $${limits.maxJobCostUsd} spending limit. Tell me how you'd like to continue.`,
      });
    } catch (error) {
      const safe = error instanceof ModelProtocolError || error instanceof SafeConfigurationError;
      if (!safe) console.error("job segment failed", error instanceof Error ? `${error.name}: ${error.message}` : typeof error);
      failure = `I hit a problem: ${safe ? error.message : "something went wrong."} Ask me to try again.`;
    }

    // Progress and tool labels changed the saved job while the segment ran.
    const current = loadJob(store);
    if (!current || current.id !== job.id) return;
    current.usedMs += Date.now() - now;
    if (failure || !result) return this.endJob(store, current, "failed", failure ?? "", true);
    if (result.status === "stopped") return this.endJob(store, current, "stopped", result.text, false);
    if (store.actions("awaiting_approval").some(action => action.createdAt >= current.startedAt)) {
      saveJob(store, { ...current, status: "needs_approval", tool: undefined });
      await this.deliverSlack(store, current.input.id, result.text);
      await this.deliverApprovals(store, current.startedAt);
    } else if (result.status === "waiting") {
      const wait = result.checkBack!.seconds * 1000;
      saveJob(store, { ...current, status: "waiting", tool: undefined, dueAt: Date.now() + wait, usedMs: current.usedMs + wait, reason: result.checkBack!.reason });
    } else {
      await this.endJob(store, current, "done", result.text);
    }
  }

  /** Ends the job. `note` puts `say` in the chat as the agent's line (when the loop has not already said it). */
  private async endJob(store: Store, job: Job, status: "done" | "failed" | "stopped", say = "", note = false): Promise<void> {
    if (note && say) store.note(say);
    saveJob(store, { ...job, status, finishedAt: Date.now(), tool: undefined, ...(status !== "done" && say ? { error: say } : {}) });
    const userId = store.meta("user");
    if (status === "done" && userId) await this.queueReview(store, store.meta("conversation") ?? "");
    // A reply the agent chose goes to Slack; a runtime failure or stop only where she was talked to (never under chatter).
    await this.deliverSlack(store, job.input.id, say, status !== "done");
    // Nobody can open this job's chat (a caller's work is anonymous): its last words go on the dashboard instead.
    if (!userId && say.trim()) {
      const [clientId, agentId] = (store.meta("owner") ?? "").split("/");
      // A job id repeats across calls (it comes from the caller's words), so the card id carries this conversation's own id.
      const next = say.trim().endsWith("?") ? `\n\nTo answer, call or message ${AGENTS[agentId ?? ""]?.name ?? "the agent"} again.` : "";
      try {
        await this.env.DASHBOARD.get(this.env.DASHBOARD.idFromName(clientId)).post({
          id: `job-${this.ctx.id}-${job.id}`.slice(0, 128), agent: agentId, kind: "status", title: `From a call: ${job.task ?? job.input.text}`.slice(0, 120),
          summary: `${say.slice(0, 3900)}${next}`, dataJson: "{}", conversationId: store.meta("conversation") ?? "", clientId,
        });
      } catch (error) {
        console.error("call job card failed", error instanceof Error ? error.name : typeof error);
      }
    }
  }

  /**
   * Where this conversation answers in Slack, and its client: the thread it came from, or for a phone call of a client whose
   * calls report to Slack (SlackConfig.channel), that channel (`call`). Undefined otherwise.
   */
  private slackThread(store: Store): { client: ClientConfig; target: SlackTarget; call?: true } | undefined {
    const client = CLIENTS.find(c => c.id === (store.meta("owner") ?? "").split("/")[0]);
    if (!client) return undefined;
    const saved = store.meta("slack");
    if (saved) return { client, target: JSON.parse(saved) as SlackTarget };
    const channel = client.slack?.channel;
    return channel && (store.meta("conversation") ?? "").startsWith("phone-") ? { client, target: { channel }, call: true } : undefined;
  }

  /** Posts the job's reply to its Slack thread, once per `key`. A channel message that was not for the agent (NO_REPLY) posts nothing. */
  private async deliverSlack(store: Store, key: string, text: string, onlyEngaged = false): Promise<void> {
    const thread = this.slackThread(store);
    const reply = text.trim();
    if (!thread || !reply || reply === NO_REPLY || reply.startsWith(`${NO_REPLY}\n`) || store.meta(`slackSent-${key}`)) return;
    // A call's work always reports back: the caller was talking to her.
    if (onlyEngaged && !thread.call && !store.meta("slackEngaged")) return;
    if (await this.slackPost(thread.client, thread.target, { text: toSlackText(thread.call ? `*From a call:* ${reply}` : reply) }, `reply-${key}`)) {
      store.setMeta(`slackSent-${key}`, "1");
      store.setMeta("slackEngaged", "1");
    }
  }

  /** Posts an Approve / Decline card for each of this job's proposals not posted yet. A change a caller's yes approved has no card. */
  private async deliverApprovals(store: Store, since: number): Promise<void> {
    const spoken = this.spokenYeses(store);
    for (const action of store.actions("awaiting_approval").filter(a => a.createdAt >= since && !spoken.some(yes => yes.id === a.id))) await this.postApprovalCard(store, action.id);
  }

  /** Posts one proposal's Approve / Decline card where this conversation answers in Slack, once; whether it is posted. */
  private async postApprovalCard(store: Store, actionId: string): Promise<boolean> {
    if (store.meta(`slackCard-${actionId}`)) return true;
    const thread = this.slackThread(store);
    if (!thread) return false;
    const raw = await this.env.DASHBOARD.get(this.env.DASHBOARD.idFromName(thread.client.id)).approvalJson(actionId).catch(() => undefined);
    if (!raw) return false;
    const approval = JSON.parse(raw) as { title: string; summary: string };
    if (!await this.slackPost(thread.client, thread.target, { text: `Needs your OK: ${approval.title}`, blocks: approvalBlocks(actionId, approval) }, `card-${actionId}`)) return false;
    store.setMeta(`slackCard-${actionId}`, "1");
    return true;
  }

  private spokenYeses(store: Store): SpokenYes[] {
    return JSON.parse(store.meta("spokenYeses") || "[]") as SpokenYes[];
  }

  /** Saves one spoken yes, or forgets it (`yes` absent). Empty means none: arm() sets an alarm for any other value. */
  private saveSpokenYes(store: Store, id: string, yes?: SpokenYes): void {
    const rest = this.spokenYeses(store).filter(other => other.id !== id);
    store.setMeta("spokenYeses", yes || rest.length ? JSON.stringify(yes ? [...rest, yes] : rest) : "");
  }

  /**
   * Takes a caller's yes as the approval of a change filed on this call (TurnDeps.approveSpoken). It is saved before anything
   * is decided, so whatever fails or restarts from here on is finished by the alarm, once: deciding is idempotent and an
   * approved write never runs twice. False: the approval is not this conversation's, so nothing is approved and it keeps its card.
   */
  private async approveSpoken(store: Store, client: ClientConfig, id: string, run: RunDecision): Promise<boolean> {
    const yes = this.spokenYeses(store).find(candidate => candidate.id === id);
    if (!yes) return false;
    try {
      if (!await this.decideSpokenYes(store, client, yes, run)) {
        if (store.action(yes.id)?.status === "awaiting_approval") this.saveSpokenYes(store, yes.id, { ...yes, card: true });
        return false;
      }
    } catch (error) {
      console.error("spoken yes not finished", error instanceof Error ? error.message.slice(0, 120) : typeof error);
    }
    return true;
  }

  /**
   * Records one spoken yes as that person's approval and carries the change out through `run`, under the settings fingerprint
   * and write plan stored when it was filed. Undefined, and nothing decided, when the approval under that id is not the one
   * this conversation filed for that action (action ids from before they carried the conversation repeat across calls).
   */
  private async decideSpokenYes(store: Store, client: ClientConfig, yes: SpokenYes, run: RunDecision): Promise<DecisionReply | undefined> {
    let action = store.action(yes.id);
    const [owner, agentId] = (store.meta("owner") ?? "").split("/");
    const agent = AGENTS[agentId ?? ""];
    if (yes.card || !action || owner !== client.id || !agent) return undefined;
    const dashboard = this.env.DASHBOARD.get(this.env.DASHBOARD.idFromName(client.id));
    let raw = await dashboard.approvalJson(yes.id);
    let filed = raw ? JSON.parse(raw) as Approval : undefined;
    if (filed && (filed.agent !== agent.id || filed.conversationId !== store.meta("conversation") || filed.tool !== action.tool)) return undefined;
    if (action.status === "intent" || (action.status === "awaiting_approval" && filed?.status === "pending")) {
      const prepare = async () => prepareSpokenAction({
        store, model: this.model, client, agent, catalog: this.catalog, conversationId: store.meta("conversation") ?? "",
        userId: store.meta("user") || undefined, source: (store.meta(`action-source-${yes.id}`) as TurnDeps["source"]) ?? "phone", bindings: brainBindings(this.env), desk: this.env.DESK,
        settings: await agentSettings(this.env, client, agent.id), modelKey: name => this.modelKey(name), emit: () => {},
      }, yes.id, yes.settingsHash);
      // Only recovery can find an intent still being filed. It waits behind a live turn before touching it.
      if (action.status === "intent") {
        const filing = this.queue.then(prepare);
        this.queue = filing.catch(() => {});
        if (!await filing) return undefined;
      } else if (!await prepare()) return undefined;
      action = store.action(yes.id);
      raw = await dashboard.approvalJson(yes.id);
      filed = raw ? JSON.parse(raw) as Approval : undefined;
    }
    if (!this.spokenYeses(store).some(candidate => candidate.id === yes.id && !candidate.card) || !action || !filed || filed.agent !== agent.id || filed.conversationId !== store.meta("conversation") || filed.tool !== action.tool) return undefined;
    if (action.status === "awaiting_approval" && !await dashboard.settingsHash(yes.id)) return undefined;
    if (filed.status === "pending") {
      // Admission may have changed since this candidate was saved. A candidate is not an approval grant.
      const people = client.slack?.people.filter(person => person.name === yes.name) ?? [];
      if (client.phone?.spokenApprovalAgent !== agent.id || client.slack?.agent !== agent.id || !client.slack.channel
        || !(store.meta("conversation") ?? "").startsWith("phone-") || !Object.values(approvedCallers(this.env, client)).includes(yes.name)
        || people.length !== 1 || people[0].id !== yes.by || !client.approvers?.includes(yes.by)) return undefined;
    }
    // The note in Slack reports it: no follow-up job says it a second time (resumeAfterDecision).
    store.setMeta(`resumed-${yes.id}`, "1");
    const reply = await decideApproval(this.env, client, yes.id, true, yes.by, SPOKEN_YES_REASON, run);
    // A decline may already have been recorded (or raced this yes). Preserve it and tell this turn, never promise a retry.
    if (reply.status === 409 && reply.body) {
      const recorded = JSON.parse(reply.body) as Approval;
      if (recorded.status === "declined") await run(client.id, agent.id, filed.conversationId, yes.id, false, recorded.reason ?? "");
    }
    return reply;
  }

  /**
   * Finishes every spoken yes still saved, after the call's turn and from the alarm, one sweep at a time. Each is decided again:
   * a finished decision returns its recorded outcome, one that was approved but never ran is carried out now, one cut off
   * mid-write is reconciled, never repeated. Then its note is posted and it is forgotten. What fails stays saved for the alarm.
   */
  private settleSpokenYeses(store: Store): Promise<void> {
    this.settling = this.settling.then(async () => {
      const client = CLIENTS.find(c => c.id === (store.meta("owner") ?? "").split("/")[0]);
      for (const yes of this.spokenYeses(store)) {
        const finished = !client || await this.settleSpokenYes(store, client, yes).catch(error => {
          console.error("spoken yes not finished", error instanceof Error ? error.message.slice(0, 120) : typeof error);
          return false;
        });
        // Read again: the live turn may have removed an ineligible candidate meanwhile.
        const current = this.spokenYeses(store).find(other => other.id === yes.id);
        if (current) this.saveSpokenYes(store, yes.id, finished ? undefined : { ...current, tries: current.tries + 1 });
      }
      const left = this.spokenYeses(store);
      if (left.length) store.setMeta("spokenYesAt", String(Date.now() + Math.min(SPOKEN_YES_RETRY_MS * 2 ** Math.min(...left.map(yes => yes.tries)), 60 * 60_000)));
      await this.arm(store);
    }).catch(error => console.error("spoken yes sweep failed", error instanceof Error ? error.name : typeof error));
    return this.settling;
  }

  /** Finishes one candidate: ineligible changes keep their card; every decided outcome gets its durable one-line audit note. */
  private async settleSpokenYes(store: Store, client: ClientConfig, yes: SpokenYes): Promise<boolean> {
    if (yes.card) {
      const raw = await this.env.DASHBOARD.get(this.env.DASHBOARD.idFromName(client.id)).approvalJson(yes.id);
      const filed = raw ? JSON.parse(raw) as Approval : undefined;
      if (!filed || filed.status === "pending") return this.postApprovalCard(store, yes.id);
      // A person may have decided it on the dashboard while delivery was down. Finish that recorded decision, not a stale card.
      const decided = { ...yes };
      delete decided.card;
      this.saveSpokenYes(store, yes.id, decided);
      yes = decided;
    }
    const reply = await this.decideSpokenYes(store, client, yes, (clientId, agentId, conversationId, id, approve, reason, hash, plan) => this.decide(clientId, agentId, conversationId, id, approve, reason, hash, plan, true));
    const approval = reply?.body ? JSON.parse(reply.body) as Approval : undefined;
    const thread = this.slackThread(store);
    if (!approval) {
      const action = store.action(yes.id);
      if (action?.status === "awaiting_approval") {
        this.saveSpokenYes(store, yes.id, { ...yes, card: true });
        return this.postApprovalCard(store, yes.id);
      }
      if (action?.status === "failed") {
        if (!thread) return false;
        return this.slackPost(thread.client, thread.target, { text: `*Not done on a call, on ${yes.name}'s yes:* ${this.catalog[action.tool]?.label ?? "Calendar change"}. ${action.error ?? "It did not go through."}` }, `note-${yes.id}`);
      }
      return true;
    }
    if (!thread) return false;
    // A result that says `connected: false` changed nothing.
    const caveat = store.action(yes.id)?.result?.data.note;
    const done = approval.status === "done" && store.action(yes.id)?.result?.data.connected !== false;
    const name = approval.decidedBy === yes.by ? yes.name
      : client.slack?.people.find(person => person.id === approval.decidedBy)?.name ?? approval.decidedBy ?? yes.name;
    const text = done && caveat ? `*Result on a call, on ${name}'s yes:* ${approval.title}. ${String(caveat)}`
      : done ? `*Done on a call, on ${name}'s yes:* ${approval.title}`
      : approval.status === "uncertain" ? `*Not confirmed on a call, on ${name}'s yes:* ${approval.title}. Please check it before anyone tries again.`
      : approval.status === "failed" || approval.status === "done" ? `*Not done on a call, on ${name}'s yes:* ${approval.title}. It did not go through.`
      : undefined;
    return !text || this.slackPost(thread.client, thread.target, { text }, `note-${yes.id}`);
  }

  /**
   * A press on one of this conversation's Slack cards (src/slack.ts, already checked to be an approver's). Saved and decided
   * from the alarm, which has no 30-second cap, so a long approved write still finishes its approval and rewrites the card.
   * A crash before it is done leaves it saved, and the next alarm decides it again (deciding is idempotent).
   */
  async queueSlackDecision(clientId: string, agentId: string, decision: SlackDecision): Promise<void> {
    const store = new Store(this.ctx.storage);
    if (store.meta("owner") !== `${clientId}/${agentId}`) throw new Error("Conversation belongs to another client or agent.");
    const pending = JSON.parse(store.meta("slackDecisions") || "[]") as SlackDecision[];
    if (!pending.some(p => p.id === decision.id) && pending.length < 20) store.setMeta("slackDecisions", JSON.stringify([...pending, decision]));
    await this.arm(store);
  }

  private async runSlackDecisions(store: Store): Promise<void> {
    const client = CLIENTS.find(c => c.id === (store.meta("owner") ?? "").split("/")[0]);
    for (let pending = JSON.parse(store.meta("slackDecisions") || "[]") as SlackDecision[]; client && pending.length; pending = JSON.parse(store.meta("slackDecisions") || "[]") as SlackDecision[]) {
      const next = pending[0];
      let reply: DecisionReply | undefined;
      try {
        const raw = await this.env.DASHBOARD.get(this.env.DASHBOARD.idFromName(client.id)).approvalJson(next.id);
        const card = raw ? JSON.parse(raw) as Approval : undefined;
        reply = card && (card.choices || card.tool === "propose_go_live")
          ? { status: 400, body: JSON.stringify({ error: "Open the app to pick an option and decide this request." }) }
          : await decideApproval(this.env, client, next.id, next.approve, next.decidedBy, "", (...args) => this.decide(...args));
      } catch (error) {
        console.error("slack decision failed", error instanceof Error ? error.message.slice(0, 120) : typeof error);
      }
      // Empty means none: arm() sets an alarm for any non-empty value, so "[]" would wake it forever.
      store.setMeta("slackDecisions", pending.length > 1 ? JSON.stringify(pending.slice(1)) : "");
      await (reply
        ? updateCard(next.responseUrl, decisionText(reply, next.approve, next.name, next.title), "replace")
        : updateCard(next.responseUrl, `:warning: ${next.title}`, "replace", next.blocks.length ? retryBlocks(next.blocks) : undefined));
    }
    if (!client) store.setMeta("slackDecisions", "");
  }

  /** Counts an answered message from a person; reviews after every few, and sets a quiet-time alarm for the rest. */
  private async queueReview(store: Store, conversationId: string): Promise<void> {
    store.setMeta("conversation", conversationId);
    const turns = Number(store.meta("turnsSinceReview") || 0) + 1;
    store.setMeta("turnsSinceReview", String(turns));
    if (turns >= REVIEW_EVERY_TURNS) {
      this.ctx.waitUntil(this.review(store, conversationId));
    } else {
      await this.armReview(store, Date.now() + REVIEW_AFTER_QUIET_MS);
    }
  }

  /**
   * The one alarm serves the job (its next segment or wake-up, also after a restart) and the review (the conversation went
   * quiet: review whatever the person said since the last review). Their due times are stored (`reviewAt`, the job's `dueAt`).
   */
  async alarm(): Promise<void> {
    const store = new Store(this.ctx.storage);
    // A long segment is still running in this object: it re-arms the alarm itself when it ends.
    if (this.driving) {
      const job = loadJob(store);
      if (job?.status === "running") saveJob(store, { ...job, dueAt: Date.now() + SEGMENT_WATCHDOG_MS });
      return;
    }
    await this.runSlackDecisions(store);
    if (store.meta("spokenYeses")) await this.settleSpokenYeses(store);
    const now = Date.now();
    const due = jobDueAt(store);
    const jobRuns = due !== undefined && due <= now;
    if (jobRuns) await this.advanceJob(store);
    // The alarm serves both: a review runs when its own time has come, or when the alarm was not for a job.
    const reviewAt = Number(store.meta("reviewAt") || 0);
    if (!jobRuns || (reviewAt && reviewAt <= now)) {
      store.setMeta("reviewAt", "0");
      const conversationId = store.meta("conversation");
      if (conversationId && (Number(store.meta("turnsSinceReview") || 0) || pendingDeclines(store).length)) await this.review(store, conversationId);
    }
    await this.arm(store);
  }

  /**
   * Reviews what was said since the last successful review, plus pending decline reasons. The stretch is marked
   * reviewed only after the review finishes; a failed or postponed one keeps it and tries again later. Messages and
   * declines that arrive while the model is working stay queued for the next review.
   */
  private async review(store: Store, conversationId: string): Promise<void> {
    const [clientId, agentId] = (store.meta("owner") ?? "").split("/");
    const client = CLIENTS.find(c => c.id === clientId);
    const agent = AGENTS[agentId ?? ""];
    if (!client || !agent) return;
    // One review at a time per conversation; a stale marker (crash) is ignored after a while.
    if (Date.now() - Number(store.meta("reviewing") || 0) < REVIEW_RUNNING_MS) return;
    store.setMeta("reviewing", String(Date.now()));
    try {
      const after = Number(store.meta("reviewedSeq") || 0);
      // Oldest unreviewed lines first, in chunks the reviewer reads whole (room left for its "PERSON: " labels); the
      // cursor moves only past what it read.
      const { lines, more } = store.transcriptAfter(after, REVIEW_LINES, MAX_TRANSCRIPT_CHARS - REVIEW_LINES * 10);
      const turnsAtStart = Number(store.meta("turnsSinceReview") || 0);
      const declines = pendingDeclines(store);
      const result = lines.length || declines.length
        ? await reviewConversation({ client, agent, conversationId, lines, declines, bindings: brainBindings(this.env), model: this.model, modelKey: name => this.modelKey(name) })
        : { complete: true };
      if (!result.complete) throw new Error("review postponed");
      // Remove only what this review covered; anything newer stays queued.
      if (lines.length) store.setMeta("reviewedSeq", String(lines.at(-1)!.seq));
      // A chunk that left later lines unread keeps the conversation queued, so the alarm reviews the rest.
      const turnsLeft = Math.max(more ? 1 : 0, Number(store.meta("turnsSinceReview") || 0) - turnsAtStart);
      const declinesLeft = pendingDeclines(store).slice(declines.length);
      store.setMeta("turnsSinceReview", String(turnsLeft));
      store.setMeta("pendingDeclines", JSON.stringify(declinesLeft));
      await this.armReview(store, turnsLeft || declinesLeft.length ? Date.now() + REVIEW_AFTER_QUIET_MS : 0);
    } catch (error) {
      console.error("review failed", error instanceof Error ? error.message.slice(0, 80) : typeof error);
      await this.armReview(store, Date.now() + REVIEW_RETRY_MS);
    } finally {
      store.setMeta("reviewing", "");
    }
  }

  /** Summary for staff and debugging; no message contents. */
  async state(clientId: string, agentId: string) {
    const store = new Store(this.ctx.storage);
    const owner = store.meta("owner");
    if (owner !== undefined && owner !== `${clientId}/${agentId}`) throw new Error("Conversation belongs to another client or agent.");
    const testModel = store.meta("testModel");
    return {
      messages: store.messages().length,
      spentUsd: store.spentUsd(),
      actions: store.actions().map(({ id, tool, status, attempts, error }) => ({ id, tool, status, attempts, error })),
      // A test call names the model it was tied to at its start, so whoever compares models can tell which one answered.
      ...(testModel ? { testModel } : {}),
    };
  }

  /**
   * What the person and the agent said, from the transcript compaction never touches: the latest `limit` lines before
   * `before`, oldest first, with `more` when older lines exist. Only the person who owns the conversation may read it.
   */
  async history(clientId: string, agentId: string, userId: string, limit: number, before?: number) {
    const store = new Store(this.ctx.storage);
    const owner = store.meta("owner");
    if (owner === undefined) return { messages: [], more: false };
    if (owner !== `${clientId}/${agentId}` || store.meta("user") !== userId) throw new Error("Conversation belongs to another person.");
    const { lines, more } = store.transcript(limit, before);
    return { messages: lines, more };
  }
}
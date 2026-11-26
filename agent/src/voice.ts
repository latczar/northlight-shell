import type { ChatMessage, JsonObject } from "./contracts";

// Spoken lines and call-flow checks for the voice endpoint.

// ElevenLabs holds a short line until more text arrives (measured: 46 characters held until the answer, 55+ spoken in ~0.6 s),
// so every fixed line said while the caller waits is a full sentence of 55+ characters.
/** Text shorter than this is not spoken until more arrives: a shorter line before a lookup does not fill the wait. */
export const SPOKEN_AT_ONCE = 55;
/** Said once per turn while the caller waits, only when the agent's own words have not filled the wait. Varied by message id. */
export const ACKNOWLEDGEMENTS = ["Let me check that for you now, it'll just take a moment. ", "Sure, let me look that up for you, it'll just take a moment. "];
/** Said right after the agent's own line before a lookup when that line is too short to be spoken yet: together they are long enough. */
export const MOMENTS = ["Just give me one moment… ", "One moment while I look… "];
/** Said at once to a caller who asks "hello?" while their request is still being worked on. */
export const STILL_CHECKING = ["I'm still checking on your request, it'll just be a moment longer. ", "Still working on that for you, it'll just be a moment longer. "];
/** Said when the running work has not finished after the wait; its answer is spoken on the caller's next request. */
export const STILL_WORKING = "It's taking a little longer than usual. I'm still on it, and I'll tell you as soon as I have it.";
/** Said to a caller who has gone quiet (ElevenLabs sends "..." for them): a full sentence, so it is spoken at once. */
export const SILENCE_SPOKEN = "I'm here whenever you're ready. Ask me anything about the website.";
/** A job owns the conversation (typed chat): the call cannot start a second loop beside it. */
export const JOB_RUNNING_SPOKEN = "I'm still working on your last request. Give me a moment, then ask again.";
/** Seconds of lookup with no answer before the one progress line is spoken. */
export const PROGRESS_AFTER_MS = 8_000;
/** Silence after the caller's words before the one acknowledgement is spoken: a quicker answer, or the agent's own line before a lookup, needs no filler. */
export const ACK_AFTER_MS = 2_000;
/** Said when a plain yes started the read-back work as a background job. */
export const STARTED_SPOKEN = "Great, I've started on it. You'll see it on your dashboard.";
/** Said when a plain yes filed the read-back change for a person's approval. */
export const APPROVAL_FILED_SPOKEN = "Done. It's waiting on your dashboard for approval.";
/** The same two for a client whose calls report to its Slack channel (SlackConfig.channel). */
export const STARTED_SLACK_SPOKEN = "Great, I've started on it. I'll post it in Slack.";
export const APPROVAL_FILED_SLACK_SPOKEN = "Done. It's waiting in Slack for your OK.";
/** The change is filed, but its Slack card could not be posted: say so rather than send them to look for it. */
export const APPROVAL_NOT_POSTED_SPOKEN = "I've filed it for approval, but I couldn't post it in Slack just now, so nothing will change yet. Please let the team know.";
/** Said when the caller's yes itself approved the change (ToolDefinition.spokenYes) and it went through. */
export const APPROVED_DONE_SPOKEN = "Done. It's all set.";
/** The caller's yes is saved as the approval, but the change could not be finished during the turn: it is finished later, and Slack is told how it went. */
export const APPROVED_NOT_FINISHED_SPOKEN = "I have your yes, but I couldn't finish it just now. I'll keep trying, and I'll post in Slack how it went.";
/** Lines that tell the caller their work was started, filed or done: always said, even when newer words overtook the turn. */
const OUTCOMES = [STARTED_SPOKEN, APPROVAL_FILED_SPOKEN, STARTED_SLACK_SPOKEN, APPROVAL_FILED_SLACK_SPOKEN, APPROVAL_NOT_POSTED_SPOKEN, APPROVED_DONE_SPOKEN, APPROVED_NOT_FINISHED_SPOKEN];
export const isOutcome = (text: string): boolean => OUTCOMES.includes(text.trim());
/** How long a check-in waits for the running work before it gives up and leaves the answer for the next request. */
export const CHECK_IN_WAIT_MS = 20_000;
/** The call's briefing counts as current for this long. */
export const BRIEFING_FRESH_MS = 15 * 60_000;

/** One of `lines`, the same one for the same `seed`. */
export function pick(lines: string[], seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return lines[hash % lines.length];
}

const normalise = (text: string) => text.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();

const CHECK_INS = [
  "hello", "hello hello", "hi", "hey", "are you there", "you there", "still there", "are you still there", "you still there",
  "anyone there", "anybody there", "hello are you there", "hello you there", "hello are you still there", "can you hear me", "hello can you hear me",
];
/** Whether the caller only said "hello?"-like words: checking the line, not asking something new. */
export const isCheckIn = (text: string): boolean => CHECK_INS.includes(normalise(text));
/** Whether `later` is `earlier` again, alone or with more words after it: ElevenLabs resends the growing sentence while the caller keeps talking. */
export const repeats = (later: string, earlier: string): boolean => {
  const before = normalise(earlier);
  const after = normalise(later);
  return before !== "" && (after === before || after.startsWith(`${before} `));
};

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|correct|right|absolutely|definitely|confirmed|confirm|i confirm|i approve|approved|approve it|go ahead|do it|please do|go for it|sounds good|thats right|that is right|thats correct)\b/;
const CHANGES_MIND = /\b(no|nope|not|wait|but|actually|instead|change|rather|dont)\b/;

/** A short plain yes: anything longer or with a "but" is a correction that needs reading back again. */
export const isYes = (text: string): boolean => {
  const words = normalise(text.replace(/['’]/g, ""));
  return words.split(" ").length <= 6 && YES.test(words) && !CHANGES_MIND.test(words.replace(YES, ""));
};

const SOCIAL = /^(no|nope|nah|hi|hello|hey|thanks|thank you|thankyou|cheers|bye|goodbye|good bye|see you|talk soon|great|perfect|cool|awesome|nice|got it|gotcha|okay thanks|ok thanks|thats all|thats it|nothing else|never mind|nevermind)\b/;
const THANKS_OR_BYE = /\b(thanks|thank you|thankyou|cheers|bye|goodbye)\b/;
/** Whether the caller asked or requested something (acknowledged at once), not a yes, a short no, thanks, goodbye or greeting. */
export const wantsLookup = (text: string): boolean => {
  const words = normalise(text.replace(/['’]/g, ""));
  const count = words.split(" ").length;
  // A short social line is not a request ("Gotcha. Thanks, Iris."); a longer one ("No, change the footer to…") is.
  return count >= 2 && !isYes(text) && !isCheckIn(text) && !(count <= 4 && SOCIAL.test(words)) && !(count <= 6 && THANKS_OR_BYE.test(words));
};

/** The one change read back on a call: what will run, and where in the conversation it was proposed (the seq of the reply that called propose_change). */
export interface PendingChange { task: string; tool?: string; args?: JsonObject; after: number; at: number; }
/** A read-back stays valid this long. */
export const PENDING_TTL_MS = 5 * 60_000;

/** The question to ask: the full read-back the first time, one short "<task> — yes?" when the same change is asked again after an interruption. */
export const readBackSentence = (task: string, again = false): string => {
  const plain = task.trim().replace(/[.!?\s]+$/, "");
  return again ? `${plain} — yes?` : `Just to confirm: ${plain}?`;
};

/**
 * Whether the caller confirmed this pending change: the caller's first words after the proposal are a plain yes, and the agent
 * said something in the reply that proposed it (or after). The agent's exact words are not compared. Runtime notes are not the caller.
 * Words beside a tool call do not count: on a call those are a line said before a lookup, never the read-back question.
 */
export function confirmedChange(rows: { seq: number; message: ChatMessage }[], pending: PendingChange, now: number): boolean {
  if (now - pending.at > PENDING_TTL_MS) return false;
  const callers = rows.filter(({ seq, message }) => seq > pending.after && message.role === "user" && !message.content.startsWith("[Runtime note"));
  // Anything the caller said between the proposal and the yes (a no, a new question) means the yes answers something else.
  const said = callers.length === 1 ? callers[0] : undefined;
  if (said?.message.role !== "user" || !isYes(said.message.content)) return false;
  return rows.some(({ seq, message }) => seq >= pending.after && seq < said.seq && message.role === "assistant" && !message.tool_calls?.length && typeof message.content === "string" && message.content.trim() !== "");
}

/**
 * What a voice reply has said so far, across its steps: a repeated sentence is never said twice, a read-back question ends
 * the reply, and so does a closing offer ("Anything else?").
 */
export interface SpokenState {
  sentences: Set<string>;
  /** propose_change ran in this reply. */
  readBack: boolean;
  /** The read-back question or a closing offer was reached: nothing follows it. */
  closed: boolean;
  /** A closing offer may be said in this reply: the call has not had one lately, and this is not its first reply. */
  offer?: boolean;
  /** One was said in this reply. */
  offered?: boolean;
  /** How many sentences the reply had said when its current step began: what a step says after a lookup is counted from here. */
  stepFrom?: number;
}

// The whole sentence is the offer: "Anything else?", "Is there anything else I can help you with today?", "What else can I do
// for you?". A question about the work that merely starts the same way ("Anything else you want on the home page?",
// "Anything else I should know?") is not one, and is never touched. A net under the call rule, not a full list: an offer
// worded another way (with the caller's name in it, say) is simply spoken.
const LEAD = "(and |so |okay |ok |now |well |alright |all right |great |sure |got it |perfect |no problem )*";
const TAIL = "( today| right now| for now| for today| at the moment| then)?$";
const CLOSING_OFFERS = [
  new RegExp(`^${LEAD}((is|was) there |will there be |(do|did) you (need|want)( help with)? |would you like( help with)? |can i (help|do|get|assist)( you)?( with)? |need )?`
    + `anything (else|more)( i can (help|do|get|assist)( you)?( with| for you)?| (that )?you need( help with)?| youd like( help with)?| you would like( help with)?| for you| on your mind)?${TAIL}`),
  new RegExp(`^${LEAD}(what|how) else can i (help|do|assist)( you)?( with| for you)?${TAIL}`),
];
/** "Anything else?" and its variants: an offer to do more, said to close an answer. */
export const isClosingOffer = (sentence: string): boolean => {
  const words = sentence.toLowerCase().replace(/['’]/g, "").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  return sentence.trim().endsWith("?") && CLOSING_OFFERS.some(offer => offer.test(words));
};
/** A call's one closing offer counts for this long after it was said: a conversation still going, or talked in again, later may have another. */
export const CLOSING_OFFER_MS = 30 * 60_000;

/** Keeps or drops one sentence of a voice reply (see SentenceGate). */
export const voiceFilter = (state: SpokenState) => (sentence: string): boolean => {
  if (state.closed) return false;
  const key = sentence.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (key && state.sentences.has(key)) return false;
  if (isClosingOffer(sentence)) {
    // Measured 2026-11-13: after one, the model sometimes starts its answer over ("…Anything else? Nothing changed."). Whatever follows is not said.
    state.closed = true;
    // Left out when the call has had its one or has only just begun. Kept when it is all this step says (a line said before a
    // lookup is not an answer): the caller is never left with nothing.
    if (!state.offer && state.sentences.size > (state.stepFrom ?? 0)) return false;
    state.offered = true;
  }
  if (key) state.sentences.add(key);
  if (state.readBack && sentence.trim().endsWith("?")) state.closed = true;
  return true;
};

/** The tool refusal that makes the agent read the change back first. */
export const READ_BACK_FIRST = "Not run: the caller has not confirmed this change. Call propose_change with the task (for a tool that needs approval, also its tool name and exact args), say the sentence it returns to the caller as your whole reply, and wait for their plain yes. Then call this tool again with no task and, for an approval tool, the same args. A no or a correction means call propose_change again with the new task and ask again.";

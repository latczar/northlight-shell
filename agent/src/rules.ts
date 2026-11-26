// Output rules: things an agent must never say to a client ("never promise a price"). Every sentence
// is checked before it is streamed to chat or spoken, so a broken rule is never seen or heard.
// shortcut: rules are regular expressions, so a rephrasing can slip past; add a model-based check if that happens.

export interface OutputRule {
  id: string;
  /** Case-insensitive regular expression. */
  pattern: string;
  /** Told to the agent when it breaks the rule. */
  message: string;
}

export interface CompiledRule { id: string; re: RegExp; message: string }

export function compileRules(rules: OutputRule[]): CompiledRule[] {
  return rules.map(rule => {
    try { return { id: rule.id, re: new RegExp(rule.pattern, "iu"), message: rule.message }; }
    catch { throw new Error(`Output rule "${rule.id}" has an invalid pattern.`); }
  });
}

export function brokenRule(text: string, rules: CompiledRule[]): CompiledRule | undefined {
  return rules.find(rule => rule.re.test(text));
}

/** Sentence ends: . ! ? … followed by whitespace, or a line break. */
const SENTENCE_END = /[.!?…]["')\]]*\s+|\n+/u;

/**
 * Holds streamed text until a sentence is complete, checks it, then passes it on. Stops passing text
 * on at the first sentence that breaks a rule. With no rules and no `keep` filter, text passes straight through.
 * A sentence `keep` rejects is dropped (`dropped` says one was).
 */
export class SentenceGate {
  private buffer = "";
  /** Text that was checked and passed on. */
  delivered = "";
  dropped = false;
  violation?: CompiledRule;

  constructor(private readonly rules: CompiledRule[], private readonly emit: (delta: string) => void, private readonly keep?: (sentence: string) => boolean) {}

  push(delta: string): void {
    if (this.violation) return;
    if (!this.rules.length && !this.keep) { this.pass(delta); return; }
    this.buffer += delta;
    let match: RegExpExecArray | null;
    while (!this.violation && (match = SENTENCE_END.exec(this.buffer))) {
      const end = match.index + match[0].length;
      this.check(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end);
    }
  }

  finish(): void {
    if (!this.violation && this.buffer) this.check(this.buffer);
    this.buffer = "";
  }

  private check(sentence: string): void {
    const rule = brokenRule(sentence, this.rules);
    if (rule) this.violation = rule;
    else if (this.keep && !this.keep(sentence)) this.dropped = true;
    else this.pass(sentence);
  }

  private pass(text: string): void {
    this.delivered += text;
    this.emit(text);
  }
}

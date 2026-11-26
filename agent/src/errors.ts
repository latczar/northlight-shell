import type { ToolResult, Usage } from "./contracts";

/** Local configuration problem found before any external call; nothing was billed or executed. */
export class SafeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeConfigurationError";
  }
}

/** Context still too large after compaction; refused before contacting the provider. */
export class ModelContextLimitError extends Error {
  constructor() {
    super("This conversation is too long to continue. Start a new conversation.");
    this.name = "ModelContextLimitError";
  }
}

/** Cost allowance exhausted; refused before contacting the provider. */
export class ModelBudgetLimitError extends Error {
  constructor() {
    super("This conversation reached its cost limit.");
    this.name = "ModelBudgetLimitError";
  }
}

/** The client's daily model spend cap is used up; refused before contacting the provider. */
export class DailyCapError extends Error {
  constructor() {
    super("I've reached today's usage limit for this account. A person on the team has been notified; please try again tomorrow.");
    this.name = "DailyCapError";
  }
}

/** The provider answered in a shape we cannot trust. */
export class ModelProtocolError extends Error {
  /** `status`: the provider's HTTP status, when it refused the request outright. */
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ModelProtocolError";
  }
}

/** The reply hit its output limit. It was billed: `usage` is what the provider counted, when it said. */
export class ModelCutOffError extends ModelProtocolError {
  constructor(readonly usage?: Usage) {
    super("The model reply was cut off by its output limit.");
  }
}

/** Newer words from the caller overtook a voice turn before they heard any of its answer: its model work stops, nothing is said. */
export class OvertakenError extends Error {
  constructor() {
    super("Overtaken by newer words.");
    this.name = "OvertakenError";
  }
}

/** A safe tool failure. `definite` means the failed step has no uncertain effect; `result` retains earlier confirmed effects. */
export class ToolError extends Error {
  constructor(message: string, readonly definite = false, readonly result?: ToolResult) {
    super(message);
    this.name = "ToolError";
  }
}

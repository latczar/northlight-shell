/** Only the caller can supply the Services request that starts an editorial draft. */
export function hasServicesRequest(turns: { who: string; text: string }[]): boolean {
  return turns.some(turn => turn.who === "You" && /\bservices\b/i.test(turn.text));
}

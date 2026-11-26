import "server-only";
import { createHash, createHmac } from "node:crypto";

// Passes the agent accepts (agent/src/user-auth.ts):
// `<personId>.<expiry unix seconds>.<hex HMAC-SHA256 of "[purpose\n]clientId\npersonId\nexpiry">`, valid up to 24 h.

const PERSON_ID = /^[A-Za-z0-9_:-]{1,128}$/;

export function signPass(secret: string, clientId: string, personId: string, expiresAt: number, purpose?: "approve" | "admin"): string {
  if (!PERSON_ID.test(personId)) throw new Error("Person ids may only use letters, digits, _ : -");
  if (!Number.isInteger(expiresAt)) throw new Error("expiresAt must be whole unix seconds");
  const signature = createHmac("sha256", secret)
    .update(`${purpose ? `${purpose}\n` : ""}${clientId}\n${personId}\n${expiresAt}`)
    .digest("hex");
  return `${personId}.${expiresAt}.${signature}`;
}

/** Signature the brain checks on `PUT /v1/access/approvers`: `v1=<hex HMAC-SHA256 of "access\n<clientId>\n<timestamp>\n<sha256 hex of body>">`. */
export function signAccessUpdate(secret: string, clientId: string, timestamp: number, body: string): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  return `v1=${createHmac("sha256", secret).update(`access\n${clientId}\n${timestamp}\n${bodyHash}`).digest("hex")}`;
}

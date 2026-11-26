// A user pass proves which person a request is about. The client's own server signs it with the
// client's signing key, so a browser or phone widget cannot claim to be someone else.
// Format: `<userId>.<expiry unix seconds>.<hex HMAC-SHA256 of "[purpose\n]clientId\nuserId\nexpiry">`.
// Memory passes have no purpose; dashboard passes use "dashboard", so neither works as the other.

const MAX_LIFETIME_SECONDS = 24 * 60 * 60;
const USER_ID = /^[A-Za-z0-9_:-]{1,128}$/;

async function key(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

function signed(purpose: string | undefined, clientId: string, userId: string, expiresAt: number): Uint8Array {
  return new TextEncoder().encode(`${purpose ? `${purpose}\n` : ""}${clientId}\n${userId}\n${expiresAt}`);
}

/** What the client's server runs; exported for tests and documentation. */
export async function signUserPass(secret: string, clientId: string, userId: string, expiresAt: number, purpose?: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await key(secret, "sign"), signed(purpose, clientId, userId, expiresAt));
  return `${userId}.${expiresAt}.${[...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Returns the person's id when the pass is valid for this client, purpose and time; otherwise undefined. */
export async function verifyUserPass(secret: string, clientId: string, pass: string, nowSeconds: number, purpose?: string): Promise<string | undefined> {
  const [userId, expiry, hex] = pass.split(".");
  if (pass.split(".").length !== 3 || !USER_ID.test(userId) || !/^\d{1,12}$/.test(expiry) || !/^[0-9a-f]{64}$/.test(hex)) return undefined;
  const expiresAt = Number(expiry);
  if (expiresAt <= nowSeconds || expiresAt > nowSeconds + MAX_LIFETIME_SECONDS) return undefined;
  const signature = Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16));
  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify("HMAC", await key(secret, "verify"), signature, signed(purpose, clientId, userId, expiresAt));
  return valid ? userId : undefined;
}

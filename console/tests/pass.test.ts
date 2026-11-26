import { describe, expect, it } from "vitest";
import { signAccessUpdate, signPass } from "@/lib/pass";

// Known answers computed outside this code (Python hmac) from the agent's message formats (agent/src/user-auth.ts and
// agent/src/access.ts). A change here means the agent would refuse every pass or access update.
const PERSON = "00000000-0000-4000-8000-000000000002";
const EXP = 1795459200;

describe("signPass", () => {
  it("signs a person's pass the way the agent checks it", () => {
    expect(signPass("secret-a", "kestrel", PERSON, EXP)).toBe(`${PERSON}.${EXP}.05d7e2576cd24d30b2f8f0f1928e2de49073bf7484b1b0735fd9f71a08296d0f`);
  });

  it("puts the purpose first for approver and admin passes", () => {
    expect(signPass("secret-a", "kestrel", PERSON, EXP, "approve")).toBe(`${PERSON}.${EXP}.34a93825c3a206273b3d2940b155fa848a9f7da62994de5786a6b2831644e1d1`);
    expect(signPass("secret-a", "kestrel", PERSON, EXP, "admin")).toBe(`${PERSON}.${EXP}.03f495cc62367d6d52cfc64e74635b9f116ff9b77d964eebbf4b347e96f088bc`);
  });

  it("refuses person ids that would break the pass's dotted format", () => {
    expect(() => signPass("s", "kestrel", "a.b", EXP)).toThrow();
    expect(() => signPass("s", "kestrel", "", EXP)).toThrow();
    expect(() => signPass("s", "kestrel", PERSON, 1.5)).toThrow();
  });
});

describe("signAccessUpdate", () => {
  it("signs the exact body the brain hashes", () => {
    const body = `{"version":3,"approvers":{"iris":["${PERSON}"]},"managers":{}}`;
    expect(signAccessUpdate("secret-b", "kestrel", EXP, body)).toBe("v1=b78d58f561be94044304e1e3f92416a1b6f30879cf85b3654f0cc1935b0fdc9c");
    expect(signAccessUpdate("secret-b", "kestrel", EXP, `${body} `)).not.toBe("v1=b78d58f561be94044304e1e3f92416a1b6f30879cf85b3654f0cc1935b0fdc9c");
  });
});

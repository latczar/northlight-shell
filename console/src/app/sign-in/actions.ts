"use server";

import { setTimeout as wait } from "node:timers/promises";
import { redirect } from "next/navigation";
import { safeNext } from "@/lib/safe-next";
import { supabaseServer } from "@/lib/server/supabase";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
// Every answer to a code request takes at least this long, so a quick answer does not tell whether an email went out.
// shortcut: a send slower than this still shows in the timing; sending after the answer (next/server after()) is the upgrade.
const ANSWER_MS = 1200;

export type CodeRequest = { ok: true; email: string } | { ok: false; error: string };

/**
 * Asks Supabase to email a sign-in code. Only existing accounts get one (`shouldCreateUser: false`). The words of the
 * answer do not say whether the address has an account: no account (422) and a per-address limit (429, which only an
 * existing account can hit) answer exactly like a sent code. An unexpected Supabase failure answers with its own words.
 */
export async function sendCode(emailRaw: string): Promise<CodeRequest> {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) return { ok: false, error: "Enter a full email address, like alex@example.com." };
  const started = Date.now();
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  const failed = error && error.status !== 429 && error.status !== 422 && error.code !== "otp_disabled" && error.code !== "signup_disabled";
  if (failed || error?.status === 429) console.error("sign-in code not sent", error?.code ?? error?.status);
  await wait(Math.max(0, ANSWER_MS - (Date.now() - started)));
  return failed ? { ok: false, error: "The code could not be sent. Try again in a minute." } : { ok: true, email };
}

export type CodeCheck = { ok: false; error: string };

/** Checks the code; on success the session cookies are set and the person goes on to `next` (a same-site path). */
export async function verifyCode(emailRaw: string, codeRaw: string, nextRaw: string): Promise<CodeCheck> {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  const token = String(codeRaw ?? "").replace(/\s+/g, "");
  if (!EMAIL.test(email)) return { ok: false, error: "Start again with your email address." };
  if (!/^\d{6,10}$/.test(token)) return { ok: false, error: "Enter the code from the email: 6 digits." };
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.verifyOtp({ email, token, type: "email" });
  if (error) {
    if (error.status === 429) return { ok: false, error: "Too many tries. Wait a minute, then try again." };
    return { ok: false, error: "That code is wrong or has expired. Check the newest email, or send a new code." };
  }
  redirect(safeNext(nextRaw));
}

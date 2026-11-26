"use server";

import { redirect } from "next/navigation";
import { safeNext } from "@/lib/safe-next";
import { supabaseServer } from "@/lib/server/supabase";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

export type SignInRefusal = { ok: false; error: string };

/**
 * Signs in with an email and password. On success the session cookies are set and the person goes on to `next` (a same-site
 * path). A wrong password and an unknown email get the same words, so the form cannot be used to find out who uses Northlight.
 */
export async function signIn(emailRaw: string, passwordRaw: string, nextRaw: string): Promise<SignInRefusal> {
  const email = String(emailRaw ?? "").trim().toLowerCase();
  const password = String(passwordRaw ?? "");
  if (!EMAIL.test(email)) return { ok: false, error: "Enter a full email address, like alex@example.com." };
  if (!password) return { ok: false, error: "Enter your password." };
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.status === 429) return { ok: false, error: "Too many tries. Wait a minute, then try again." };
    if (error.code !== "invalid_credentials") console.error("sign-in failed", error.code ?? error.status);
    return { ok: false, error: "That email and password don’t match. Check them and try again." };
  }
  redirect(safeNext(nextRaw));
}

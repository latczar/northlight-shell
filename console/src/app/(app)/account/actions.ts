"use server";

import { passwordProblem } from "@/lib/password";
import { actionViewer } from "@/lib/server/session";
import { supabaseServer } from "@/lib/server/supabase";

export type PasswordChange = { ok: true } | { ok: false; error: string; field: "password" | "confirm" };

/** Changes the signed-in person's own password. Their session stays signed in. */
export async function changePassword(passwordRaw: string, confirmRaw: string): Promise<PasswordChange> {
  const password = String(passwordRaw ?? "");
  const weak = passwordProblem(password);
  if (weak) return { ok: false, error: weak, field: "password" };
  if (password !== String(confirmRaw ?? "")) return { ok: false, error: "The two passwords don’t match.", field: "confirm" };
  const viewer = await actionViewer();
  if ("error" in viewer) return { ok: false, error: viewer.error, field: "password" };
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.updateUser({ password });
  if (!error) return { ok: true };
  if (error.code === "same_password") return { ok: false, error: "That is already your password. Choose a new one.", field: "password" };
  if (error.code === "weak_password") return { ok: false, error: "Choose a longer or less common password.", field: "password" };
  console.error("password change failed", error.code ?? error.status);
  return { ok: false, error: "Your password was not changed. Try again in a minute.", field: "password" };
}

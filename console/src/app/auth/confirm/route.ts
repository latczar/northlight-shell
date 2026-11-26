import type { NextRequest } from "next/server";
import { safeNext } from "@/lib/safe-next";
import { supabaseServer } from "@/lib/server/supabase";

/**
 * Finishes a sign-in link, should an email ever carry one (email and password on /sign-in is the way in):
 * `token_hash` + `type`, or Supabase's PKCE `code`. Either way, only same-site `next` paths.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const next = safeNext(params.get("next"));
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  const code = params.get("code");
  const supabase = await supabaseServer();

  let ok = false;
  if (tokenHash && (type === "magiclink" || type === "email")) ok = !(await supabase.auth.verifyOtp({ token_hash: tokenHash, type })).error;
  else if (code) ok = !(await supabase.auth.exchangeCodeForSession(code)).error;

  const target = ok ? next : `/sign-in?error=link&next=${encodeURIComponent(next)}`;
  // Relative, so the browser stays on the host it used (the cookies were set there).
  return new Response(null, { status: 303, headers: { location: target } });
}

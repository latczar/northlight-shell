import { sameSite } from "@/lib/server/session";
import { supabaseServer } from "@/lib/server/supabase";

export async function POST(request: Request) {
  if (!sameSite(request)) return Response.json({ error: "Cross-site request refused." }, { status: 403 });
  const supabase = await supabaseServer();
  // Local scope: signs out this browser only.
  await supabase.auth.signOut({ scope: "local" });
  return new Response(null, { status: 303, headers: { location: "/sign-in" } });
}

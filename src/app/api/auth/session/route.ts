import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function serverSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "";
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** توکن cookie را به کلاینت می‌دهد تا supabase.auth.setSession کند */
export async function GET(req: NextRequest) {
  try {
    const access = req.cookies.get("sb-access-token")?.value;
    const refresh = req.cookies.get("sb-refresh-token")?.value;

    if (!access || !refresh) {
      return NextResponse.json({ session: null, user: null });
    }

    const supabase = serverSupabase();
    const { data, error } = await supabase.auth.getUser(access);

    if (!error && data.user) {
      return NextResponse.json({
        session: { access_token: access, refresh_token: refresh },
        user: {
          id: data.user.id,
          email: data.user.email,
          user_metadata: data.user.user_metadata,
        },
      });
    }

    const { data: refreshed, error: rErr } = await supabase.auth.refreshSession({
      refresh_token: refresh,
    });
    if (!rErr && refreshed.session && refreshed.user) {
      const res = NextResponse.json({
        session: {
          access_token: refreshed.session.access_token,
          refresh_token: refreshed.session.refresh_token,
        },
        user: {
          id: refreshed.user.id,
          email: refreshed.user.email,
          user_metadata: refreshed.user.user_metadata,
        },
      });
      const maxAge = 60 * 60 * 24 * 7;
      res.cookies.set("sb-access-token", refreshed.session.access_token, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge,
      });
      res.cookies.set("sb-refresh-token", refreshed.session.refresh_token, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge,
      });
      return res;
    }

    return NextResponse.json({ session: null, user: null });
  } catch {
    return NextResponse.json({ session: null, user: null });
  }
}

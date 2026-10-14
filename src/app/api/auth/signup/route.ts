import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function POST(req: NextRequest) {
  try {
    const url = (
      process.env.NEXT_PUBLIC_SUPABASE_URL ||
      process.env.SUPABASE_URL ||
      ""
    ).trim();
    const key = (
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.SUPABASE_ANON_KEY ||
      ""
    ).trim();

    if (!url || !key) {
      return NextResponse.json(
        {
          error: "Missing env: URL or ANON_KEY empty on server",
          hasUrl: !!url,
          hasKey: !!key,
        },
        { status: 500 }
      );
    }

    if (!url.startsWith("https://") || url.includes("/rest/") || url.includes("/auth/")) {
      return NextResponse.json(
        {
          error: "Bad SUPABASE_URL format",
          urlPreview: url.slice(0, 60),
        },
        { status: 500 }
      );
    }

    const body = await req.json();
    const email = String(body.email || "").trim();
    const password = String(body.password || "");
    const name = String(body.name || "").trim();

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password required" }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
    }

    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: name ? { full_name: name } : undefined,
        emailRedirectTo: "https://alarm-chert.vercel.app",
      },
    });

    if (error) {
      return NextResponse.json(
        { error: error.message, code: (error as any).code || null },
        { status: 400 }
      );
    }

    const res = NextResponse.json({
      user: data.user
        ? {
            id: data.user.id,
            email: data.user.email,
            user_metadata: data.user.user_metadata,
          }
        : null,
      session: data.session
        ? {
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token,
          }
        : null,
      needsEmailConfirm: !data.session && !!data.user,
      message: data.session
        ? "ok"
        : "Account created. Check your email to confirm, then sign in.",
    });

    if (data.session) {
      const maxAge = 60 * 60 * 24 * 7;
      res.cookies.set("sb-access-token", data.session.access_token, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge,
      });
      res.cookies.set("sb-refresh-token", data.session.refresh_token, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge,
      });
    }

    return res;
  } catch (e: any) {
    return NextResponse.json(
      {
        error: e?.message || "Signup failed",
        name: e?.name || null,
        cause: e?.cause ? String(e.cause) : null,
      },
      { status: 500 }
    );
  }
}

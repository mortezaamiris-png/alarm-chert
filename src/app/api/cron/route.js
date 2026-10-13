/**
 * /api/cron — صدا زدن check-alarms
 */
import { NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req) {
  const auth = req.headers.get("authorization") || "";
  const secret = process.env.CRON_SECRET || "";
  const ok =
    !secret ||
    auth === `Bearer ${secret}` ||
    req.headers.get("x-vercel-cron") === "1";

  if (!ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const base =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";

  if (!base || !key) {
    return NextResponse.json(
      { error: "Missing SUPABASE_URL or key" },
      { status: 500 }
    );
  }

  const url = `${base.replace(/\/$/, "")}/functions/v1/check-alarms`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ source: "vercel-cron", t: Date.now() }),
    });
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return NextResponse.json(
      { ok: res.ok, status: res.status, data },
      { status: res.ok ? 200 : 502 }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e?.message || "cron failed" },
      { status: 500 }
    );
  }
}

export async function POST(req) {
  return GET(req);
}

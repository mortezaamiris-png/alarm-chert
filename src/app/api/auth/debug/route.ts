import { NextResponse } from "next/server";

export async function GET() {
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

  let health: any = null;
  let healthErr: any = null;

  try {
    if (!url) throw new Error("URL empty");
    const r = await fetch(`${url}/auth/v1/health`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      cache: "no-store",
    });
    health = {
      status: r.status,
      body: (await r.text()).slice(0, 300),
    };
  } catch (e: any) {
    healthErr = {
      message: e?.message || String(e),
      name: e?.name || null,
      cause: e?.cause ? String(e.cause) : null,
    };
  }

  return NextResponse.json({
    urlHost: url,
    urlLength: url.length,
    keyLength: key.length,
    keyStartsWith: key.slice(0, 12),
    keyEndsWith: key.slice(-8),
    health,
    healthErr,
  });
}

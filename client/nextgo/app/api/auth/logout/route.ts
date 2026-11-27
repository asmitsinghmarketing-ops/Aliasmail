import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb } from "@/db";
import { sessions } from "@/db/schema";
import { safeReturnTo, SESSION_COOKIE, sha256 } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) await getDb().delete(sessions).where(eq(sessions.tokenHash, await sha256(token)));
  return new Response(null, { status: 303, headers: {
    Location: new URL(safeReturnTo(request.nextUrl.searchParams.get("returnTo") || "/"), request.url).toString(),
    "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    "Cache-Control": "no-store",
  } });
}

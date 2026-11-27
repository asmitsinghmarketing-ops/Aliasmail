import { lt } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { NextRequest } from "next/server";
import { getDb } from "@/db";
import { oauthStates } from "@/db/schema";
import { pkceChallenge, randomToken, safeReturnTo } from "@/lib/auth";

export async function GET(request: NextRequest) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return Response.json({ error: "Google sign-in is not configured" }, { status: 503 });
  const now = Date.now();
  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken(48);
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get("returnTo"));
  const db = getDb();
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, now));
  await db.insert(oauthStates).values({ state, nonce, codeVerifier, returnTo, createdAt: now, expiresAt: now + 10 * 60 * 1000 });
  const redirectUri = new URL("/api/auth/google/callback", request.url).toString();
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: await pkceChallenge(codeVerifier),
    code_challenge_method: "S256",
    access_type: "online",
    prompt: "select_account",
  }).toString();
  return Response.redirect(target, 302);
}

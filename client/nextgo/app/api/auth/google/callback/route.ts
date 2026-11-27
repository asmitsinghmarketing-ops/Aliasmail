import { and, eq, gt, lt } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { NextRequest } from "next/server";
import { getDb } from "@/db";
import { oauthStates, sessions, users } from "@/db/schema";
import { id } from "@/lib/core";
import { randomToken, SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, sha256 } from "@/lib/auth";
import { verifyGoogleIdToken } from "@/lib/google-oidc";

export async function GET(request: NextRequest) {
  const failure = (reason: string) => Response.redirect(new URL(`/?authError=${encodeURIComponent(reason)}`, request.url), 302);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return failure("Google sign-in is not configured");
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state || request.nextUrl.searchParams.has("error")) return failure("Google sign-in was cancelled");
  const db = getDb();
  const states = await db.select().from(oauthStates).where(and(eq(oauthStates.state, state), gt(oauthStates.expiresAt, Date.now()))).limit(1);
  await db.delete(oauthStates).where(eq(oauthStates.state, state));
  const saved = states[0];
  if (!saved) return failure("Sign-in request expired");
  const redirectUri = new URL("/api/auth/google/callback", request.url).toString();
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, code, code_verifier: saved.codeVerifier, grant_type: "authorization_code", redirect_uri: redirectUri }),
  });
  const tokenBody = await tokenResponse.json().catch(() => ({})) as { id_token?: string };
  if (!tokenResponse.ok || !tokenBody.id_token) return failure("Google token exchange failed");
  try {
    const profile = await verifyGoogleIdToken(tokenBody.id_token, env.GOOGLE_CLIENT_ID, saved.nonce);
    const now = Date.now();
    const existing = await db.select().from(users).where(eq(users.googleSub, profile.sub)).limit(1);
    const userId = existing[0]?.id || id("usr");
    if (existing.length) await db.update(users).set({ email: profile.email, name: profile.name?.slice(0, 120) || null, avatarUrl: profile.picture?.slice(0, 500) || null, updatedAt: now }).where(eq(users.id, userId));
    else await db.insert(users).values({ id: userId, googleSub: profile.sub, email: profile.email, name: profile.name?.slice(0, 120) || null, avatarUrl: profile.picture?.slice(0, 500) || null, createdAt: now, updatedAt: now });
    await db.delete(sessions).where(lt(sessions.expiresAt, now));
    const sessionToken = randomToken();
    await db.insert(sessions).values({ tokenHash: await sha256(sessionToken), userId, createdAt: now, expiresAt: now + SESSION_MAX_AGE_SECONDS * 1000 });
    return new Response(null, { status: 302, headers: {
      Location: new URL(saved.returnTo, request.url).toString(),
      "Set-Cookie": `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
      "Cache-Control": "no-store",
    } });
  } catch (error) {
    console.error("Google callback verification failed", error instanceof Error ? error.message : "Unknown error");
    return failure("Google identity verification failed");
  }
}

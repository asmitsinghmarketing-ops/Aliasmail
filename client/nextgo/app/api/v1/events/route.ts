import { and, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb } from "@/db";
import { apiKeys, customers, events, rateLimits, stores } from "@/db/schema";
import { id, json, sha256 } from "@/lib/core";
import { parseEvent } from "@/lib/ingestion";

const MAX_BODY_BYTES = 256_000, MAX_EVENTS = 50, WINDOW_MS = 60_000, MAX_PER_WINDOW = 1_000;
const cors = (origin: string) => ({ "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Content-Type, X-NextGo-Key", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Max-Age": "86400", Vary: "Origin" });
export async function OPTIONS(request: NextRequest) { return new Response(null, { status: 204, headers: cors(request.headers.get("origin") || "null") }); }

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID(), origin = request.headers.get("origin") || "", headers = { ...cors(origin || "null"), "X-Request-Id": requestId };
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_BYTES) return json({ error: "Payload too large", requestId }, 413, headers);
  const key = request.headers.get("x-nextgo-key");
  if (!key || !/^ng_live_[a-f0-9]{64}$/.test(key)) return json({ error: "Invalid key", requestId }, 401, headers);
  const db = getDb();
  const found = await db.select({ keyId: apiKeys.id, storeId: stores.id, domain: stores.domain }).from(apiKeys).innerJoin(stores, eq(stores.id, apiKeys.storeId)).where(and(eq(apiKeys.keyHash, await sha256(key)), eq(apiKeys.active, true))).limit(1);
  if (!found.length) return json({ error: "Invalid key", requestId }, 401, headers);
  if (!origin || origin !== found[0].domain) return json({ error: "Origin not allowed", requestId }, 403, headers);
  const windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS, bucket = `${found[0].keyId}:${windowStart}`;
  await db.insert(rateLimits).values({ bucket, count: 1, expiresAt: windowStart + WINDOW_MS * 2 }).onConflictDoUpdate({ target: rateLimits.bucket, set: { count: sql`${rateLimits.count} + 1` } });
  const [rate] = await db.select().from(rateLimits).where(eq(rateLimits.bucket, bucket)).limit(1);
  if ((rate?.count || 0) > MAX_PER_WINDOW) return json({ error: "Rate limit exceeded", requestId }, 429, { ...headers, "Retry-After": "60" });
  let body: { events?: unknown[] } | null = null;
  try { body = await request.json() as { events?: unknown[] }; } catch { return json({ error: "Malformed JSON", requestId }, 400, headers); }
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > MAX_EVENTS) return json({ error: `events must contain 1-${MAX_EVENTS} items`, requestId }, 400, headers);
  const now = Date.now(), parsed = body.events.map((item) => parseEvent(item, found[0].storeId, now)), rows = parsed.filter((item): item is NonNullable<typeof item> => item !== null);
  if (!rows.length) return json({ error: "No valid events", rejected: body.events.length, requestId }, 422, headers);
  await db.insert(events).values(rows).onConflictDoNothing({ target: [events.storeId, events.externalId] });
  for (const row of rows) {
    if (row.event !== "customer_identified" || row.consent !== "identified" || !row.visitorId) continue;
    const profile = JSON.parse(row.properties) as Record<string, unknown>;
    const name = typeof profile.name === "string" ? profile.name.trim().slice(0, 120) || null : null;
    const email = typeof profile.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email) ? profile.email.toLowerCase().slice(0, 254) : null;
    const phone = typeof profile.phone === "string" && /^\+?[0-9 ()-]{7,24}$/.test(profile.phone) ? profile.phone.slice(0, 24) : null;
    const consentVersion = typeof profile.consentVersion === "string" ? profile.consentVersion.slice(0, 40) : "1";
    await db.insert(customers).values({ id: id("cus"), storeId: row.storeId, visitorId: row.visitorId, name, email, phone, consentVersion, consentedAt: row.occurredAt, updatedAt: now }).onConflictDoUpdate({ target: [customers.storeId, customers.visitorId], set: { name, email, phone, consentVersion, consentedAt: row.occurredAt, updatedAt: now } });
  }
  await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, found[0].keyId));
  return json({ accepted: rows.length, rejected: body.events.length - rows.length, requestId }, 202, headers);
}

import { and, desc, eq, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb } from "@/db";
import { apiKeys, auditLogs, stores } from "@/db/schema";
import { authenticatedUser, id, json, sha256 } from "@/lib/core";

async function owns(storeId: string, userId: string) { return (await getDb().select({ id: stores.id }).from(stores).where(and(eq(stores.id, storeId), eq(stores.ownerId, userId))).limit(1)).length > 0; }
export async function GET(request: NextRequest) {
  const user = await authenticatedUser(request), storeId = request.nextUrl.searchParams.get("storeId");
  if (!user) return json({ error: "Sign in required" }, 401);
  if (!storeId || !await owns(storeId, user.userId)) return json({ error: "Store not found" }, 404);
  const keys = await getDb().select({ id: apiKeys.id, label: apiKeys.label, prefix: apiKeys.prefix, active: apiKeys.active, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys).where(eq(apiKeys.storeId, storeId)).orderBy(desc(apiKeys.createdAt));
  return json({ keys });
}
export async function POST(request: NextRequest) {
  const user = await authenticatedUser(request); if (!user) return json({ error: "Sign in required" }, 401);
  const body = await request.json().catch(() => null) as { storeId?: string; label?: string } | null;
  if (!body?.storeId || !await owns(body.storeId, user.userId)) return json({ error: "Store not found" }, 404);
  const [usage] = await getDb().select({ count: sql<number>`count(*)` }).from(apiKeys).where(and(eq(apiKeys.storeId, body.storeId), eq(apiKeys.active, true)));
  if (Number(usage?.count || 0) >= 5) return json({ error: "Revoke an active key before creating another" }, 409);
  const secret = `ng_live_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
  const row = { id: id("key"), storeId: body.storeId, label: body.label?.trim().slice(0, 40) || "Website", prefix: secret.slice(0, 15), keyHash: await sha256(secret), active: true, createdAt: Date.now(), lastUsedAt: null };
  await getDb().insert(apiKeys).values(row);
  await getDb().insert(auditLogs).values({ id: id("aud"), storeId: body.storeId, actorId: user.userId, action: "api_key.created", details: JSON.stringify({ keyId: row.id, label: row.label }), createdAt: Date.now() });
  return json({ key: secret, id: row.id, prefix: row.prefix }, 201);
}
export async function DELETE(request: NextRequest) {
  const user = await authenticatedUser(request), keyId = request.nextUrl.searchParams.get("id"); if (!user) return json({ error: "Sign in required" }, 401);
  if (!keyId) return json({ error: "id required" }, 400);
  const found = await getDb().select({ id: apiKeys.id, storeId: apiKeys.storeId }).from(apiKeys).innerJoin(stores, eq(stores.id, apiKeys.storeId)).where(and(eq(apiKeys.id, keyId), eq(stores.ownerId, user.userId))).limit(1);
  if (!found.length) return json({ error: "Key not found" }, 404);
  await getDb().update(apiKeys).set({ active: false }).where(eq(apiKeys.id, keyId));
  await getDb().insert(auditLogs).values({ id: id("aud"), storeId: found[0].storeId, actorId: user.userId, action: "api_key.revoked", details: JSON.stringify({ keyId }), createdAt: Date.now() });
  return json({ ok: true });
}

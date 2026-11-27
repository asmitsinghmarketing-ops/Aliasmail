import { and, desc, eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb } from "@/db";
import { auditLogs, stores } from "@/db/schema";
import { authenticatedUser, json } from "@/lib/core";

export async function GET(request: NextRequest) {
  const user = await authenticatedUser(request), storeId = request.nextUrl.searchParams.get("storeId");
  if (!user) return json({ error: "Sign in required" }, 401);
  if (!storeId) return json({ error: "storeId required" }, 400);
  const owned = await getDb().select({ id: stores.id }).from(stores).where(and(eq(stores.id, storeId), eq(stores.ownerId, user.userId))).limit(1);
  if (!owned.length) return json({ error: "Store not found" }, 404);
  return json({ entries: await getDb().select().from(auditLogs).where(eq(auditLogs.storeId, storeId)).orderBy(desc(auditLogs.createdAt)).limit(100) });
}

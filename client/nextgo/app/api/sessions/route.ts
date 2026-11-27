import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb } from "@/db";
import { authenticatedUser, json } from "@/lib/core";
import { ownsStore } from "@/lib/workspace";

type Row = { id: string; event: string; visitor_id: string | null; occurred_at: number; page: string | null; referrer: string | null; properties: string; consent: string };

/** Ordered journey for one session, with a short outcome summary. */
export async function GET(r: NextRequest) {
  const user = await authenticatedUser(r), storeId = r.nextUrl.searchParams.get("storeId"), sessionId = r.nextUrl.searchParams.get("sessionId");
  if (!user) return json({ error: "Sign in required" }, 401);
  if (!sessionId || !await ownsStore(storeId, user.userId)) return json({ error: "Session not found" }, 404);
  const rows = await getDb().all<Row>(sql`SELECT id, event, visitor_id, occurred_at, page, referrer, properties, consent FROM events WHERE store_id=${storeId} AND session_id=${sessionId} ORDER BY occurred_at ASC, id ASC LIMIT 500`);
  if (!rows.length) return json({ error: "Session not found" }, 404);
  const events = rows.map((x) => ({ id: x.id, event: x.event, occurredAt: x.occurred_at, page: x.page, consent: x.consent, properties: parse(x.properties) }));
  const has = (name: string) => rows.some((x) => x.event === name);
  const revenue = events.filter((x) => x.event === "purchase_completed").reduce((sum, x) => sum + (Number(x.properties.revenue ?? x.properties.total ?? x.properties.value) || 0), 0);
  const cartValue = events.reduce((max, x) => Math.max(max, Number(x.properties.cartValue) || 0), 0);
  const first = rows[0], last = rows[rows.length - 1];
  return json({
    sessionId,
    visitorId: rows.find((x) => x.visitor_id)?.visitor_id ?? null,
    consent: last.consent,
    referrer: first.referrer,
    startedAt: first.occurred_at,
    endedAt: last.occurred_at,
    pages: new Set(rows.map((x) => x.page).filter(Boolean)).size,
    outcome: has("purchase_completed") ? "purchased" : has("checkout_started") ? "checkout_abandoned" : has("added_to_cart") ? "cart_abandoned" : "browsed",
    revenue,
    cartValue,
    events,
  });
}

function parse(value: string) {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}

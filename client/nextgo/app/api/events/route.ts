import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb } from "@/db";
import { authenticatedUser, json } from "@/lib/core";
import { ownsStore, reportingRange } from "@/lib/workspace";

type Row = { id: string; event: string; session_id: string; visitor_id: string | null; occurred_at: number; page: string | null; referrer: string | null; properties: string; consent: string };

/** Merchant-facing event explorer: filter by type, consent and free text, newest first. */
export async function GET(r: NextRequest) {
  const user = await authenticatedUser(r), params = r.nextUrl.searchParams, storeId = params.get("storeId");
  if (!user) return json({ error: "Sign in required" }, 401);
  if (!await ownsStore(storeId, user.userId)) return json({ error: "Store not found" }, 404);
  const { since } = reportingRange(r), db = getDb();
  const event = (params.get("event") || "").slice(0, 64);
  const consent = (params.get("consent") || "").slice(0, 20);
  const q = (params.get("q") || "").trim().slice(0, 120);
  const limit = Math.min(100, Math.max(10, Number(params.get("limit")) || 50));
  const [cursorAt, cursorId] = (params.get("cursor") || "").split("~");
  const at = Number(cursorAt) || Number.MAX_SAFE_INTEGER, cid = cursorId || "";

  const [rows, types] = await Promise.all([
    db.all<Row>(sql`SELECT id, event, session_id, visitor_id, occurred_at, page, referrer, properties, consent FROM events
      WHERE store_id=${storeId} AND occurred_at>=${since}
        AND (${event}='' OR event=${event})
        AND (${consent}='' OR consent=${consent})
        AND (${q}='' OR instr(session_id, ${q})>0 OR instr(coalesce(visitor_id,''), ${q})>0 OR instr(lower(coalesce(page,'')), lower(${q}))>0 OR instr(lower(properties), lower(${q}))>0)
        AND (occurred_at<${at} OR (occurred_at=${at} AND id<${cid}))
      ORDER BY occurred_at DESC, id DESC LIMIT ${limit + 1}`),
    db.all<{ event: string; count: number }>(sql`SELECT event, count(*) count FROM events WHERE store_id=${storeId} AND occurred_at>=${since} GROUP BY event ORDER BY count DESC`),
  ]);
  const page = rows.slice(0, limit), last = page[page.length - 1];
  return json({
    events: page.map((x) => ({ id: x.id, event: x.event, sessionId: x.session_id, visitorId: x.visitor_id, occurredAt: x.occurred_at, page: x.page, referrer: x.referrer, consent: x.consent, properties: parse(x.properties) })),
    nextCursor: rows.length > limit && last ? `${last.occurred_at}~${last.id}` : null,
    types: types.map((x) => ({ event: x.event, count: Number(x.count) })),
  });
}

function parse(value: string) {
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}

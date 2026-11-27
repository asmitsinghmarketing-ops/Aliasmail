import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb } from "@/db";
import { authenticatedUser, json } from "@/lib/core";
import { DAY_DIVISOR, fillDays, ownsStore, reportingRange } from "@/lib/workspace";

const FUNNEL = ["product_viewed", "added_to_cart", "checkout_started", "purchase_completed"];
type Totals = { events: number; sessions: number; visitors: number };

export async function GET(r: NextRequest) {
  const u = await authenticatedUser(r), s = r.nextUrl.searchParams.get("storeId");
  if (!u) return json({ error: "Sign in required" }, 401);
  if (!s) return json({ error: "storeId required" }, 400);
  if (!await ownsStore(s, u.userId)) return json({ error: "Store not found" }, 404);
  const range = reportingRange(r), { since, previousSince, tzMs } = range, db = getDb();

  const totals = (from: number, to: number) => db.all<Totals>(sql`SELECT count(*) events, count(DISTINCT session_id) sessions, count(DISTINCT coalesce(visitor_id, session_id)) visitors FROM events WHERE store_id=${s} AND occurred_at>=${from} AND occurred_at<${to}`);
  const [current, previous, breakdown, funnelRows, daily, topPages, referrerRows, consent, recent, last] = await Promise.all([
    totals(since, range.now + 1),
    totals(previousSince, since),
    db.all<{ event: string; count: number }>(sql`SELECT event, count(*) count FROM events WHERE store_id=${s} AND occurred_at>=${since} GROUP BY event ORDER BY count DESC LIMIT 12`),
    db.all<{ event: string; sessions: number }>(sql`SELECT event, count(DISTINCT session_id) sessions FROM events WHERE store_id=${s} AND occurred_at>=${since} AND event IN ${FUNNEL} GROUP BY event`),
    db.all<{ day: number; events: number; sessions: number }>(sql`SELECT CAST((occurred_at - ${tzMs}) / ${DAY_DIVISOR} AS INTEGER) day, count(*) events, count(DISTINCT session_id) sessions FROM events WHERE store_id=${s} AND occurred_at>=${since} GROUP BY day`),
    db.all<{ page: string; views: number; sessions: number }>(sql`SELECT page, count(*) views, count(DISTINCT session_id) sessions FROM events WHERE store_id=${s} AND occurred_at>=${since} AND event='page_viewed' AND page IS NOT NULL GROUP BY page ORDER BY views DESC LIMIT 8`),
    db.all<{ referrer: string | null; sessions: number }>(sql`SELECT referrer, count(DISTINCT session_id) sessions FROM events WHERE store_id=${s} AND occurred_at>=${since} GROUP BY referrer ORDER BY sessions DESC LIMIT 200`),
    db.all<{ consent: string; sessions: number }>(sql`SELECT consent, count(DISTINCT session_id) sessions FROM events WHERE store_id=${s} AND occurred_at>=${since} GROUP BY consent`),
    db.all<{ id: string; event: string; session_id: string; occurred_at: number; consent: string; page: string | null }>(sql`SELECT id, event, session_id, occurred_at, consent, page FROM events WHERE store_id=${s} ORDER BY occurred_at DESC LIMIT 8`),
    db.all<{ at: number | null }>(sql`SELECT max(occurred_at) at FROM events WHERE store_id=${s}`),
  ]);

  // Collapse full referrer URLs to hosts; sessions without a referrer count as direct.
  const sources = new Map<string, number>();
  for (const row of referrerRows) {
    let host = "Direct";
    if (row.referrer) try { host = new URL(row.referrer).hostname.replace(/^www\./, ""); } catch { host = "Other"; }
    sources.set(host, (sources.get(host) ?? 0) + Number(row.sessions));
  }
  const num = (t?: Totals) => ({ events: Number(t?.events || 0), sessions: Number(t?.sessions || 0), visitors: Number(t?.visitors || 0) });
  const funnelMap = new Map(funnelRows.map((x) => [x.event, Number(x.sessions)]));

  return json({
    rangeDays: range.days,
    summary: num(current[0]),
    previous: num(previous[0]),
    breakdown: breakdown.map((x) => ({ event: x.event, count: Number(x.count) })),
    funnel: FUNNEL.map((event) => ({ event, sessions: funnelMap.get(event) ?? 0 })),
    daily: fillDays(daily, range, { events: 0, sessions: 0 }),
    topPages: topPages.map((x) => ({ page: x.page, views: Number(x.views), sessions: Number(x.sessions) })),
    sources: [...sources].map(([source, sessions]) => ({ source, sessions })).sort((a, b) => b.sessions - a.sessions).slice(0, 8),
    consent: consent.map((x) => ({ consent: x.consent, sessions: Number(x.sessions) })),
    recent: recent.map((x) => ({ id: x.id, event: x.event, sessionId: x.session_id, occurredAt: x.occurred_at, consent: x.consent, page: x.page })),
    lastEventAt: last[0]?.at ?? null,
  });
}

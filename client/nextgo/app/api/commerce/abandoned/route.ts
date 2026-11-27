import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb } from "@/db";
import { authenticatedUser, json } from "@/lib/core";
import { ownsStore } from "@/lib/workspace";

type Row = { session_id: string; visitor_id: string | null; customer_label: string | null; masked_email: string | null; masked_phone: string | null; last_activity: number; first_cart_at: number; item_events: number; cart_value: number; reached_checkout: number; last_product: string | null };
type Totals = { carts: number; value: number; checkout: number; identified: number };

export async function GET(request: NextRequest) {
  const user = await authenticatedUser(request), params = request.nextUrl.searchParams, storeId = params.get("storeId");
  if (!user) return json({ error: "Sign in required" }, 401);
  if (!storeId) return json({ error: "storeId required" }, 400);
  if (!await ownsStore(storeId, user.userId)) return json({ error: "Store not found" }, 404);
  const days = Math.min(90, Math.max(1, Number(params.get("days")) || 30)), since = Date.now() - days * 86400000;
  const cursor = Math.max(0, Number(params.get("cursor")) || Number.MAX_SAFE_INTEGER);
  const limit = Math.min(100, Math.max(10, Number(params.get("limit")) || 50));
  const status = ["cart", "checkout"].includes(params.get("status") || "") ? params.get("status")! : "";
  const q = (params.get("q") || "").trim().toLowerCase().slice(0, 120);
  const db = getDb();

  // One CTE shared by the page query and the totals query.
  const abandoned = sql`WITH abandoned AS (
    SELECT session_id,
      MAX(CASE WHEN consent='identified' THEN visitor_id END) visitor_id,
      MAX(occurred_at) last_activity,
      MIN(CASE WHEN event='added_to_cart' THEN occurred_at END) first_cart_at,
      SUM(CASE WHEN event='added_to_cart' THEN 1 ELSE 0 END) item_events,
      MAX(CAST(COALESCE(CASE WHEN json_valid(properties) THEN json_extract(properties,'$.cartValue') END,CASE WHEN json_valid(properties) THEN json_extract(properties,'$.value') END,0) AS REAL)) cart_value,
      MAX(CASE WHEN event='checkout_started' THEN 1 ELSE 0 END) reached_checkout,
      MAX(CASE WHEN event='added_to_cart' THEN COALESCE(CASE WHEN json_valid(properties) THEN json_extract(properties,'$.productName') END,CASE WHEN json_valid(properties) THEN json_extract(properties,'$.name') END) END) last_product,
      MAX(CASE WHEN event='purchase_completed' THEN 1 ELSE 0 END) purchased,
      MAX(CASE WHEN event='added_to_cart' THEN 1 ELSE 0 END) carted
    FROM events WHERE store_id=${storeId} AND occurred_at>=${since} GROUP BY session_id
  ), filtered AS (
    SELECT * FROM abandoned WHERE carted=1 AND purchased=0
      AND (${status}='' OR (${status}='checkout' AND reached_checkout=1) OR (${status}='cart' AND reached_checkout=0))
      AND (${q}='' OR instr(lower(coalesce(last_product,'')), ${q})>0 OR instr(lower(session_id), ${q})>0 OR instr(lower(coalesce(visitor_id,'')), ${q})>0)
  )`;
  const [rows, totals] = await Promise.all([
    db.all<Row>(sql`${abandoned} SELECT a.session_id, a.visitor_id,
        CASE WHEN c.name IS NOT NULL THEN substr(c.name,1,1)||'***' END customer_label,
        CASE WHEN c.email IS NOT NULL THEN substr(c.email,1,1)||'***@'||substr(c.email,instr(c.email,'@')+1) END masked_email,
        CASE WHEN c.phone IS NOT NULL THEN '***'||substr(c.phone,-4) END masked_phone,
        a.last_activity, a.first_cart_at, a.item_events, a.cart_value, a.reached_checkout, a.last_product
      FROM filtered a LEFT JOIN customers c ON c.store_id=${storeId} AND c.visitor_id=a.visitor_id
      WHERE a.last_activity<${cursor} ORDER BY a.last_activity DESC LIMIT ${limit + 1}`),
    db.all<Totals>(sql`${abandoned} SELECT count(*) carts, COALESCE(SUM(cart_value),0) value, COALESCE(SUM(reached_checkout),0) checkout, COUNT(visitor_id) identified FROM filtered`),
  ]);
  const page = rows.slice(0, limit), nextCursor = rows.length > limit ? page[page.length - 1]?.last_activity : null;

  if (params.get("format") === "csv") {
    const header = "session_id,visitor_id,status,last_product,item_events,cart_value,first_cart_at,last_activity\n";
    const body = page.map((r) => [r.session_id, r.visitor_id || "anonymous", r.reached_checkout ? "checkout_abandoned" : "cart_abandoned", r.last_product || "", r.item_events, r.cart_value, new Date(r.first_cart_at).toISOString(), new Date(r.last_activity).toISOString()].map(csv).join(",")).join("\n");
    return new Response(header + body, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="abandoned-carts-${Date.now()}.csv"`, "Cache-Control": "no-store" } });
  }
  const t = totals[0];
  return json({
    rows: page, nextCursor, hasMore: rows.length > limit, rangeDays: days,
    totals: { carts: Number(t?.carts || 0), value: Number(t?.value || 0), checkout: Number(t?.checkout || 0), identified: Number(t?.identified || 0) },
  });
}

// Prefix values that spreadsheets would evaluate as formulas.
function csv(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

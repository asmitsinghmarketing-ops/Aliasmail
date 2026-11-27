import { and, eq, gte, sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { getDb } from "@/db";
import { stores } from "@/db/schema";
import { authenticatedUser, json } from "@/lib/core";
import { DAY_DIVISOR, fillDays, reportingRange } from "@/lib/workspace";

type SummaryRow={product_views:number;cart_sessions:number;checkout_sessions:number;purchases:number;revenue:number;orders:number};
export async function GET(request:NextRequest){
  const user=await authenticatedUser(request),storeId=request.nextUrl.searchParams.get("storeId");
  if(!user)return json({error:"Sign in required"},401);if(!storeId)return json({error:"storeId required"},400);
  const owned=await getDb().select({id:stores.id}).from(stores).where(and(eq(stores.id,storeId),eq(stores.ownerId,user.userId))).limit(1);if(!owned.length)return json({error:"Store not found"},404);
  const days=Math.min(90,Math.max(1,Number(request.nextUrl.searchParams.get("days"))||30)),since=Date.now()-days*86400000,db=getDb();
  const summary=await db.all<SummaryRow>(sql`WITH sessions AS (
    SELECT session_id,
      MAX(CASE WHEN event='product_viewed' THEN 1 ELSE 0 END) product_viewed,
      MAX(CASE WHEN event='added_to_cart' THEN 1 ELSE 0 END) added_to_cart,
      MAX(CASE WHEN event='checkout_started' THEN 1 ELSE 0 END) checkout_started,
      MAX(CASE WHEN event='purchase_completed' THEN 1 ELSE 0 END) purchased
    FROM events WHERE store_id=${storeId} AND occurred_at>=${since} GROUP BY session_id
  ), money AS (
    SELECT COUNT(*) orders, COALESCE(SUM(CAST(COALESCE(CASE WHEN json_valid(properties) THEN json_extract(properties,'$.revenue') END,CASE WHEN json_valid(properties) THEN json_extract(properties,'$.total') END,CASE WHEN json_valid(properties) THEN json_extract(properties,'$.value') END,0) AS REAL)),0) revenue
    FROM events WHERE store_id=${storeId} AND occurred_at>=${since} AND event='purchase_completed'
  ) SELECT COALESCE(SUM(product_viewed),0) product_views,COALESCE(SUM(added_to_cart),0) cart_sessions,COALESCE(SUM(checkout_started),0) checkout_sessions,COALESCE(SUM(purchased),0) purchases,money.revenue,money.orders FROM sessions CROSS JOIN money`);
  const topAbandoned=await db.all(sql`SELECT COALESCE(CASE WHEN json_valid(e.properties) THEN json_extract(e.properties,'$.productName') END,CASE WHEN json_valid(e.properties) THEN json_extract(e.properties,'$.name') END,'Unknown product') product_name,COALESCE(CASE WHEN json_valid(e.properties) THEN json_extract(e.properties,'$.productId') END,CASE WHEN json_valid(e.properties) THEN json_extract(e.properties,'$.sku') END,'unknown') product_id,COUNT(DISTINCT e.session_id) abandoned_sessions,COALESCE(SUM(CAST(COALESCE(CASE WHEN json_valid(e.properties) THEN json_extract(e.properties,'$.quantity') END,1) AS INTEGER)),0) units FROM events e WHERE e.store_id=${storeId} AND e.occurred_at>=${since} AND e.event='added_to_cart' AND NOT EXISTS(SELECT 1 FROM events p WHERE p.store_id=e.store_id AND p.session_id=e.session_id AND p.event='purchase_completed') GROUP BY product_id,product_name ORDER BY abandoned_sessions DESC LIMIT 10`);
  const abandoned=await db.all(sql`SELECT session_id,MAX(occurred_at) last_activity,COUNT(CASE WHEN event='added_to_cart' THEN 1 END) item_events,MAX(CAST(COALESCE(CASE WHEN json_valid(properties) THEN json_extract(properties,'$.cartValue') END,CASE WHEN json_valid(properties) THEN json_extract(properties,'$.value') END,0) AS REAL)) cart_value,MAX(CASE WHEN event='checkout_started' THEN 1 ELSE 0 END) reached_checkout FROM events e WHERE store_id=${storeId} AND occurred_at>=${since} GROUP BY session_id HAVING MAX(CASE WHEN event='added_to_cart' THEN 1 ELSE 0 END)=1 AND MAX(CASE WHEN event='purchase_completed' THEN 1 ELSE 0 END)=0 ORDER BY last_activity DESC LIMIT 50`);
  const range=reportingRange(request);
  const daily=await db.all<{day:number;revenue:number;orders:number;carts:number}>(sql`SELECT CAST((occurred_at - ${range.tzMs}) / ${DAY_DIVISOR} AS INTEGER) day,COALESCE(SUM(CASE WHEN event='purchase_completed' THEN CAST(COALESCE(CASE WHEN json_valid(properties) THEN json_extract(properties,'$.revenue') END,CASE WHEN json_valid(properties) THEN json_extract(properties,'$.total') END,CASE WHEN json_valid(properties) THEN json_extract(properties,'$.value') END,0) AS REAL) END),0) revenue,SUM(CASE WHEN event='purchase_completed' THEN 1 ELSE 0 END) orders,COUNT(DISTINCT CASE WHEN event='added_to_cart' THEN session_id END) carts FROM events WHERE store_id=${storeId} AND occurred_at>=${since} AND event IN ('purchase_completed','added_to_cart') GROUP BY day`);
  const topProducts=await db.all<{product_id:string;product_name:string;views:number;carts:number}>(sql`SELECT COALESCE(CASE WHEN json_valid(properties) THEN json_extract(properties,'$.productId') END,CASE WHEN json_valid(properties) THEN json_extract(properties,'$.sku') END,'unknown') product_id,MAX(COALESCE(CASE WHEN json_valid(properties) THEN json_extract(properties,'$.productName') END,CASE WHEN json_valid(properties) THEN json_extract(properties,'$.name') END,'Unknown product')) product_name,COUNT(DISTINCT CASE WHEN event='product_viewed' THEN session_id END) views,COUNT(DISTINCT CASE WHEN event='added_to_cart' THEN session_id END) carts FROM events WHERE store_id=${storeId} AND occurred_at>=${since} AND event IN ('product_viewed','added_to_cart') GROUP BY product_id ORDER BY views DESC LIMIT 10`);
  const products=topProducts.map(p=>({productId:p.product_id,productName:p.product_name,views:Number(p.views),carts:Number(p.carts),cartRate:Number(p.views)?Math.round(Number(p.carts)/Number(p.views)*1000)/10:0}));
  const row=summary[0]||{product_views:0,cart_sessions:0,checkout_sessions:0,purchases:0,revenue:0,orders:0},rate=(a:number,b:number)=>b?Math.round(a/b*1000)/10:0;
  return json({rangeDays:days,summary:{productViews:Number(row.product_views),cartSessions:Number(row.cart_sessions),checkoutSessions:Number(row.checkout_sessions),purchases:Number(row.purchases),revenue:Number(row.revenue),orders:Number(row.orders),addToCartRate:rate(Number(row.cart_sessions),Number(row.product_views)),cartAbandonmentRate:rate(Number(row.cart_sessions)-Number(row.purchases),Number(row.cart_sessions)),checkoutAbandonmentRate:rate(Number(row.checkout_sessions)-Number(row.purchases),Number(row.checkout_sessions)),conversionRate:rate(Number(row.purchases),Number(row.product_views)),averageOrderValue:Number(row.orders)?Math.round(Number(row.revenue)/Number(row.orders)*100)/100:0},topAbandoned,abandoned,daily:fillDays(daily,{...range,days},{revenue:0,orders:0,carts:0}),products});
}

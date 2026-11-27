"use client";
import Link from "next/link";
import { ArrowRight, BadgeDollarSign, CreditCard, PackageCheck, Percent, ShoppingCart } from "lucide-react";
import { useState } from "react";
import { useWorkspace } from "@/components/workspace/context";
import { BarLineChart, CHART } from "@/components/workspace/charts";
import { SessionDrawer } from "@/components/workspace/session-drawer";
import { ago, BarList, Card, Empty, ErrorBanner, fmt, Kpi, money, PageHeader, pct, ratio, Skeleton, useApi } from "@/components/workspace/ui";

type Data = {
  summary: { productViews: number; cartSessions: number; checkoutSessions: number; purchases: number; revenue: number; orders: number; addToCartRate: number; cartAbandonmentRate: number; checkoutAbandonmentRate: number; conversionRate: number; averageOrderValue: number };
  topAbandoned: { product_name: string; product_id: string; abandoned_sessions: number; units: number }[];
  abandoned: { session_id: string; last_activity: number; item_events: number; cart_value: number; reached_checkout: number }[];
  daily: { date: string; revenue: number; orders: number; carts: number }[];
  products: { productId: string; productName: string; views: number; carts: number; cartRate: number }[];
};

export default function Commerce() {
  const { query, days, stores, storesLoaded } = useWorkspace();
  const { data, error, reload } = useApi<Data>(query ? `/api/commerce?${query}` : null);
  const [session, setSession] = useState<string | null>(null);
  if (storesLoaded && !stores.length) return <Empty title="Connect a store first"><Link className="btn btnPrimary btnSm" href="/dashboard">Get started</Link></Empty>;
  const s = data?.summary;
  const steps: [string, number][] = s ? [["Product viewed", s.productViews], ["Added to cart", s.cartSessions], ["Checkout started", s.checkoutSessions], ["Purchase completed", s.purchases]] : [];
  const atRisk = data?.abandoned.reduce((a, x) => a + Number(x.cart_value || 0), 0) ?? 0;

  return <>
    <PageHeader eyebrow={`Checkout intelligence · last ${days} days`} title="Cart and checkout behavior"
      description="Where buying intent turns into revenue, and where it drops off."
      actions={<Link className="btn btnPrimary" href="/dashboard/commerce/abandoned"><ShoppingCart />Abandoned carts</Link>} />
    <ErrorBanner message={error} onRetry={() => void reload()} />

    <section className="kpis">
      <Kpi label="Revenue" icon={BadgeDollarSign} loading={!s} value={money(s?.revenue, 0)} sub={s && <>{fmt(s.orders)} orders · {money(s.averageOrderValue)} avg</>} />
      <Kpi label="Purchase conversion" icon={Percent} loading={!s} value={pct(s?.conversionRate)} sub="of product-viewing sessions" />
      <Kpi label="Add-to-cart rate" icon={ShoppingCart} loading={!s} value={pct(s?.addToCartRate)} sub={s && <>{fmt(s.cartSessions)} carting sessions</>} />
      <Kpi label="Cart abandonment" icon={PackageCheck} loading={!s} value={pct(s?.cartAbandonmentRate)} sub={s && <span className="pill red">{fmt(s.cartSessions - s.purchases)} carts lost</span>} />
      <Kpi label="Checkout abandonment" icon={CreditCard} loading={!s} value={pct(s?.checkoutAbandonmentRate)} sub={s && <>{fmt(s.checkoutSessions)} checkouts started</>} />
    </section>

    <div className="grid21">
      <Card title="Revenue" subtitle="Daily revenue (bars) and orders (line)" action={<span className="legend" style={{ display: "flex", gap: "1rem" }}><div><i style={{ background: CHART.primary }} />Revenue</div><div><i style={{ background: CHART.tertiary }} />Orders</div></span>}>
        {!data ? <Skeleton rows={6} height={30} /> : <BarLineChart data={data.daily} bar={{ key: "revenue", name: "Revenue", color: CHART.primary, format: (v) => money(v, 0) }} line={{ key: "orders", name: "Orders", color: CHART.tertiary }} />}
      </Card>
      <Card title="Intent funnel" subtitle="Sessions at each step">
        {!s ? <Skeleton /> : <div className="funnel">{steps.map(([name, value], i) => {
          const prev = steps[i - 1]?.[1] ?? 0;
          return <div className="funnelStep" key={name}>
            <header><span>{name}</span><b>{fmt(value)}</b></header>
            <div className="funnelTrack"><i style={{ width: `${Math.max(1.5, ratio(value, s.productViews || 1))}%` }} /></div>
            {i > 0 && <span className="funnelDrop">{pct(ratio(value, prev))} continued · <b>{fmt(Math.max(0, prev - value))} dropped</b></span>}
          </div>;
        })}</div>}
      </Card>
    </div>

    <Card title="Product performance" subtitle="Sessions that viewed each product, and how many of them added it to cart" className="cardFlush">
      {!data ? <div style={{ padding: "1.35rem" }}><Skeleton /></div> : data.products.length ? <div className="tableWrap"><table className="table">
        <thead><tr><th>Product</th><th className="num">Viewing sessions</th><th className="num">Cart sessions</th><th style={{ width: "30%" }}>Cart rate</th></tr></thead>
        <tbody>{data.products.map((p) => <tr key={p.productId}>
          <td><b>{p.productName}</b><code>{p.productId}</code></td>
          <td className="num">{fmt(p.views)}</td><td className="num">{fmt(p.carts)}</td>
          <td><div style={{ display: "flex", alignItems: "center", gap: ".6rem" }}><div className="funnelTrack" style={{ flex: 1 }}><i style={{ width: `${Math.min(100, p.cartRate)}%` }} /></div><b style={{ fontSize: ".82rem", width: "3.2rem", textAlign: "right" }}>{pct(p.cartRate)}</b></div></td>
        </tr>)}</tbody>
      </table></div> : <Empty title="No product views yet." />}
    </Card>

    <div className="grid2">
      <Card title="Most abandoned products" subtitle="Carted in sessions that never purchased">
        {!data ? <Skeleton /> : <BarList items={data.topAbandoned.map((x) => ({ key: x.product_id, label: x.product_name, value: Number(x.abandoned_sessions), display: `${fmt(x.abandoned_sessions)} carts` }))} empty="No abandoned products in this range." />}
      </Card>
      <Card title="Recent abandoned carts" subtitle={data ? `${money(atRisk, 0)} across the latest ${data.abandoned.length}` : undefined} action={<Link href="/dashboard/commerce/abandoned">View all <ArrowRight size={13} /></Link>}>
        {!data ? <Skeleton /> : data.abandoned.length ? <div className="list">{data.abandoned.slice(0, 7).map((x) =>
          <button className="listItem" key={x.session_id} onClick={() => setSession(x.session_id)}>
            <span className={`pill ${x.reached_checkout ? "red" : "amber"}`}>{x.reached_checkout ? "Checkout" : "Cart"}</span>
            <div><b>{money(x.cart_value)}</b><small className="mono">{x.session_id.slice(0, 22)}</small></div><time>{ago(x.last_activity)}</time>
          </button>)}</div> : <Empty title="No abandoned carts in this range." />}
      </Card>
    </div>
    {session && <SessionDrawer sessionId={session} onClose={() => setSession(null)} />}
  </>;
}

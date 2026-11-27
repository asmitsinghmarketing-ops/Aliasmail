"use client";
import { Download, Search, ShoppingCart } from "lucide-react";
import { useEffect, useState } from "react";
import { useWorkspace } from "@/components/workspace/context";
import { SessionDrawer } from "@/components/workspace/session-drawer";
import { api, ago, Card, dateTime, Empty, ErrorBanner, fmt, Kpi, money, PageHeader, Segmented, Skeleton } from "@/components/workspace/ui";

type Cart = { session_id: string; visitor_id: string | null; customer_label: string | null; masked_email: string | null; masked_phone: string | null; last_activity: number; first_cart_at: number; item_events: number; cart_value: number; reached_checkout: number; last_product: string | null };
type Page = { rows: Cart[]; nextCursor: number | null; hasMore: boolean; totals: { carts: number; value: number; checkout: number; identified: number } };
type Status = "" | "cart" | "checkout";

export default function Abandoned() {
  const { query, days, refreshTick } = useWorkspace();
  const [status, setStatus] = useState<Status>("");
  const [search, setSearch] = useState(""), [q, setQ] = useState("");
  const [rows, setRows] = useState<Cart[]>([]);
  const [totals, setTotals] = useState<Page["totals"] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null), [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [session, setSession] = useState<string | null>(null);

  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  const base = query ? `/api/commerce/abandoned?${query}&limit=50&status=${status}&q=${encodeURIComponent(q)}` : "";

  async function load(reset: boolean) {
    if (!base) return;
    setLoading(true); setError("");
    try {
      const page = await api<Page>(`${base}${!reset && cursor ? `&cursor=${cursor}` : ""}`);
      setRows((old) => (reset ? page.rows : [...old, ...page.rows]));
      setTotals(page.totals); setCursor(page.nextCursor); setHasMore(page.hasMore);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load carts"); } finally { setLoading(false); }
  }
  // Reload from the first page whenever filters, store, range or the refresh tick change.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { void load(true); }, [base, refreshTick]);

  return <>
    <PageHeader eyebrow={`Cart recovery · last ${days} days`} title="Abandoned carts"
      description="Sessions that added to cart but never purchased. Customer details appear only for visitors who explicitly consented to identification, and are masked."
      actions={<a className="btn btnGhost" href={base ? `${base.replace("limit=50", "limit=100")}&format=csv` : undefined} aria-disabled={!base}><Download />Export CSV</a>} />
    <ErrorBanner message={error} onRetry={() => void load(true)} />
    <section className="kpis">
      <Kpi label="Abandoned carts" loading={!totals} value={fmt(totals?.carts)} />
      <Kpi label="Value at risk" loading={!totals} value={money(totals?.value, 0)} sub={totals && totals.carts ? <>{money(totals.value / totals.carts)} average cart</> : undefined} />
      <Kpi label="Reached checkout" loading={!totals} value={fmt(totals?.checkout)} sub="highest-intent carts" />
      <Kpi label="Identified" loading={!totals} value={fmt(totals?.identified)} sub="consented to contact" />
    </section>
    <Card className="cardFlush">
      <div className="toolbar">
        <div className="searchBox"><Search /><input className="input" placeholder="Search product, session or visitor" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search carts" /></div>
        <Segmented ariaLabel="Cart status" value={status} onChange={setStatus} options={[{ value: "", label: "All" }, { value: "checkout", label: "Checkout" }, { value: "cart", label: "Cart only" }]} />
      </div>
      {loading && !rows.length ? <div style={{ padding: "1.35rem" }}><Skeleton rows={6} /></div> : rows.length ? <div className="tableWrap"><table className="table">
        <thead><tr><th>Customer / session</th><th>Status</th><th>Last product</th><th className="num">Cart value</th><th className="hideSm">Last activity</th></tr></thead>
        <tbody>{rows.map((r) => <tr className="clickable" key={`${r.session_id}-${r.last_activity}`} onClick={() => setSession(r.session_id)}>
          <td><b>{r.customer_label || (r.visitor_id ? `Visitor ${r.visitor_id}` : "Anonymous visitor")}</b>{(r.masked_email || r.masked_phone) && <small>{[r.masked_email, r.masked_phone].filter(Boolean).join(" · ")}</small>}<code>{r.session_id.slice(0, 26)}</code></td>
          <td><span className={`pill ${r.reached_checkout ? "red" : "amber"}`}>{r.reached_checkout ? "Checkout abandoned" : "Cart abandoned"}</span></td>
          <td>{r.last_product || "Unknown product"}<small>{r.item_events} cart event{r.item_events === 1 ? "" : "s"}</small></td>
          <td className="num"><b>{money(r.cart_value)}</b></td>
          <td className="hideSm muted" title={dateTime(r.last_activity)}>{ago(r.last_activity)}</td>
        </tr>)}</tbody>
      </table></div> : <Empty title={q || status ? "No carts match these filters." : "No abandoned carts in this range."} icon={ShoppingCart} />}
      {hasMore && <div className="tableFoot"><button className="btn btnGhost" onClick={() => void load(false)} disabled={loading}>{loading ? "Loading…" : "Load more"}</button></div>}
    </Card>
    {session && <SessionDrawer sessionId={session} onClose={() => setSession(null)} />}
  </>;
}

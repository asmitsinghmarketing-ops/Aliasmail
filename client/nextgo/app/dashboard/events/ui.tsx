"use client";
import { Activity, Pause, Play, Route, Search } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { useWorkspace } from "@/components/workspace/context";
import { SessionDrawer } from "@/components/workspace/session-drawer";
import { api, ago, Card, ConsentPill, CopyButton, dateTime, Empty, ErrorBanner, EventName, fmt, label, PageHeader, pathOf, Skeleton } from "@/components/workspace/ui";

type Ev = { id: string; event: string; sessionId: string; visitorId: string | null; occurredAt: number; page: string | null; referrer: string | null; consent: string; properties: Record<string, unknown> };
type Page = { events: Ev[]; nextCursor: string | null; types: { event: string; count: number }[] };

export default function Events() {
  const { query, days, refreshTick } = useWorkspace();
  const [event, setEvent] = useState(""), [consent, setConsent] = useState("");
  const [search, setSearch] = useState(""), [q, setQ] = useState("");
  const [live, setLive] = useState(true);
  const [rows, setRows] = useState<Ev[]>([]), [types, setTypes] = useState<Page["types"]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null), [session, setSession] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  const base = query ? `/api/events?${query}&event=${encodeURIComponent(event)}&consent=${consent}&q=${encodeURIComponent(q)}&limit=50` : "";

  async function load(mode: "reset" | "more" | "poll") {
    if (!base) return;
    if (mode !== "poll") setLoading(true);
    try {
      const page = await api<Page>(mode === "more" && cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base);
      setTypes(page.types); setError("");
      if (mode === "more") { setRows((old) => [...old, ...page.events]); setCursor(page.nextCursor); return; }
      if (mode === "poll") {
        // Prepend only events we have not seen, and flash them briefly.
        setRows((old) => {
          const seen = new Set(old.map((x) => x.id)), added = page.events.filter((x) => !seen.has(x.id));
          if (added.length) { setFresh(new Set(added.map((x) => x.id))); setTimeout(() => setFresh(new Set()), 2000); }
          return added.length ? [...added, ...old] : old;
        });
        return;
      }
      setRows(page.events); setCursor(page.nextCursor);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load events"); } finally { if (mode !== "poll") setLoading(false); }
  }
  // Reload from the first page whenever filters, store, range or the refresh tick change.
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect
  useEffect(() => { void load("reset"); }, [base, refreshTick]);
  useEffect(() => {
    if (!live || !base) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") void load("poll"); }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, base]);

  const total = types.reduce((a, x) => a + x.count, 0);
  return <>
    <PageHeader eyebrow={`Event stream · last ${days} days`} title="Live events"
      description={<>Every event your storefront has sent, newest first. {fmt(total)} in range.</>}
      actions={<button className={`btn ${live ? "btnPrimary" : "btnGhost"}`} onClick={() => setLive((v) => !v)}>{live ? <><span className="dot live" />Live<Pause /></> : <><Play />Resume live</>}</button>} />
    <ErrorBanner message={error} onRetry={() => void load("reset")} />
    <Card className="cardFlush">
      <div className="toolbar">
        <div className="searchBox"><Search /><input className="input" placeholder="Search session, visitor, page or property" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search events" /></div>
        <select className="select" value={event} onChange={(e) => setEvent(e.target.value)} aria-label="Event type">
          <option value="">All events</option>
          {types.map((t) => <option key={t.event} value={t.event}>{label(t.event)} ({fmt(t.count)})</option>)}
        </select>
        <select className="select" value={consent} onChange={(e) => setConsent(e.target.value)} aria-label="Consent level">
          <option value="">Any consent</option><option value="anonymous">Anonymous</option><option value="analytics">Analytics</option><option value="identified">Identified</option>
        </select>
      </div>
      {loading && !rows.length ? <div style={{ padding: "1.35rem" }}><Skeleton rows={8} /></div> : rows.length ? <div className="tableWrap"><table className="table">
        <thead><tr><th>Event</th><th className="hideSm">Page</th><th>Session</th><th className="hideSm">Consent</th><th className="num">When</th></tr></thead>
        <tbody>{rows.map((x) => <Fragment key={x.id}>
          <tr className="clickable" onClick={() => setOpen(open === x.id ? null : x.id)} style={fresh.has(x.id) ? { background: "var(--brand-soft)" } : undefined} aria-expanded={open === x.id}>
            <td><EventName event={x.event} /></td>
            <td className="hideSm muted mono">{pathOf(x.page)}</td>
            <td className="mono muted">{x.sessionId.slice(0, 18)}</td>
            <td className="hideSm"><ConsentPill consent={x.consent} /></td>
            <td className="num muted" title={dateTime(x.occurredAt)}>{ago(x.occurredAt)}</td>
          </tr>
          {open === x.id && <tr className="detailRow"><td colSpan={5}>
            <div style={{ display: "grid", gap: ".75rem" }}>
              <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", alignItems: "center" }}>
                <button className="btn btnPrimary btnSm" onClick={() => setSession(x.sessionId)}><Route />Session journey</button>
                <CopyButton text={x.sessionId} label="Copy session ID" />
                <CopyButton text={JSON.stringify({ ...x }, null, 2)} label="Copy JSON" />
                <span className="muted" style={{ fontSize: ".8rem" }}>{new Date(x.occurredAt).toLocaleString()}{x.referrer ? ` · from ${x.referrer}` : ""}</span>
              </div>
              {Object.keys(x.properties).length ? <pre className="code">{JSON.stringify(x.properties, null, 2)}</pre> : <span className="muted">No properties.</span>}
            </div>
          </td></tr>}
        </Fragment>)}</tbody>
      </table></div> : <Empty title={q || event || consent ? "No events match these filters." : "No events in this range yet."} icon={Activity} />}
      {cursor && <div className="tableFoot"><button className="btn btnGhost" onClick={() => void load("more")} disabled={loading}>{loading ? "Loading…" : "Load older events"}</button></div>}
    </Card>
    {session && <SessionDrawer sessionId={session} onClose={() => setSession(null)} />}
  </>;
}

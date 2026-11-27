"use client";
import { X } from "lucide-react";
import { useEffect } from "react";
import { useWorkspace } from "./context";
import { ConsentPill, duration, ErrorBanner, eventStyle, label, money, pathOf, Props, Skeleton, useApi } from "./ui";

type Journey = {
  sessionId: string; visitorId: string | null; consent: string; referrer: string | null;
  startedAt: number; endedAt: number; pages: number; outcome: string; revenue: number; cartValue: number;
  events: { id: string; event: string; occurredAt: number; page: string | null; properties: Record<string, unknown> }[];
};
const OUTCOME: Record<string, [string, string]> = {
  purchased: ["Purchased", "green"], checkout_abandoned: ["Checkout abandoned", "red"],
  cart_abandoned: ["Cart abandoned", "amber"], browsed: ["Browsed only", ""],
};

/** Slide-over showing every event in one session, oldest first. */
export function SessionDrawer({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { store } = useWorkspace();
  const { data, error, loading, reload } = useApi<Journey>(store ? `/api/sessions?storeId=${encodeURIComponent(store.id)}&sessionId=${encodeURIComponent(sessionId)}` : null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  const [outcome, tone] = OUTCOME[data?.outcome ?? "browsed"] ?? OUTCOME.browsed;
  let source = "Direct";
  if (data?.referrer) try { source = new URL(data.referrer).hostname.replace(/^www\./, ""); } catch { /* keep Direct */ }

  return <>
    <div className="scrim" onClick={onClose} />
    <aside className="drawer" role="dialog" aria-modal="true" aria-label="Session journey">
      <header>
        <div><small>SESSION JOURNEY</small><h2 className="mono">{sessionId}</h2></div>
        <button className="btn btnGhost iconBtn" onClick={onClose} aria-label="Close"><X /></button>
      </header>
      <div className="drawerBody">
        <ErrorBanner message={error} onRetry={() => void reload()} />
        {loading && !data ? <Skeleton rows={8} /> : data && <>
          <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}><span className={`pill ${tone}`}>{outcome}</span><ConsentPill consent={data.consent} />{data.visitorId && <span className="pill">visitor {data.visitorId}</span>}</div>
          <div className="facts">
            <div><small>Started</small><b>{new Date(data.startedAt).toLocaleString()}</b></div>
            <div><small>Duration</small><b>{duration(data.endedAt - data.startedAt)}</b></div>
            <div><small>Events · pages</small><b>{data.events.length} · {data.pages}</b></div>
            <div><small>Source</small><b>{source}</b></div>
            <div><small>{data.revenue ? "Revenue" : "Peak cart value"}</small><b>{money(data.revenue || data.cartValue)}</b></div>
          </div>
          <div className="timeline">{data.events.map((e) => {
            const { icon: Icon, tone: t } = eventStyle(e.event);
            return <div className="tlItem" key={e.id}>
              <span className={`evIcon ${t}`}><Icon /></span>
              <div><header>{label(e.event)}<time>{new Date(e.occurredAt).toLocaleTimeString()}</time></header><p>{pathOf(e.page)}</p><Props value={e.properties} /></div>
            </div>;
          })}</div>
        </>}
      </div>
    </aside>
  </>;
}

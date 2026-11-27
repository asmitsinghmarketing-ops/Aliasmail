"use client";
import Link from "next/link";
import { Activity, ArrowRight, Layers, MousePointerClick, Plug, ShoppingBag, Users } from "lucide-react";
import { useState } from "react";
import { useWorkspace } from "@/components/workspace/context";
import { CHART, TrendChart } from "@/components/workspace/charts";
import { SessionDrawer } from "@/components/workspace/session-drawer";
import { NewStoreForm } from "@/components/workspace/store-form";
import { ago, isRecent, BarList, Card, Delta, Empty, ErrorBanner, EventName, fmt, Kpi, label, PageHeader, pathOf, pct, ratio, Skeleton, useApi } from "@/components/workspace/ui";

type Totals = { events: number; sessions: number; visitors: number };
type Analytics = {
  summary: Totals; previous: Totals;
  funnel: { event: string; sessions: number }[];
  breakdown: { event: string; count: number }[];
  daily: { date: string; events: number; sessions: number }[];
  topPages: { page: string; views: number; sessions: number }[];
  sources: { source: string; sessions: number }[];
  consent: { consent: string; sessions: number }[];
  recent: { id: string; event: string; sessionId: string; occurredAt: number; consent: string; page: string | null }[];
  lastEventAt: number | null;
};
const CONSENT_COLORS: Record<string, string> = { identified: CHART.primary, analytics: CHART.secondary, anonymous: "#c9d4ce" };

export default function Overview() {
  const { store, stores, storesLoaded, query, days } = useWorkspace();
  const { data, error, loading, reload } = useApi<Analytics>(query ? `/api/analytics?${query}` : null);
  const [session, setSession] = useState<string | null>(null);

  if (!storesLoaded) return <Skeleton rows={6} height={28} />;
  if (!stores.length) return <Onboarding />;

  const s = data?.summary, p = data?.previous;
  const purchases = data?.funnel.find((x) => x.event === "purchase_completed")?.sessions ?? 0;
  const live = isRecent(data?.lastEventAt);
  const consentTotal = data?.consent.reduce((a, x) => a + x.sessions, 0) || 0;

  return <>
    <PageHeader eyebrow={`Overview · last ${days} days`} title={store?.name}
      description={<><span className="mono">{store?.domain}</span>{data && (data.lastEventAt
        ? <span className={`pill ${live ? "green" : "amber"}`}><span className={`dot ${live ? "live" : ""}`} />Last event {ago(data.lastEventAt)}</span>
        : <Link href="/dashboard/install" className="pill amber"><Plug size={12} />No events yet. Install the SDK.</Link>)}</>}
      actions={<Link className="btn btnGhost" href="/dashboard/events"><Activity />Live events</Link>} />
    <ErrorBanner message={error} onRetry={() => void reload()} />

    <section className="kpis">
      <Kpi label="Sessions" icon={Layers} loading={!data} value={fmt(s?.sessions)} sub={s && p && <><Delta current={s.sessions} previous={p.sessions} /> vs previous {days}d</>} />
      <Kpi label="Visitors" icon={Users} loading={!data} value={fmt(s?.visitors)} sub={s && p && <><Delta current={s.visitors} previous={p.visitors} /> vs previous {days}d</>} />
      <Kpi label="Events" icon={MousePointerClick} loading={!data} value={fmt(s?.events)} sub={s && <>{(s.sessions ? s.events / s.sessions : 0).toFixed(1)} per session</>} />
      <Kpi label="Purchase conversion" icon={ShoppingBag} loading={!data} value={pct(ratio(purchases, s?.sessions || 0))} sub={s && <>{fmt(purchases)} of {fmt(s.sessions)} sessions</>} />
    </section>

    <Card title="Traffic" subtitle="Sessions and events per day" action={<span className="legend" style={{ display: "flex", gap: "1rem" }}><div><i style={{ background: CHART.primary }} />Sessions</div><div><i style={{ background: CHART.secondary }} />Events</div></span>}>
      {loading && !data ? <Skeleton rows={6} height={30} /> : <TrendChart data={data?.daily ?? []} series={[{ key: "events", name: "Events", color: CHART.secondary }, { key: "sessions", name: "Sessions", color: CHART.primary }]} />}
    </Card>

    <div className="grid2">
      <Card title="Conversion funnel" subtitle="Unique sessions reaching each step" action={<Link href="/dashboard/commerce">Commerce <ArrowRight size={13} /></Link>}>
        {!data ? <Skeleton /> : !data.funnel[0]?.sessions ? <Empty title="No product views in this range." /> : <div className="funnel">{data.funnel.map((step, i) => {
          const top = data.funnel[0]?.sessions || 1, prev = data.funnel[i - 1]?.sessions;
          return <div className="funnelStep" key={step.event}>
            <header><span>{label(step.event)}</span><b>{fmt(step.sessions)}</b></header>
            <div className="funnelTrack"><i style={{ width: `${Math.max(1.5, (step.sessions / top) * 100)}%` }} /></div>
            {i > 0 && <span className="funnelDrop">{pct(ratio(step.sessions, prev || 0))} continued · <b>{fmt(Math.max(0, (prev || 0) - step.sessions))} dropped</b></span>}
          </div>;
        })}</div>}
      </Card>
      <Card title="Traffic sources" subtitle="Sessions by referring site">
        {!data ? <Skeleton /> : <BarList items={data.sources.map((x) => ({ key: x.source, label: x.source, value: x.sessions }))} empty="No sessions in this range." />}
      </Card>
    </div>

    <div className="grid3">
      <Card title="Top pages" subtitle="Page views">
        {!data ? <Skeleton /> : <BarList items={data.topPages.map((x) => ({ key: x.page, label: pathOf(x.page), value: x.views }))} empty="No page views yet." />}
      </Card>
      <Card title="Consent mix" subtitle="Sessions by consent level">
        {!data ? <Skeleton /> : consentTotal ? <>
          <div className="stack">{data.consent.map((x) => <i key={x.consent} style={{ flex: x.sessions, background: CONSENT_COLORS[x.consent] ?? "#c9d4ce" }} />)}</div>
          <div className="legend">{data.consent.map((x) => <div key={x.consent}><i style={{ background: CONSENT_COLORS[x.consent] ?? "#c9d4ce" }} />{label(x.consent)}<b>{pct(ratio(x.sessions, consentTotal))}</b></div>)}</div>
        </> : <Empty title="No sessions yet." />}
      </Card>
      <Card title="Signal mix" subtitle="Events by type">
        {!data ? <Skeleton /> : <BarList items={data.breakdown.slice(0, 7).map((x) => ({ key: x.event, label: label(x.event), value: x.count }))} empty="No events yet." />}
      </Card>
    </div>

    <Card title="Latest activity" subtitle="Select an event to open its session journey" action={<Link href="/dashboard/events">All events <ArrowRight size={13} /></Link>}>
      {!data ? <Skeleton /> : data.recent.length ? <div className="list">{data.recent.map((x) =>
        <button className="listItem" key={x.id} onClick={() => setSession(x.sessionId)}>
          <EventName event={x.event} /><div><small className="mono">{pathOf(x.page)} · {x.sessionId.slice(0, 18)}</small></div><time>{ago(x.occurredAt)}</time>
        </button>)}</div> : <Empty title="Waiting for the first event" icon={Plug}><Link className="btn btnPrimary btnSm" href="/dashboard/install">Install the SDK</Link></Empty>}
    </Card>
    {session && <SessionDrawer sessionId={session} onClose={() => setSession(null)} />}
  </>;
}

function Onboarding() {
  return <div className="obGrid">
    <section className="obHero">
      <small>WELCOME TO NEXTGO</small>
      <h1>Connect your first storefront.</h1>
      <p>NextGo turns consented storefront signals into journeys, funnels and recovery lists. It takes about five minutes.</p>
      <div className="steps">
        <div><i>1</i><span>Register the exact public origin of your store.</span></div>
        <div><i>2</i><span>Create a publishable key and paste the snippet into your site.</span></div>
        <div><i>3</i><span>Send commerce events. Funnels and abandoned carts fill in automatically.</span></div>
      </div>
    </section>
    <Card title="Store details" subtitle="You can add more stores later from Store settings.">
      <NewStoreForm />
    </Card>
  </div>;
}

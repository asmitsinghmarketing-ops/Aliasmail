"use client";
import { Download, FileJson, Search, ShieldCheck, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/workspace/context";
import { api, Card, ConfirmDialog, dateTime, Empty, EventName, fmt, PageHeader, pathOf, Skeleton, useApi } from "@/components/workspace/ui";

type Profile = { name: string | null; email: string | null; phone: string | null; consentVersion: string; consentedAt: number } | null;
type Lookup = { subject: string; profile: Profile; eventCount: number; events: { id: string; event: string; occurredAt: number; page: string | null }[] };
type Req = { id: string; kind: string; subject: string; status: string; createdAt: number; completedAt: number | null };

export default function Privacy() {
  const { store } = useWorkspace();
  const sid = store ? encodeURIComponent(store.id) : "";
  const history = useApi<{ requests: Req[] }>(store ? `/api/privacy?storeId=${sid}&history=1` : null);
  const [subject, setSubject] = useState("");
  const [result, setResult] = useState<Lookup | null>(null), [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false);

  async function lookup(e?: FormEvent) {
    e?.preventDefault();
    const s = subject.trim(); if (!s || !store) return;
    setBusy(true); setNotFound(false); setResult(null);
    try {
      const x = await api<Lookup>(`/api/privacy?storeId=${sid}&subject=${encodeURIComponent(s)}`);
      if (!x.eventCount && !x.profile) setNotFound(true); else setResult(x);
    } catch (err) { toast.error(err instanceof Error ? err.message : "Lookup failed"); } finally { setBusy(false); }
  }
  async function exportJson() {
    if (!result || !store) return;
    const full = await api<Lookup>(`/api/privacy?storeId=${sid}&subject=${encodeURIComponent(result.subject)}`);
    const blob = new Blob([JSON.stringify({ store: store.name, exportedAt: new Date().toISOString(), ...full }, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `nextgo-subject-${result.subject.slice(0, 40)}.json` });
    a.click(); URL.revokeObjectURL(a.href);
  }
  async function erase() {
    if (!result || !store) return;
    setBusy(true);
    try {
      await api("/api/privacy", { method: "DELETE", body: JSON.stringify({ storeId: store.id, subject: result.subject }) });
      toast.success(`Deleted ${fmt(result.eventCount)} events and profile data`);
      setResult(null); setSubject(""); setConfirming(false); await history.reload();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Deletion failed"); } finally { setBusy(false); }
  }

  return <>
    <PageHeader eyebrow="Data subject requests" title="Privacy requests" description="Find, export or erase everything stored about one visitor or session." />
    <Card title="Look up a subject" subtitle="Enter a visitor ID (from NextGo.identify) or a session ID.">
      <form onSubmit={lookup} style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
        <div className="searchBox" style={{ maxWidth: "none" }}><Search /><input className="input mono" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="vis_… or ses_…" aria-label="Subject ID" /></div>
        <button className="btn btnPrimary" disabled={busy || !subject.trim()}>{busy ? "Searching…" : "Look up"}</button>
      </form>
    </Card>

    {notFound && <div className="alert info"><Search />Nothing is stored for “{subject.trim()}” in {store?.name}.</div>}
    {result && <Card title={<span className="mono">{result.subject}</span>} subtitle={`${fmt(result.eventCount)} events stored`}
      action={<div style={{ display: "flex", gap: ".5rem" }}><button className="btn btnGhost btnSm" onClick={() => void exportJson()}><Download />Export JSON</button><button className="btn btnDanger btnSm" onClick={() => setConfirming(true)}><Trash2 />Delete all</button></div>}>
      <div className="facts" style={{ marginBottom: "1rem" }}>
        <div><small>Name</small><b>{result.profile?.name || "—"}</b></div>
        <div><small>Email</small><b>{result.profile?.email || "—"}</b></div>
        <div><small>Phone</small><b>{result.profile?.phone || "—"}</b></div>
        <div><small>Consent</small><b>{result.profile ? `${result.profile.consentVersion} · ${dateTime(result.profile.consentedAt)}` : "No identified profile"}</b></div>
      </div>
      {result.events.length ? <div className="list">{[...result.events].sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 12).map((e) =>
        <div className="listItem" key={e.id}><EventName event={e.event} /><div><small className="mono">{pathOf(e.page)}</small></div><time>{dateTime(e.occurredAt)}</time></div>)}</div> : null}
      {result.events.length > 12 && <p className="muted" style={{ fontSize: ".8rem", marginBottom: 0 }}>Showing 12 of {fmt(result.events.length)}. Export JSON for the full record.</p>}
    </Card>}

    <Card title="Request history" subtitle="Completed deletions for this store" className="cardFlush">
      {!history.data ? <div style={{ padding: "1.35rem" }}><Skeleton /></div> : history.data.requests.length ? <div className="tableWrap"><table className="table">
        <thead><tr><th>Request</th><th>Subject</th><th>Status</th><th className="num">Completed</th></tr></thead>
        <tbody>{history.data.requests.map((r) => <tr key={r.id}><td><b>{r.kind === "deletion" ? "Erasure" : r.kind}</b><code>{r.id}</code></td><td className="mono muted">{r.subject}</td><td><span className={`pill ${r.status === "completed" ? "green" : "amber"}`}>{r.status}</span></td><td className="num muted">{r.completedAt ? dateTime(r.completedAt) : "—"}</td></tr>)}</tbody>
      </table></div> : <Empty title="No privacy requests yet" icon={ShieldCheck} />}
    </Card>
    <p className="muted" style={{ fontSize: ".8rem", display: "flex", gap: ".4rem", alignItems: "center", margin: 0 }}><FileJson size={14} />Exports include the full stored profile. Share them only with the verified data subject.</p>

    {confirming && result && <ConfirmDialog title="Erase this subject?" danger busy={busy} confirmLabel="Delete permanently" confirmText="DELETE"
      body={<>This permanently deletes {fmt(result.eventCount)} events{result.profile ? " and the identified profile" : ""} for <code>{result.subject}</code>. A record of the request is kept.</>}
      onConfirm={() => void erase()} onClose={() => setConfirming(false)} />}
  </>;
}

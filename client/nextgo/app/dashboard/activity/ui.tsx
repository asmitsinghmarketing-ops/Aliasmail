"use client";
import { Globe, KeyRound, PenLine, ScrollText, ShieldCheck, Store as StoreIcon, type LucideIcon } from "lucide-react";
import { Card, dateTime, Empty, ErrorBanner, PageHeader, Skeleton, ago, useApi } from "@/components/workspace/ui";
import { useWorkspace } from "@/components/workspace/context";

type Entry = { id: string; action: string; details: string; createdAt: number; actorId: string };
const ACTIONS: Record<string, [string, LucideIcon, string]> = {
  "api_key.created": ["Publishable key created", KeyRound, "buy"],
  "api_key.revoked": ["Publishable key revoked", KeyRound, "id"],
  "store.created": ["Store connected", StoreIcon, "buy"],
  "store.renamed": ["Store renamed", PenLine, "view"],
  "store.domain_updated": ["Store domain changed", Globe, "cart"],
  "privacy.subject_deleted": ["Subject data erased", ShieldCheck, "id"],
};

function describe(e: Entry) {
  let d: Record<string, unknown> = {};
  try { d = JSON.parse(e.details); } catch { /* ignore */ }
  if (d.label) return `Label “${d.label}”`;
  if (d.domain) return String(d.domain);
  if (d.name) return `Now “${d.name}”`;
  if (d.requestId) return `Request ${d.requestId}`;
  if (d.keyId) return `Key ${d.keyId}`;
  return "";
}

export default function Activity() {
  const { store } = useWorkspace();
  const { data, error, reload } = useApi<{ entries: Entry[] }>(store ? `/api/audit?storeId=${encodeURIComponent(store.id)}` : null);
  return <>
    <PageHeader eyebrow="Audit trail" title="Activity log" description="Security-relevant changes to this store, most recent first." />
    <ErrorBanner message={error} onRetry={() => void reload()} />
    <Card>
      {!data ? <Skeleton rows={6} /> : data.entries.length ? <div className="timeline">{data.entries.map((e) => {
        const [title, Icon, tone] = ACTIONS[e.action] ?? [e.action, ScrollText, ""];
        return <div className="tlItem" key={e.id}>
          <span className={`evIcon ${tone}`}><Icon /></span>
          <div><header>{title}<time title={dateTime(e.createdAt)}>{ago(e.createdAt)}</time></header><p>{describe(e) || "—"} · {dateTime(e.createdAt)}</p></div>
        </div>;
      })}</div> : <Empty title="No activity yet" icon={ScrollText} />}
    </Card>
  </>;
}

"use client";
import Link from "next/link";
import { CircleCheck, KeyRound, Plug, Plus } from "lucide-react";
import { useState, useSyncExternalStore, type FormEvent } from "react";
import { toast } from "sonner";
import { useWorkspace } from "@/components/workspace/context";
import { api, ago, Card, ConfirmDialog, CopyButton, Empty, ErrorBanner, PageHeader, Skeleton, useApi } from "@/components/workspace/ui";

type ApiKey = { id: string; label: string; prefix: string; active: boolean; createdAt: number; lastUsedAt: number | null };
type Tab = "base" | "commerce" | "consent";
const noop = () => () => {};

export default function Install() {
  const { store, stores, storesLoaded, query } = useWorkspace();
  const keys = useApi<{ keys: ApiKey[] }>(store ? `/api/keys?storeId=${encodeURIComponent(store.id)}` : null);
  const status = useApi<{ lastEventAt: number | null; summary: { events: number } }>(query ? `/api/analytics?${query}` : null);
  const [created, setCreated] = useState<{ storeId: string; key: string } | null>(null), [busy, setBusy] = useState(false), [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [tab, setTab] = useState<Tab>("base");
  const origin = useSyncExternalStore(noop, () => location.origin, () => "https://YOUR-NEXTGO-DOMAIN");
  const secret = created && created.storeId === store?.id ? created.key : "";

  if (storesLoaded && !stores.length) return <Empty title="Connect a store first"><Link className="btn btnPrimary btnSm" href="/dashboard">Get started</Link></Empty>;
  const active = keys.data?.keys.filter((k) => k.active) ?? [];
  const last = status.data?.lastEventAt;
  const key = secret || "ng_live_YOUR_PUBLISHABLE_KEY";

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget, labelText = String(new FormData(form).get("label") || "");
    setBusy(true);
    try {
      const x = await api<{ key: string }>("/api/keys", { method: "POST", body: JSON.stringify({ storeId: store?.id, label: labelText }) });
      setCreated({ storeId: store?.id ?? "", key: x.key }); form.reset(); await keys.reload(); toast.success("Key created. Copy it now.");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not create key"); } finally { setBusy(false); }
  }
  async function revoke(k: ApiKey) {
    setBusy(true);
    try { await api(`/api/keys?id=${encodeURIComponent(k.id)}`, { method: "DELETE" }); await keys.reload(); toast.success(`${k.label} revoked`); setRevoking(null); }
    catch (err) { toast.error(err instanceof Error ? err.message : "Could not revoke key"); } finally { setBusy(false); }
  }

  const snippets: Record<Tab, string> = {
    base: `<script src="${origin}/nextgo.js" defer></script>
<script>
  window.addEventListener("DOMContentLoaded", () => {
    NextGo.init({ key: "${key}", endpoint: "${origin}" });
  });
</script>`,
    commerce: `// Product page
NextGo.commerce.productViewed({ productId: "sku-104", productName: "Everyday Backpack", price: 79, currency: "USD" });

// Add to cart (send the running cart total as cartValue)
NextGo.commerce.addedToCart({ productId: "sku-104", productName: "Everyday Backpack", quantity: 1, price: 79, cartValue: 79, currency: "USD" });

// Checkout and purchase
NextGo.commerce.checkoutStarted({ cartId: "cart-8fe2", itemCount: 1, cartValue: 79, currency: "USD" });
NextGo.commerce.purchaseCompleted({ orderId: "order-1842", revenue: 79, currency: "USD", itemCount: 1 });`,
    consent: `<script src="${origin}/nextgo.js"></script>
<script src="${origin}/nextgo-consent.js"></script>
<script>
  NextGo.init({ key: "${key}", endpoint: "${origin}" });
  NextGoConsent.show({ privacyUrl: "/privacy", consentVersion: "cart-recovery-v1" });
</script>`,
  };

  return <>
    <PageHeader eyebrow="Setup" title="Install & keys" description={<>Send events from <span className="mono">{store?.domain}</span>. Requests from any other origin are rejected.</>} />
    {status.data && (last
      ? <div className="alert ok"><CircleCheck />Connected. Last event received {ago(last)}.</div>
      : <div className="alert info"><Plug />No events received yet. Add the snippet below to {store?.domain}, then load any page.</div>)}

    {secret && <section className="secretBox" role="status">
      <h2>Copy your new key now</h2>
      <p>For security it is stored only as a hash and cannot be shown again. The snippets below already include it.</p>
      <code>{secret}</code>
      <div><CopyButton text={secret} label="Copy key" className="btn btnPrimary btnSm" /></div>
    </section>}

    <div className="grid21">
      <Card title="Add the snippet" subtitle="Paste into every page of your storefront, before the closing </body> tag.">
        <div className="tabs" role="tablist">
          {([["base", "1. Base script"], ["commerce", "2. Commerce events"], ["consent", "Consent banner"]] as [Tab, string][]).map(([id, name]) =>
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{name}</button>)}
        </div>
        <div className="codeWrap"><pre className="code">{snippets[tab]}</pre><CopyButton text={snippets[tab]} className="btn btnSm" /></div>
        <p className="muted" style={{ fontSize: ".8rem", marginBottom: 0 }}>Never send names, emails, phone numbers or payment data in event properties. Fields named like password, card, cvv, secret or token are dropped automatically.</p>
      </Card>

      <Card title="Publishable keys" subtitle={`${active.length} of 5 active`}>
        <form onSubmit={create} style={{ display: "flex", gap: ".5rem", marginBottom: "1rem" }}>
          <input className="input" name="label" placeholder="Label, e.g. Production" maxLength={40} style={{ flex: 1 }} aria-label="Key label" />
          <button className="btn btnPrimary" disabled={busy || active.length >= 5}><Plus />Create</button>
        </form>
        <ErrorBanner message={keys.error} onRetry={() => void keys.reload()} />
        {!keys.data ? <Skeleton /> : keys.data.keys.length ? <div className="list">{keys.data.keys.map((k) =>
          <div className="listItem" key={k.id}>
            <span className={`evIcon ${k.active ? "buy" : ""}`}><KeyRound /></span>
            <div><b>{k.label} <code className="muted">{k.prefix}…</code></b><small>{k.active ? (k.lastUsedAt ? `Used ${ago(k.lastUsedAt)}` : "Never used") : "Revoked"} · created {new Date(k.createdAt).toLocaleDateString()}</small></div>
            {k.active ? <button className="btn btnGhost btnSm" onClick={() => setRevoking(k)} disabled={busy}>Revoke</button> : <span className="pill">Revoked</span>}
          </div>)}</div> : <Empty title="No keys yet" icon={KeyRound}>Create one to start sending events.</Empty>}
      </Card>
    </div>

    <Card title="Event reference" subtitle="Canonical events NextGo understands">
      <div className="tableWrap"><table className="table">
        <thead><tr><th>Event</th><th>SDK call</th><th className="hideSm">Key properties</th></tr></thead>
        <tbody>{[
          ["page_viewed", "sent automatically by init()", "title"],
          ["product_viewed", "NextGo.commerce.productViewed()", "productId, productName, price"],
          ["added_to_cart", "NextGo.commerce.addedToCart()", "productId, quantity, cartValue"],
          ["removed_from_cart", "NextGo.commerce.removedFromCart()", "productId, quantity"],
          ["checkout_started", "NextGo.commerce.checkoutStarted()", "cartId, itemCount, cartValue"],
          ["purchase_completed", "NextGo.commerce.purchaseCompleted()", "orderId, revenue, currency"],
          ["customer_identified", "NextGo.identify(id, traits)", "requires identified consent"],
        ].map(([e, call, props]) => <tr key={e}><td className="mono">{e}</td><td className="mono muted">{call}</td><td className="hideSm muted">{props}</td></tr>)}</tbody>
      </table></div>
    </Card>
    {revoking && <ConfirmDialog title={`Revoke “${revoking.label}”?`} body="Sites using this key will stop sending events immediately. This cannot be undone." confirmLabel="Revoke key" danger busy={busy} onConfirm={() => void revoke(revoking)} onClose={() => setRevoking(null)} />}
  </>;
}

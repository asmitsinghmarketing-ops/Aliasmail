"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useWorkspace, type Store } from "@/components/workspace/context";
import { NewStoreForm } from "@/components/workspace/store-form";
import { api, Card, ConfirmDialog, PageHeader, Skeleton } from "@/components/workspace/ui";

export default function Settings() {
  const { store, storesLoaded, upsertStore, removeStore } = useWorkspace();
  const router = useRouter();
  const [busy, setBusy] = useState(false), [deleting, setDeleting] = useState(false);

  if (!storesLoaded) return <Skeleton rows={5} height={28} />;
  if (!store) return <>
    <PageHeader eyebrow="Workspace" title="Store settings" />
    <Card title="Connect a store"><NewStoreForm onDone={() => router.push("/dashboard")} /></Card>
  </>;
  const s = store;
  async function destroy() {
    setBusy(true);
    try {
      await api("/api/stores", { method: "DELETE", body: JSON.stringify({ storeId: s.id, confirmName: s.name }) });
      toast.success(`${s.name} deleted`); setDeleting(false); removeStore(s.id); router.push("/dashboard");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not delete store"); } finally { setBusy(false); }
  }

  return <>
    <PageHeader eyebrow="Workspace" title="Store settings" description={<>Created {new Date(s.createdAt).toLocaleDateString()} · <span className="mono">{s.id}</span></>} />
    <div className="grid2">
      {/* Keyed so the form resets whenever the saved store changes. */}
      <DetailsForm key={`${s.id}|${s.name}|${s.domain}`} store={s} onSaved={upsertStore} />
      <Card title="Add another store" subtitle="Each store gets its own keys, data and reports."><NewStoreForm submitLabel="Add store" /></Card>
    </div>
    <Card title="Danger zone" subtitle="Deleting a store permanently removes its keys, events, customer profiles and privacy records." className="danger"
      action={<button className="btn btnDanger" onClick={() => setDeleting(true)} disabled={busy}>Delete store</button>}>
      <p className="muted" style={{ margin: 0, fontSize: ".86rem" }}>Export anything you need first. This cannot be undone.</p>
    </Card>
    {deleting && <ConfirmDialog title={`Delete ${s.name}?`} danger busy={busy} confirmLabel="Delete store forever" confirmText={s.name}
      body="All keys stop working immediately and every event, profile and report for this store is erased."
      onConfirm={() => void destroy()} onClose={() => setDeleting(false)} />}
  </>;
}

function DetailsForm({ store: s, onSaved }: { store: Store; onSaved: (s: Store) => void }) {
  const [name, setName] = useState(s.name), [domain, setDomain] = useState(s.domain), [busy, setBusy] = useState(false);
  const dirty = name.trim() !== s.name || domain.trim() !== s.domain;
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, string> = { storeId: s.id };
      if (name.trim() !== s.name) body.name = name;
      if (domain.trim() !== s.domain) body.domain = domain;
      const x = await api<{ store: Store }>("/api/stores", { method: "PATCH", body: JSON.stringify(body) });
      onSaved(x.store); toast.success("Store updated");
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not save"); } finally { setBusy(false); }
  }
  return <>
    <Card title="Store details" subtitle="Changes are recorded in the activity log.">
      <form className="form" onSubmit={save}>
        <label className="field">Store name<input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required /></label>
        <label className="field">Storefront origin<input className="input mono" value={domain} onChange={(e) => setDomain(e.target.value)} required />
          <span className="hint">Changing this immediately rejects events from the old origin.</span></label>
        <div style={{ display: "flex", gap: ".5rem" }}>
          <button className="btn btnPrimary" disabled={busy || !dirty}>{busy ? "Saving…" : "Save changes"}</button>
          {dirty && <button type="button" className="btn btnGhost" onClick={() => { setName(s.name); setDomain(s.domain); }}>Reset</button>}
        </div>
      </form>
    </Card>
  </>;
}

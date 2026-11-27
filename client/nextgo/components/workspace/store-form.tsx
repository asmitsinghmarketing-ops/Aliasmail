"use client";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useWorkspace, type Store } from "./context";
import { api } from "./ui";

/** Creates a store and makes it the active one. */
export function NewStoreForm({ submitLabel = "Connect store", onDone }: { submitLabel?: string; onDone?: (s: Store) => void }) {
  const { upsertStore, setStoreId } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget, f = new FormData(form);
    setBusy(true); setError("");
    try {
      const { store } = await api<{ store: Store }>("/api/stores", { method: "POST", body: JSON.stringify({ name: f.get("name"), domain: f.get("domain") }) });
      upsertStore(store); setStoreId(store.id); form.reset();
      toast.success(`${store.name} connected`);
      onDone?.(store);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create store"); } finally { setBusy(false); }
  }
  return <form className="form" onSubmit={submit}>
    <label className="field">Store name<input className="input" name="name" maxLength={80} placeholder="Northwind Outfitters" required /></label>
    <label className="field">Storefront origin<input className="input" name="domain" placeholder="https://shop.example.com" required /><span className="hint">The exact public origin that will load the SDK. Events from any other origin are rejected.</span></label>
    {error && <div className="alert" role="alert">{error}</div>}
    <button className="btn btnPrimary" disabled={busy}>{busy ? "Connecting…" : submitLabel}</button>
  </form>;
}

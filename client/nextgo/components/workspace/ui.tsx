"use client";
import { ArrowDownRight, ArrowUpRight, Check, CircleAlert, Copy, CreditCard, Eye, Inbox, MousePointerClick, PackageCheck, ShoppingCart, Sparkles, UserCheck, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useWorkspace } from "./context";

/* ---------- data ---------- */

export class ApiError extends Error {}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  if (response.status === 401) {
    location.assign(`/api/auth/google?returnTo=${encodeURIComponent(location.pathname + location.search)}`);
    throw new ApiError("Your session expired. Redirecting to sign in.");
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new ApiError(body.error || `Request failed (${response.status})`);
  return body;
}

/** Fetches `url` whenever it or the workspace refresh tick changes. `null` skips. */
export function useApi<T>(url: string | null, options: { pollMs?: number } = {}) {
  const { refreshTick } = useWorkspace();
  const key = `${url}#${refreshTick}`;
  // `key` records which request produced the state, so loading is derived, not set.
  const [state, setState] = useState<{ key: string; data: T | null; error: string }>({ key: "", data: null, error: "" });
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!url) return;
    const mine = ++seq.current;
    try {
      const next = await api<T>(url);
      if (mine === seq.current) setState({ key, data: next, error: "" });
    } catch (e) {
      if (mine === seq.current) setState((s) => ({ key, data: s.data, error: e instanceof Error ? e.message : "Could not load data" }));
    }
  }, [url, key]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!options.pollMs || !url) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, options.pollMs);
    return () => clearInterval(timer);
  }, [load, options.pollMs, url]);
  // Data from another URL (e.g. the previous store) is never shown.
  const current = state.key.startsWith(`${url}#`);
  return { data: current ? state.data : null, error: current ? state.error : "", loading: Boolean(url) && state.key !== key, reload: load };
}

/* ---------- formatting ---------- */

const nf = new Intl.NumberFormat();
export const fmt = (v: number | null | undefined) => nf.format(Number(v || 0));
export const compact = (v: number) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(v);
export const money = (v: number | null | undefined, digits = 2) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits === 0 ? 0 : undefined }).format(Number(v || 0));
export const pct = (v: number | null | undefined) => `${(Number(v || 0)).toFixed(1).replace(/\.0$/, "")}%`;
export const ratio = (a: number, b: number) => (b ? (a / b) * 100 : 0);
export const label = (event: string) => event.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
export const dateTime = (ms: number) => new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const shortDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
export function ago(ms: number | null | undefined) {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
/** True when `ms` is within the last day. */
export const isRecent = (ms: number | null | undefined) => Boolean(ms && Date.now() - ms < 86_400_000);
export function pathOf(url: string | null | undefined) {
  if (!url) return "—";
  try { return new URL(url).pathname || "/"; } catch { return url; }
}
export function duration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/* ---------- event visuals ---------- */

export function eventStyle(event: string): { icon: LucideIcon; tone: string } {
  if (event === "purchase_completed") return { icon: PackageCheck, tone: "buy" };
  if (event.includes("cart")) return { icon: ShoppingCart, tone: "cart" };
  if (event.startsWith("checkout")) return { icon: CreditCard, tone: "cart" };
  if (event === "product_viewed") return { icon: Eye, tone: "view" };
  if (event === "customer_identified") return { icon: UserCheck, tone: "id" };
  if (event === "page_viewed") return { icon: MousePointerClick, tone: "" };
  return { icon: Sparkles, tone: "" };
}
export function EventName({ event }: { event: string }) {
  const { icon: Icon, tone } = eventStyle(event);
  return <span className="evName"><span className={`evIcon ${tone}`}><Icon /></span>{label(event)}</span>;
}
export function ConsentPill({ consent }: { consent: string }) {
  const tone = consent === "identified" ? "red" : consent === "analytics" ? "amber" : "";
  return <span className={`pill ${tone}`}>{consent}</span>;
}
export function Props({ value, max = 6 }: { value: Record<string, unknown>; max?: number }) {
  const entries = Object.entries(value).filter(([, v]) => v !== null && v !== "" && typeof v !== "object").slice(0, max);
  if (!entries.length) return null;
  return <div className="props">{entries.map(([k, v]) => <span key={k}><em>{k}</em>{String(v).slice(0, 60)}</span>)}</div>;
}

/* ---------- layout pieces ---------- */

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return <div className="pageHead"><div><small>{eyebrow}</small><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="actions">{actions}</div>}</div>;
}

export function Card({ title, subtitle, action, children, className = "" }: { title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{(title || action) && <header><div>{title && <h2>{title}</h2>}{subtitle && <p>{subtitle}</p>}</div>{action}</header>}{children}</section>;
}

export function Delta({ current, previous, invert = false }: { current: number; previous: number; invert?: boolean }) {
  if (!previous && !current) return <span className="delta flat">—</span>;
  if (!previous) return <span className="delta up">new</span>;
  const change = ((current - previous) / previous) * 100;
  const good = invert ? change < 0 : change > 0;
  const tone = Math.abs(change) < 0.5 ? "flat" : good ? "up" : "down";
  const Icon = change >= 0 ? ArrowUpRight : ArrowDownRight;
  return <span className={`delta ${tone}`}><Icon />{Math.abs(change).toFixed(Math.abs(change) < 10 ? 1 : 0)}%</span>;
}

export function Kpi({ label: name, value, icon: Icon, sub, loading }: { label: string; value: ReactNode; icon?: LucideIcon; sub?: ReactNode; loading?: boolean }) {
  return <article className="kpi"><small>{Icon && <Icon />}{name}</small>{loading ? <span className="skel" style={{ height: 30, width: "60%" }} /> : <strong>{value}</strong>}{sub && <span className="sub">{sub}</span>}</article>;
}

export function BarList({ items, empty = "No data yet." }: { items: { key: string; label: ReactNode; value: number; display?: ReactNode }[]; empty?: string }) {
  if (!items.length) return <Empty title={empty} />;
  const max = Math.max(...items.map((x) => x.value), 1);
  return <div className="barList">{items.map((x) => <div className="barRow" key={x.key}><i style={{ width: `${(x.value / max) * 100}%` }} /><span>{x.label}</span><b>{x.display ?? fmt(x.value)}</b></div>)}</div>;
}

export function Empty({ title, children, icon: Icon = Inbox }: { title: string; children?: ReactNode; icon?: LucideIcon }) {
  return <div className="empty"><Icon /><b>{title}</b>{children}</div>;
}

export function Skeleton({ rows = 4, height = 18 }: { rows?: number; height?: number }) {
  return <div style={{ display: "grid", gap: 10 }}>{Array.from({ length: rows }, (_, i) => <span key={i} className="skel" style={{ height, width: `${90 - i * 12}%` }} />)}</div>;
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  if (!message) return null;
  return <div className="alert" role="alert"><CircleAlert />{message}{onRetry && <button className="btn btnGhost btnSm" onClick={onRetry}>Retry</button>}</div>;
}

export function Segmented<T extends string | number>({ value, options, onChange, ariaLabel }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; ariaLabel: string }) {
  return <div className="seg" role="group" aria-label={ariaLabel}>{options.map((o) => <button key={String(o.value)} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}

export function CopyButton({ text, label: text2 = "Copy", className = "btn btnGhost btnSm" }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" className={className} onClick={() => { void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1600); }); }}>{done ? <Check /> : <Copy />}{done ? "Copied" : text2}</button>;
}

/** Modal confirmation. When `confirmText` is set, the user must type it to proceed. */
export function ConfirmDialog({ title, body, confirmLabel, confirmText, danger, busy, onConfirm, onClose }: { title: string; body: ReactNode; confirmLabel: string; confirmText?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return <>
    <div className="scrim" onClick={onClose} />
    <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
      <h2>{title}</h2>
      <p>{body}</p>
      {confirmText && <label className="field">Type <code>{confirmText}</code> to confirm<input className="input" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} /></label>}
      <footer>
        <button className="btn btnGhost" onClick={onClose} disabled={busy}>Cancel</button>
        <button className={`btn ${danger ? "btnDanger" : "btnPrimary"}`} disabled={busy || (confirmText !== undefined && typed.trim() !== confirmText)} onClick={onConfirm}>{busy ? "Working…" : confirmLabel}</button>
      </footer>
    </div>
  </>;
}

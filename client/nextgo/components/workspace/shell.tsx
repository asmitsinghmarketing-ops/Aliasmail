"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, ChevronRight, KeyRound, LayoutDashboard, LogOut, Menu, RefreshCw, ScrollText, Settings, ShieldCheck, ShoppingBag, ShoppingCart } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { BrandLogo } from "@/components/brand-logo";
import { WorkspaceContext, type Store, type WorkspaceUser } from "./context";
import { api, Segmented } from "./ui";

const NAV = [
  { group: "Analyze", items: [
    { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
    { href: "/dashboard/commerce", label: "Commerce", icon: ShoppingBag },
    { href: "/dashboard/commerce/abandoned", label: "Abandoned carts", icon: ShoppingCart },
    { href: "/dashboard/events", label: "Live events", icon: Activity },
  ] },
  { group: "Manage", items: [
    { href: "/dashboard/install", label: "Install & keys", icon: KeyRound },
    { href: "/dashboard/privacy", label: "Privacy requests", icon: ShieldCheck },
    { href: "/dashboard/activity", label: "Activity log", icon: ScrollText },
    { href: "/dashboard/settings", label: "Store settings", icon: Settings },
  ] },
];
const RANGED = ["/dashboard", "/dashboard/commerce", "/dashboard/commerce/abandoned", "/dashboard/events"];
const STORE_KEY = "nextgo.store", DAYS_KEY = "nextgo.days";

export function WorkspaceShell({ user, children }: { user: WorkspaceUser; children: ReactNode }) {
  const pathname = usePathname();
  const [stores, setStores] = useState<Store[]>([]);
  const [storesLoaded, setStoresLoaded] = useState(false);
  const [storeId, setStoreIdState] = useState("");
  const [days, setDaysState] = useState(30);
  const [refreshTick, setRefreshTick] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    const savedDays = Number(localStorage.getItem(DAYS_KEY));
    // Restoring a persisted preference after hydration; reading it during render would mismatch SSR.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if ([7, 30, 90].includes(savedDays)) setDaysState(savedDays);
    api<{ stores: Store[] }>("/api/stores").then((x) => {
      setStores(x.stores);
      const saved = localStorage.getItem(STORE_KEY);
      setStoreIdState(x.stores.find((s) => s.id === saved)?.id || x.stores[0]?.id || "");
    }).catch((e) => setLoadError(e instanceof Error ? e.message : "Could not load stores")).finally(() => setStoresLoaded(true));
  }, []);

  const setStoreId = useCallback((id: string) => { setStoreIdState(id); localStorage.setItem(STORE_KEY, id); }, []);
  const setDays = useCallback((d: number) => { setDaysState(d); localStorage.setItem(DAYS_KEY, String(d)); }, []);
  const upsertStore = useCallback((s: Store) => {
    setStores((all) => all.some((x) => x.id === s.id) ? all.map((x) => (x.id === s.id ? s : x)) : [s, ...all]);
  }, []);
  const removeStore = useCallback((id: string) => {
    setStores((all) => {
      const rest = all.filter((x) => x.id !== id);
      setStoreIdState(rest[0]?.id || "");
      return rest;
    });
  }, []);
  const store = stores.find((s) => s.id === storeId);
  const query = store ? `storeId=${encodeURIComponent(store.id)}&days=${days}&tz=${new Date().getTimezoneOffset()}` : "";
  const value = useMemo(() => ({ user, stores, store, storesLoaded, setStoreId, days, setDays, query, refreshTick, refresh: () => setRefreshTick((t) => t + 1), upsertStore, removeStore }),
    [user, stores, store, storesLoaded, setStoreId, days, setDays, query, refreshTick, upsertStore, removeStore]);
  const current = NAV.flatMap((g) => g.items).find((i) => i.href === pathname);
  const initials = (user.name || user.email).split(/[\s@.]/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("");

  return <WorkspaceContext.Provider value={value}>
    <div className={`ws${navOpen ? " navOpen" : ""}`} onClick={(e) => { if (navOpen && e.target === e.currentTarget) setNavOpen(false); }}>
      <aside className="wsSide" aria-label="Workspace navigation">
        <div className="wsBrand"><Link href="/dashboard" aria-label="NextGo overview"><BrandLogo /></Link></div>
        {stores.length > 0 && <div className="wsStore">
          <label htmlFor="ws-store">Store</label>
          <select id="ws-store" value={storeId} onChange={(e) => setStoreId(e.target.value)}>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </div>}
        <nav className="wsNav">
          {NAV.map((g) => <div key={g.group} style={{ display: "grid", gap: ".15rem" }}>
            <small>{g.group}</small>
            {g.items.map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setNavOpen(false)} aria-current={pathname === href ? "page" : undefined}><Icon />{label}</Link>)}
          </div>)}
        </nav>
        <div className="wsUser">
          <span className="wsAvatar">{user.avatarUrl ? <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" /> : initials}</span>
          <div><b>{user.name || "Account"}</b><span>{user.email}</span></div>
          <form action="/api/auth/logout?returnTo=%2F" method="post"><button type="submit" title="Sign out" aria-label="Sign out"><LogOut size={17} /></button></form>
        </div>
      </aside>
      <div className="wsMain">
        <header className="wsTop">
          <button className="btn btnGhost iconBtn wsMenu" aria-label="Open navigation" onClick={() => setNavOpen(true)}><Menu /></button>
          <div className="crumb">{store ? <><span>{store.name}</span><ChevronRight size={14} /></> : null}<b>{current?.label ?? "Workspace"}</b></div>
          <div className="spacer" />
          {RANGED.includes(pathname) && store && <Segmented ariaLabel="Reporting range" value={days} onChange={setDays} options={[{ value: 7, label: "7d" }, { value: 30, label: "30d" }, { value: 90, label: "90d" }]} />}
          {store && <button className="btn btnGhost iconBtn" title="Refresh data" aria-label="Refresh data" onClick={() => setRefreshTick((t) => t + 1)}><RefreshCw /></button>}
        </header>
        <main className="wsContent">
          {loadError && <div className="alert" role="alert">{loadError}</div>}
          {children}
        </main>
      </div>
    </div>
    <Toaster position="bottom-right" richColors closeButton />
  </WorkspaceContext.Provider>;
}

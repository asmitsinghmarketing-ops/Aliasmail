import Link from "next/link";
import { Activity, ArrowRight, Code2, Filter, KeyRound, Route, ShieldCheck, ShoppingCart } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";

const FEATURES = [
  { icon: Filter, title: "Commerce funnels", text: "See how many sessions move from product view to cart, checkout and purchase, and exactly where they drop." },
  { icon: ShoppingCart, title: "Abandoned carts", text: "Every cart that never converted, with value at risk and the last product touched. Export to CSV in one click." },
  { icon: Route, title: "Session journeys", text: "Open any session to replay its path, from the first page to the outcome, step by step." },
  { icon: Activity, title: "Live event stream", text: "Watch events arrive in real time. Filter by type or consent, and search by session, page or property." },
  { icon: ShieldCheck, title: "Consent built in", text: "Identity is stored only after explicit consent. Sensitive fields are dropped before they reach the database." },
  { icon: KeyRound, title: "Locked-down keys", text: "Publishable keys are hashed at rest, tied to one exact origin, rate limited and revocable at any time." },
];

export default async function Home({ searchParams }: { searchParams: Promise<{ authError?: string }> }) {
  const { authError } = await searchParams;
  return <main className="landing">
    <nav className="lNav">
      <Link className="brand" href="/" aria-label="NextGo home"><BrandLogo /></Link>
      <div className="lLinks"><a href="#features">Features</a><a href="#how">How it works</a><a href="#privacy">Privacy</a></div>
      <Link className="lBtn lBtnPrimary" href="/dashboard">Sign in with Google</Link>
    </nav>
    {authError && <div className="authError" role="alert"><b>Sign-in could not be completed.</b><span>{authError}</span><Link href="/dashboard">Try again</Link></div>}

    <section className="lHero">
      <div className="lHeroCopy">
        <span className="lEyebrow"><span className="lDot" />Commerce intelligence without surveillance</span>
        <h1>See why people <em>almost</em> bought.</h1>
        <p>NextGo turns consented storefront signals into funnels, journeys and recovery lists your team can act on today.</p>
        <div className="lCtas">
          <Link className="lBtn lBtnPrimary lBtnLg" href="/dashboard">Connect your store <ArrowRight size={18} /></Link>
          <a className="lBtn lBtnSoft lBtnLg" href="#how">See how it works</a>
        </div>
        <small className="lNote">Free to start · Installs with one script tag · No cookies required</small>
      </div>
      <div className="lPreview" aria-hidden="true">
        <div className="lPrevHead"><b>Northwind Outfitters</b><span className="lLive"><span className="lDot" />Live</span></div>
        <div className="lKpis">
          <div><small>Revenue</small><b>$15,229</b><i className="up">↗ 18%</i></div>
          <div><small>Conversion</small><b>10.5%</b><i className="up">↗ 2.1%</i></div>
          <div><small>Carts lost</small><b>226</b><i className="down">$27.8k at risk</i></div>
        </div>
        <div className="lFunnel">
          {[["Product viewed", 100, "795"], ["Added to cart", 43, "345"], ["Checkout started", 28, "221"], ["Purchase completed", 15, "119"]].map(([n, w, v]) =>
            <div key={n as string}><span>{n}</span><b>{v}</b><i><em style={{ width: `${w}%` }} /></i></div>)}
        </div>
        <div className="lStream">
          {[["purchase_completed", "$158.00", "just now"], ["added_to_cart", "Rain Shell Jacket", "12s ago"], ["product_viewed", "Trail Runner Shoes", "40s ago"]].map(([e, d, t]) =>
            <div key={e}><code>{e}</code><span>{d}</span><time>{t}</time></div>)}
        </div>
      </div>
    </section>

    <section className="lBand">{["Product views", "Add to cart", "Checkout intent", "Conversion", "Consent state", "Session journeys"].map((x) => <span key={x}>{x}</span>)}</section>

    <section className="lSection" id="features">
      <div className="lHead"><span className="lEyebrow">Everything in one workspace</span><h2>A behavioral map, not a data landfill.</h2><p>Follow every anonymous path from first touch to purchase, and see where intent turns into revenue or disappears.</p></div>
      <div className="lFeatures">{FEATURES.map(({ icon: Icon, title, text }) => <article key={title}><span className="lIcon"><Icon size={20} /></span><h3>{title}</h3><p>{text}</p></article>)}</div>
    </section>

    <section className="lSection" id="how">
      <div className="lHead"><span className="lEyebrow">Live in five minutes</span><h2>Three steps to your first funnel.</h2></div>
      <div className="lSteps">
        <div className="lStepList">
          {[["Connect your store", "Sign in with Google and register the exact public origin of your storefront."],
            ["Paste one snippet", "Create a publishable key and add the script tag to every page."],
            ["Send commerce events", "Call productViewed, addedToCart and purchaseCompleted. Reports fill in automatically."]].map(([t, d], i) =>
            <div key={t}><i>{i + 1}</i><div><b>{t}</b><p>{d}</p></div></div>)}
        </div>
        <pre className="lCode"><span className="c">{"<!-- every page -->"}</span>{"\n"}{'<script src="https://nextgo…/nextgo.js" defer></script>'}{"\n\n"}<span className="c">{"// product page"}</span>{"\n"}NextGo.commerce.<span className="k">productViewed</span>{"({\n  productId: \"sku-104\", price: 79\n});"}</pre>
      </div>
    </section>

    <section className="lPrivacy" id="privacy">
      <div><span className="lEyebrow">Privacy by design</span><h2>Built for consent, not around it.</h2></div>
      <ul>
        <li><ShieldCheck size={18} />Anonymous by default. Identity only after explicit consent.</li>
        <li><ShieldCheck size={18} />Passwords, card data and tokens are stripped before storage.</li>
        <li><ShieldCheck size={18} />Export or erase any visitor&apos;s data from the dashboard.</li>
        <li><Code2 size={18} />Keys are hashed at rest and locked to your store&apos;s origin.</li>
      </ul>
    </section>

    <section className="lCta"><h2>Find out where your buyers drop off.</h2><Link className="lBtn lBtnPrimary lBtnLg" href="/dashboard">Connect your store <ArrowRight size={18} /></Link></section>
    <footer className="lFoot"><BrandLogo /><p>Consent-first commerce intelligence.</p></footer>
  </main>;
}

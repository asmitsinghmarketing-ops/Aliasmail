import Link from "next/link";
import { BrandLogo } from "@/components/brand-logo";

export default async function Home({ searchParams }: { searchParams: Promise<{ authError?: string }> }) {
  const { authError } = await searchParams;
  return <main className="landing">
    <nav><Link className="brand" href="/" aria-label="NextGo home"><BrandLogo /></Link><Link href="/dashboard">Sign in with Google</Link></nav>
    {authError && <div className="authError" role="alert"><b>Sign-in could not be completed.</b><span>{authError}</span><Link href="/dashboard">Try again</Link></div>}
    <section className="hero"><small>COMMERCE INTELLIGENCE / WITHOUT SURVEILLANCE</small><h1>See why people <em>almost</em> bought.</h1><p>NextGo turns consented storefront signals into journeys, funnels and decisions your team can act on.</p><Link href="/dashboard">Connect your store</Link></section>
    <section className="band">PRODUCT VIEWS · ADD TO CART · CHECKOUT INTENT · CONVERSION · CONSENT STATE</section>
    <section className="story"><h2>A behavioral map,<br/>not a data landfill.</h2><p>Follow every anonymous path from first touch to purchase. Identity is accepted only after explicit consent, sensitive fields are rejected, and keys are origin-restricted and hashed at rest.</p></section>
    <section className="features">{[["01","Journey signals"],["02","Commerce funnels"],["03","Live event stream"],["04","Consent controls"]].map(x=><article key={x[0]}><small>{x[0]}</small><h3>{x[1]}</h3><p>Evidence your commerce team can inspect, understand and act on.</p></article>)}</section>
    <footer><BrandLogo /><p>Consent-first commerce intelligence.</p></footer>
  </main>;
}

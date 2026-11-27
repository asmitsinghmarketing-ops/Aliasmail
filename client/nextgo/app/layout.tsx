import type { Metadata } from "next";
import "./globals.css";
import "./production-fixes.css";

export const metadata: Metadata = {
  title: { default: "NextGo — Consent-first commerce intelligence", template: "%s | NextGo" },
  description: "Understand storefront journeys, funnels, and conversion signals without invasive tracking.",
  applicationName: "NextGo",
  robots: { index: true, follow: true },
  openGraph: { title: "NextGo", description: "Consent-first commerce intelligence", type: "website" },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className="antialiased">{children}</body></html>;
}

import type { ReactNode } from "react";
import { requireGoogleUser } from "@/lib/server-auth";
import { WorkspaceShell } from "@/components/workspace/shell";
import "./app.css";

export const dynamic = "force-dynamic";
export const metadata = { title: { default: "Workspace", template: "%s | NextGo" }, robots: { index: false, follow: false } };

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireGoogleUser("/dashboard");
  return <WorkspaceShell user={{ name: user.name, email: user.email, avatarUrl: user.avatarUrl }}>{children}</WorkspaceShell>;
}

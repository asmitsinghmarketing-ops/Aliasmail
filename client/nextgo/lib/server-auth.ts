import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeReturnTo, sessionUser, SESSION_COOKIE, type AuthenticatedUser } from "./auth";

export async function requireGoogleUser(returnTo: string): Promise<AuthenticatedUser> {
  const cookieStore = await cookies();
  const user = await sessionUser(cookieStore.get(SESSION_COOKIE)?.value);
  if (user) return user;
  // Local development only: accept the Sites mock sign-in so the workspace can be
  // previewed without Google credentials. Compiled out of production builds.
  if (import.meta.env.DEV) {
    const h = await headers(), userId = h.get("oai-authenticated-user-id"), email = h.get("oai-authenticated-user-email");
    if (userId && email) return { userId, email, name: "Local preview", avatarUrl: null };
    redirect(`/signin-with-chatgpt?return_to=${encodeURIComponent(safeReturnTo(returnTo))}`);
  }
  redirect(`/api/auth/google?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`);
}

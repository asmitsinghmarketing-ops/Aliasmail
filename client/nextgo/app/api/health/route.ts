import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { json } from "@/lib/core";

export async function GET() {
  const started = Date.now();
  try {
    await getDb().run(sql`select 1`);
    return json({ status: "ok", database: "reachable", version: "1.0.0", latencyMs: Date.now() - started });
  } catch {
    return json({ status: "degraded", database: "unreachable", version: "1.0.0" }, 503);
  }
}

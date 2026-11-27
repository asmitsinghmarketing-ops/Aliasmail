import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { stores } from "@/db/schema";

const DAY_MS = 86_400_000;

/** True when the signed-in user owns the store. */
export async function ownsStore(storeId: string | null | undefined, userId: string) {
  if (!storeId) return false;
  const rows = await getDb()
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.ownerId, userId)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Reads the reporting window from `days` (1-90, default 30) and the viewer's
 * timezone offset from `tz` (minutes, same sign as Date#getTimezoneOffset).
 */
export function reportingRange(request: NextRequest, now = Date.now()) {
  const params = request.nextUrl.searchParams;
  const days = Math.min(90, Math.max(1, Math.trunc(Number(params.get("days"))) || 30));
  const tz = Math.min(840, Math.max(-840, Math.trunc(Number(params.get("tz"))) || 0));
  const since = now - days * DAY_MS;
  return { days, tz, tzMs: tz * 60_000, now, since, previousSince: since - days * DAY_MS };
}

/** Fills a day-keyed series so charts get one point per local day. */
export function fillDays<T extends Record<string, number>>(
  rows: ({ day: number } & Partial<T>)[],
  range: { days: number; tzMs: number; now: number },
  empty: T,
) {
  const byDay = new Map(rows.map((row) => [Number(row.day), row]));
  const lastDay = Math.floor((range.now - range.tzMs) / DAY_MS);
  const series: ({ date: string } & T)[] = [];
  for (let day = lastDay - range.days + 1; day <= lastDay; day++) {
    const row = (byDay.get(day) ?? {}) as Partial<T>;
    const point = { ...empty } as T;
    for (const key of Object.keys(empty) as (keyof T)[]) point[key] = Number(row[key] ?? 0) as T[keyof T];
    series.push({ date: new Date(day * DAY_MS).toISOString().slice(0, 10), ...point });
  }
  return series;
}

/** SQL expression body for the viewer-local day number of `occurred_at`. */
export const DAY_DIVISOR = DAY_MS;

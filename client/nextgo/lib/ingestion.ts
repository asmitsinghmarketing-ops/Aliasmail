import { id, safeObject } from "./core";

export type IncomingEvent = {
  eventId?: unknown; event?: unknown; sessionId?: unknown; visitorId?: unknown;
  timestamp?: unknown; page?: unknown; referrer?: unknown; properties?: unknown; consent?: unknown;
};

export function parseEvent(raw: unknown, storeId: string, now = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as IncomingEvent;
  const event = typeof value.event === "string" ? value.event.trim() : "";
  const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(event) || !/^[A-Za-z0-9._:-]{8,100}$/.test(sessionId)) return null;
  const consent = value.consent === "identified" ? "identified" : value.consent === "analytics" ? "analytics" : "anonymous";
  const externalId = typeof value.eventId === "string" && /^[A-Za-z0-9._:-]{8,120}$/.test(value.eventId) ? value.eventId : id("client");
  const timestamp = typeof value.timestamp === "number" && Number.isFinite(value.timestamp) && Math.abs(value.timestamp - now) <= 604800000 ? Math.trunc(value.timestamp) : now;
  return { id: id("evt"), externalId, storeId, event, sessionId,
    visitorId: consent === "identified" && typeof value.visitorId === "string" ? value.visitorId.trim().slice(0, 120) || null : null,
    occurredAt: timestamp, page: cleanUrl(value.page), referrer: cleanUrl(value.referrer),
    properties: JSON.stringify(safeObject(value.properties)).slice(0, 12000), consent, createdAt: now };
}

function cleanUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 1000) return null;
  try { const url = new URL(value); return `${url.origin}${url.pathname}`.slice(0, 500); } catch { return null; }
}

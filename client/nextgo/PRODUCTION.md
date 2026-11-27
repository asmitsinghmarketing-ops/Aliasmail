# NextGo production operations

## Release gate

Run `npm run test`, generate and review Drizzle migrations, then run `npm run build`. Deploy only the exact commit that produced the archive. Verify `/api/health` returns HTTP 200 after deployment and send a synthetic `page_viewed` event from the registered store origin.

## Security model

- Merchant APIs require the authenticated Sites user and verify store ownership on every request.
- Publishable keys are displayed once, stored only as SHA-256 hashes, limited to five active keys, revocable, and locked to one exact HTTPS origin.
- Ingestion accepts at most 50 events and 256 KB per request, with 1,000 requests per key per minute.
- Client `eventId` values make retries idempotent through a unique database constraint.
- Identity is persisted only with `identified` consent. Password, card, CVV, token, authorization and secret-like properties are dropped.
- Key lifecycle operations are written to the audit log.

## Monitoring

Monitor `/api/health`, 5xx rate, 429 rate, ingestion latency and D1 storage growth. Alert when health fails twice consecutively, 5xx exceeds 1% for five minutes, or ingestion has no successful requests for an otherwise active store for 30 minutes.

Every error response carries `X-Request-Id`; use it when correlating Worker logs. Never log API-key values, visitor identifiers, event properties, or request bodies.

## Incident response

1. Revoke affected publishable keys from the merchant dashboard.
2. Confirm the registered origin and inspect the audit trail.
3. Roll back to the last successful Sites version if errors began after deployment.
4. Use the privacy endpoint to export or erase a subject by visitor/session identifier.
5. Document impact, affected stores, timestamps, remediation and follow-up controls.

## Backups and retention

Configure scheduled D1 exports before onboarding production merchants. Retain raw events only for the declared customer retention period; aggregate older data before deletion. Test restoration quarterly in a separate environment. Rate-limit buckets may be deleted after their expiry time.

## External services not bundled

Payments, fraud decisions, email/SMS delivery and transactional checkout require separately contracted providers, their own secrets, webhooks, reconciliation, compliance review and failure handling. They are intentionally not simulated by this analytics release.

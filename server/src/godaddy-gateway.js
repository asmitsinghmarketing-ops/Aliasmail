// GoDaddy Node.js Hosting's built-in email gateway: a service inside the app's own container
// (http://127.0.0.1:2525, never leaves the machine) that sends mail through GoDaddy without any
// mail port. Mail to outside addresses can go out here instead of through the cPanel relay.
// The gateway builds the message itself, so it takes only recipients, subject, text, HTML,
// Reply-To, From (on a domain verified for the app) and up to 10 attachments of 2 MB each.

const GATEWAY_URL = 'http://127.0.0.1:2525/api/email/send';
export const GATEWAY_LIMITS = { attachments: 10, attachmentBytes: 2 * 1024 * 1024, totalBytes: 5 * 1024 * 1024 };

/**
 * `notSent` is true when the gateway certainly did not send (it isn't running here, or it refused
 * the message), so another route may be tried; false when it may have (a timeout or server error).
 */
export class GatewayError extends Error {
  constructor(message, notSent) {
    super(message);
    this.notSent = notSent;
  }
}

/** Send { to, cc, bcc, subject, text, html, replyTo, from, attachments: [{ filename, content (base64), contentType }] }. */
export async function gatewaySend(payload, fetcher = (...args) => fetch(...args)) {
  let response;
  let body;
  try {
    response = await fetcher(GATEWAY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    // Nothing was listening (not on GoDaddy Node hosting): certainly not sent.
    const refused = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(String(err?.cause?.code || err?.code || err?.message));
    throw new GatewayError(refused ? 'GoDaddy’s email gateway isn’t available on this server' : `GoDaddy’s email gateway didn’t answer (${err.name === 'TimeoutError' ? 'timed out' : err.message}); the message may still have been sent`, refused);
  }
  try {
    body = await response.json();
  } catch {
    body = { success: false, error: `non-JSON response (HTTP ${response.status})` };
  }
  if (!response.ok || !body.success) {
    const reason = body.error || `HTTP ${response.status}`;
    // A 4xx is a refusal (nothing sent); a 5xx might have happened after handing it on.
    if (response.status >= 400 && response.status < 500) throw new GatewayError(`GoDaddy’s email gateway refused the message: ${reason}`, true);
    throw new GatewayError(`GoDaddy’s email gateway failed (${reason}); the message may still have been sent`, false);
  }
  return { messageId: body.messageId || '' };
}


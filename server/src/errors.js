export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Every detail a mail or network error carries; ImapFlow often leaves err.message empty. */
export function describeError(err) {
  const parts = [err?.code, err?.authenticationFailed && 'authentication failed', err?.responseText || err?.response, err?.message];
  return [...new Set(parts.filter(Boolean).map(String))].join(' - ') || String(err);
}

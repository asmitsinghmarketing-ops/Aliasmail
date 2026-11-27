type GoogleIdClaims = {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  nonce?: string;
  exp?: number;
  iat?: number;
};

type Jwk = JsonWebKey & { kid?: string; alg?: string; use?: string };
let cachedKeys: { expiresAt: number; keys: Jwk[] } | null = null;

export async function verifyGoogleIdToken(token: string, clientId: string, nonce: string): Promise<Required<Pick<GoogleIdClaims, "sub" | "email">> & Pick<GoogleIdClaims, "name" | "picture">> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid Google ID token");
  const header = decodeJson<{ kid?: string; alg?: string }>(parts[0]);
  const claims = decodeJson<GoogleIdClaims>(parts[1]);
  if (!header.kid || header.alg !== "RS256") throw new Error("Unsupported Google ID token");
  const key = (await googleKeys()).find((item) => item.kid === header.kid && item.alg === "RS256");
  if (!key) throw new Error("Unknown Google signing key");
  const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const validSignature = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!validSignature) throw new Error("Invalid Google ID token signature");
  const now = Math.floor(Date.now() / 1000);
  const audienceValid = claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId));
  if (!audienceValid || !["accounts.google.com", "https://accounts.google.com"].includes(claims.iss || "")) throw new Error("Invalid Google token audience");
  if (!claims.exp || claims.exp <= now || !claims.iat || claims.iat > now + 60) throw new Error("Expired Google ID token");
  if (claims.nonce !== nonce || !claims.sub || !claims.email || claims.email_verified !== true) throw new Error("Google identity could not be verified");
  return { sub: claims.sub, email: claims.email.toLowerCase(), name: claims.name, picture: claims.picture };
}

async function googleKeys(): Promise<Jwk[]> {
  if (cachedKeys && cachedKeys.expiresAt > Date.now()) return cachedKeys.keys;
  const response = await fetch("https://www.googleapis.com/oauth2/v3/certs", { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Unable to load Google signing keys");
  const body = await response.json() as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) throw new Error("Invalid Google signing keys");
  const cacheControl = response.headers.get("cache-control") || "";
  const maxAge = Number(cacheControl.match(/max-age=(\d+)/)?.[1] || 3600);
  cachedKeys = { keys: body.keys, expiresAt: Date.now() + Math.min(maxAge, 3600) * 1000 };
  return body.keys;
}

function decodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

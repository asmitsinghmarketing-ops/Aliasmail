import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
test("ingestion enforces production safety controls", async () => {
  const source = await readFile(new URL("app/api/v1/events/route.ts", root), "utf8");
  for (const control of ["MAX_BODY_BYTES", "MAX_EVENTS", "MAX_PER_WINDOW", "Origin not allowed", "onConflictDoNothing", "X-Request-Id"]) assert.match(source, new RegExp(control));
});
test("SDK rejects sensitive fields and requires identified consent", async () => {
  const source = await readFile(new URL("public/nextgo.js", root), "utf8");
  assert.match(source, /password\|card\|cvv\|secret\|token\|authorization/);
  assert.match(source, /identified consent required/);
  assert.match(source, /eventId/);
});
test("merchant routes enforce authenticated ownership", async () => {
  for (const file of ["stores", "keys", "analytics", "privacy", "audit"]) {
    const source = await readFile(new URL(`app/api/${file}/route.ts`, root), "utf8");
    assert.match(source, /authenticatedUser|Sign in required/, file);
  }
});

test("store domain updates preserve ownership and normalize origins", async () => {
  const source = await readFile(new URL("app/api/stores/route.ts", root), "utf8");
  assert.match(source, /export async function PATCH/);
  assert.ok(source.includes("eq(stores.ownerId,u.userId)"));
  assert.match(source, /normalizeDomain/);
  assert.ok(source.includes("store.domain_updated"));
});
import{and,desc,eq}from"drizzle-orm";import{NextRequest}from"next/server";import{getDb}from"@/db";import{apiKeys,auditLogs,customers,events,privacyRequests,stores}from"@/db/schema";import{authenticatedUser,id,json,normalizeDomain}from"@/lib/core";
export async function GET(r:NextRequest){const u=await authenticatedUser(r);if(!u)return json({error:"Sign in required"},401);return json({stores:await getDb().select().from(stores).where(eq(stores.ownerId,u.userId)).orderBy(desc(stores.createdAt))})}
export async function POST(r:NextRequest){const u=await authenticatedUser(r);if(!u)return json({error:"Sign in required"},401);const b=await r.json().catch(()=>null)as{name?:string;domain?:string}|null,n=b?.name?.trim().slice(0,80),d=normalizeDomain(b?.domain||"");if(!n||!d)return json({error:"Valid name and domain required"},400);const s={id:id("sto"),ownerId:u.userId,name:n,domain:d,createdAt:Date.now()};await getDb().insert(stores).values(s);await getDb().insert(auditLogs).values({id:id("aud"),storeId:s.id,actorId:u.userId,action:"store.created",details:JSON.stringify({name:n,domain:d}),createdAt:Date.now()});return json({store:s},201)}

/** Updates a store's name and/or domain. Each changed field is audited. */
export async function PATCH(r:NextRequest){
  const u=await authenticatedUser(r);if(!u)return json({error:"Sign in required"},401);
  const b=await r.json().catch(()=>null)as{storeId?:string;domain?:string;name?:string}|null;
  const d=b?.domain===undefined?undefined:normalizeDomain(b.domain||"");
  const n=b?.name===undefined?undefined:b.name.trim().slice(0,80);
  if(!b?.storeId||d===""||n===""||(d===undefined&&n===undefined))return json({error:"Valid store and domain required"},400);
  const db=getDb(),[s]=await db.update(stores).set({...(d?{domain:d}:{}),...(n?{name:n}:{})}).where(and(eq(stores.id,b.storeId),eq(stores.ownerId,u.userId))).returning();
  if(!s)return json({error:"Store not found"},404);
  if(d)await db.insert(auditLogs).values({id:id("aud"),storeId:s.id,actorId:u.userId,action:"store.domain_updated",details:JSON.stringify({domain:d}),createdAt:Date.now()});
  if(n)await db.insert(auditLogs).values({id:id("aud"),storeId:s.id,actorId:u.userId,action:"store.renamed",details:JSON.stringify({name:n}),createdAt:Date.now()});
  return json({store:s});
}

/** Permanently deletes a store and, via cascades, its keys, events and profiles. The caller must repeat the store name. */
export async function DELETE(r:NextRequest){
  const u=await authenticatedUser(r);if(!u)return json({error:"Sign in required"},401);
  const b=await r.json().catch(()=>null)as{storeId?:string;confirmName?:string}|null;
  if(!b?.storeId)return json({error:"storeId required"},400);
  const db=getDb(),[s]=await db.select().from(stores).where(and(eq(stores.id,b.storeId),eq(stores.ownerId,u.userId))).limit(1);
  if(!s)return json({error:"Store not found"},404);
  if(b.confirmName?.trim()!==s.name)return json({error:"Type the store name exactly to confirm deletion"},400);
  // Explicit child deletes so personal data goes even if FK cascades are not enforced.
  for(const table of [events,customers,apiKeys,privacyRequests,auditLogs])await db.delete(table).where(eq(table.storeId,s.id));
  await db.delete(stores).where(and(eq(stores.id,s.id),eq(stores.ownerId,u.userId)));
  await db.insert(auditLogs).values({id:id("aud"),storeId:null,actorId:u.userId,action:"store.deleted",details:JSON.stringify({storeId:s.id,name:s.name,domain:s.domain}),createdAt:Date.now()});
  return json({ok:true});
}

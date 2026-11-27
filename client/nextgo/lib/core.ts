import { NextRequest } from "next/server";
import { sessionUser, SESSION_COOKIE } from "./auth";
export async function authenticatedUser(r:NextRequest){const user=await sessionUser(r.cookies.get(SESSION_COOKIE)?.value);if(user)return user;const userId=r.headers.get("oai-authenticated-user-id"),email=r.headers.get("oai-authenticated-user-email");return userId&&email?{userId,email,name:null,avatarUrl:null}:null}
export function json(data:unknown,status=200,extra:HeadersInit={}){return Response.json(data,{status,headers:{"Cache-Control":"no-store",...extra}})}
export function id(p:string){return `${p}_${crypto.randomUUID().replaceAll("-","")}`}
export async function sha256(v:string){const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v));return[...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,"0")).join("")}
export function normalizeDomain(v:string){try{const x=v.trim().toLowerCase();return new URL(x.includes("://")?x:`https://${x}`).origin}catch{return""}}
export function safeObject(v:unknown):Record<string,unknown>{if(!v||Array.isArray(v)||typeof v!=="object")return{};return Object.fromEntries(Object.entries(v as Record<string,unknown>).filter(([k])=>!/password|card|cvv|secret|token|authorization/i.test(k)).slice(0,50))}

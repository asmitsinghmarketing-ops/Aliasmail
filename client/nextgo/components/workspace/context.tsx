"use client";
import { createContext, useContext } from "react";

export type Store = { id: string; name: string; domain: string; createdAt: number };
export type WorkspaceUser = { name: string | null; email: string; avatarUrl: string | null };
export type Workspace = {
  user: WorkspaceUser;
  stores: Store[];
  store: Store | undefined;
  storesLoaded: boolean;
  setStoreId: (id: string) => void;
  days: number;
  setDays: (days: number) => void;
  /** Query string fragment: storeId, days and tz. Empty until a store is selected. */
  query: string;
  refreshTick: number;
  refresh: () => void;
  upsertStore: (store: Store) => void;
  removeStore: (id: string) => void;
};

export const WorkspaceContext = createContext<Workspace | null>(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside the dashboard layout");
  return value;
}

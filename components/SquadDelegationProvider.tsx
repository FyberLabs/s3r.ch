"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { AssignmentClient } from "@/lib/assignment-client";
const Context = createContext<AssignmentClient | null>(null);
export function SquadDelegationProvider({ children, client }: { children: ReactNode; client?: AssignmentClient }) {
  return <Context.Provider value={client ?? null}>{children}</Context.Provider>;
}
export const useSquadDelegation = () => useContext(Context);

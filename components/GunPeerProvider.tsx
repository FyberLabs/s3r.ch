"use client";

import {
  createContext,
  useContext,
  useCallback,
  useRef,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type FeedGun = {
  get: (key: string) => FeedGun;
  put: (data: unknown) => FeedGun;
  on: (cb: (data: unknown, key?: string) => void) => { off?: () => void };
  map: () => {
    on: (cb: (data: unknown, key: string) => void) => { off?: () => void };
  };
};

export type GunPeerContextValue = {
  gun: FeedGun | null;
  register: (gun: FeedGun | null) => void;
};

const GunPeerContext = createContext<{
  gun: FeedGun | null;
  publish: (owner: symbol, gun: FeedGun | null) => void;
} | null>(null);

export function GunPeerProvider({ children }: { children: ReactNode }) {
  const [gun, setGun] = useState<FeedGun | null>(null);
  const registrations = useRef(new Map<symbol, FeedGun>());
  const publish = useCallback((owner: symbol, next: FeedGun | null) => {
    const peers = registrations.current;
    peers.delete(owner);
    if (next) peers.set(owner, next);
    setGun(Array.from(peers.values()).at(-1) ?? null);
  }, []);
  const value = useMemo(() => ({ gun, publish }), [gun, publish]);
  return (
    <GunPeerContext.Provider value={value}>{children}</GunPeerContext.Provider>
  );
}

export function useGunPeer(): GunPeerContextValue | null {
  const context = useContext(GunPeerContext);
  const owner = useRef(Symbol());
  const publish = context?.publish;
  const register = useCallback((gun: FeedGun | null) => publish?.(owner.current, gun), [publish]);
  return context ? { gun: context.gun, register } : null;
}

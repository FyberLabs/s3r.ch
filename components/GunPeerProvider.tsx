"use client";

import {
  createContext,
  useContext,
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

const GunPeerContext = createContext<GunPeerContextValue | null>(null);

export function GunPeerProvider({ children }: { children: ReactNode }) {
  const [gun, setGun] = useState<FeedGun | null>(null);
  const value = useMemo(
    () => ({ gun, register: setGun }),
    [gun],
  );
  return (
    <GunPeerContext.Provider value={value}>{children}</GunPeerContext.Provider>
  );
}

export function useGunPeer(): GunPeerContextValue | null {
  return useContext(GunPeerContext);
}

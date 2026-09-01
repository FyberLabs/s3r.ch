declare module "gun" {
  const Gun: unknown;
  export default Gun;
}

declare module "gun/browser" {
  const Gun: unknown;
  export default Gun;
}

declare module "gun/sea" {
  const SEA: {
    pair: () => Promise<{
      pub: string;
      priv: string;
      epub: string;
      epriv: string;
    }>;
  };
  export default SEA;
}

declare module "gun/sea.js" {
  const SEA: {
    pair: () => Promise<{
      pub: string;
      priv: string;
      epub: string;
      epriv: string;
    }>;
  };
  export default SEA;
}

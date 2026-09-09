/**
 * Panopticon allocate JSON fixtures. Shape matches
 * `products/turn/docs/turn-allocate-v0.md` (path A). No live secret.
 */

export const ALLOCATE_EXPIRES_AT = "2026-09-09T02:05:00+00:00";

export const ALLOCATE_TURN_URLS = [
  "turn:turn.example.com:3478",
  "turns:turn.example.com:443",
] as const;

export const ALLOCATE_OK_BODY = {
  iceServers: [
    {
      urls: [...ALLOCATE_TURN_URLS],
      username: "1757383200:s3rch-peer",
      credential: "dGVzdC1obWFjLW5vdC1hLXByb2Qtc2VjcmV0",
    },
    {
      urls: ["stun:stun.l.google.com:19302"],
    },
  ],
  expiresAt: ALLOCATE_EXPIRES_AT,
};

export const ALLOCATE_OK_NO_STUN = {
  iceServers: [
    {
      urls: "turn:turn.example.com:3478",
      username: "1757383200:s3rch-peer",
      credential: "dGVzdC1obWFjLW5vdC1hLXByb2Qtc2VjcmV0",
    },
  ],
  expiresAt: ALLOCATE_EXPIRES_AT,
};

export const ALLOCATE_PRIVATE_TURN = {
  iceServers: [
    {
      urls: ["turn:10.0.0.8:3478"],
      username: "1757383200:s3rch-peer",
      credential: "dGVzdC1obWFjLW5vdC1hLXByb2Qtc2VjcmV0",
    },
  ],
  expiresAt: ALLOCATE_EXPIRES_AT,
};

export const ALLOCATE_MISSING_CREDENTIAL = {
  iceServers: [
    {
      urls: ["turn:turn.example.com:3478"],
      username: "1757383200:s3rch-peer",
    },
  ],
  expiresAt: ALLOCATE_EXPIRES_AT,
};

export const ALLOCATE_BAD_EXPIRES = {
  iceServers: ALLOCATE_OK_BODY.iceServers,
  expiresAt: "not-a-date",
};

export const HOP_ENV = {
  PANOPTICON_TURN_BASE: "https://api.test.hyperme.sh",
  PANOPTICON_TENANT_ID: "11111111-2222-4333-8444-555555555555",
  PANOPTICON_API_KEY: "s3rch.lab-not-a-real-key",
};

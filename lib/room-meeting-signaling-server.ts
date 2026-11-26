import { randomBytes } from "node:crypto";
import { readBoundedIdentityJson } from "./identity/bounded-json";
import { isForumObjectId, isSeaPubkey } from "./identity/forum-check";
import { readSeaSessionCookie } from "./identity/sea-session-http";
import {
  createMeetingFrameSequence, MEETING_FRAME_BYTES, MEETING_LEASE_MS, MEETING_SEQUENCE_MAX,
  parseMeetingFrame, parseMeetingLease, type MeetingFrame, type MeetingLease,
} from "./meeting-signaling-contract";
import { matchesBrowserOrigin } from "./request-origin";

type Proof = Readonly<{ key: string; id: string; expiresAt: number }>;
type Member = Readonly<{ principal: string; proof: Proof; token: string }>;
type Mailbox = {
  sequence: ReturnType<typeof createMeetingFrameSequence>;
  frames: MeetingFrame[];
  bytes: number;
  acknowledged: number;
  delivered: number;
  sent: number;
};
type Meeting = {
  id: string;
  room: string;
  first: Member;
  second?: Member;
  lease?: MeetingLease;
  mail?: [Mailbox, Mailbox];
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
};
type RoomAuthority = {
  current(): boolean;
  principal(key: string): string | null;
  mayJoin(principal: string): boolean;
};

const makeId = () => randomBytes(16).toString("hex");
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const deny = (status: number) => Response.json({ error: "meeting-signaling-unavailable" }, { status, headers });
const exact = (row: Record<string, unknown>, ...keys: string[]) =>
  Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
const sameProof = (a: Proof, b: Proof) => a.id === b.id && a.key === b.key && a.expiresAt === b.expiresAt;
const validAck = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MEETING_SEQUENCE_MAX;
const frameSize = (value: MeetingFrame) => Buffer.byteLength(JSON.stringify(value));

/** A single web instance owns bounded, transient signaling for the declared origin. */
export function createRoomMeetingSignaling(input: {
  origin: string;
  tenant: string;
  verify(token: string): Promise<Proof>;
  authority(room: string, signal: AbortSignal): Promise<RoomAuthority>;
  clock?: () => number;
}) {
  const origin = new URL(input.origin);
  const now = input.clock ?? Date.now;
  const rooms = new Map<string, Meeting>();
  let inflight = 0;
  let lastTime = 0;

  function close(key: string, row: Meeting) {
    if (rooms.get(key) !== row) return;
    clearTimeout(row.timer);
    row.mail?.forEach(mail => { mail.sequence.close(); mail.frames = []; });
    rooms.delete(key);
  }
  function observe() {
    const time = now();
    if (!Number.isSafeInteger(time) || time < lastTime) {
      for (const [key, row] of rooms) close(key, row);
      throw Error("Meeting time unavailable");
    }
    lastTime = time;
    return time;
  }
  function scheduleExpiry(key: string, row: Meeting, time: number) {
    clearTimeout(row.timer);
    row.timer = setTimeout(() => close(key, row), row.expiresAt - time);
    row.timer.unref();
  }
  function establish(row: Meeting, second: Member, time: number) {
    const participants = [row.first, second].map(member => ({
      principal: member.principal, key: member.proof.key, session: makeId(),
    }));
    const expiresAt = Math.min(time + MEETING_LEASE_MS, row.first.proof.expiresAt, second.proof.expiresAt);
    const lease = parseMeetingLease({
      v: 1, tenant: input.tenant, room: row.room, meeting: row.id, generation: makeId(),
      issuedAt: time, expiresAt, participants, offerer: row.first.principal,
    }, time);
    const mailbox = (recipient: string): Mailbox => ({
      sequence: createMeetingFrameSequence(lease, recipient, time),
      frames: [], bytes: 0, acknowledged: 0, delivered: 0, sent: 0,
    });
    row.lease = lease;
    row.second = second;
    row.expiresAt = expiresAt;
    row.mail = [mailbox(second.principal), mailbox(row.first.principal)];
  }

  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST" || request.headers.has("authorization") || !matchesBrowserOrigin(request, origin))
      return deny(403);
    if (inflight >= 16) return deny(503);
    const token = readSeaSessionCookie(request);
    if (!token) return deny(401);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(2000)]);
    inflight++;
    try {
      let proof: Proof;
      try { proof = await input.verify(token); } catch { return deny(401); }
      if (!request.body || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
          ![null, "identity"].includes(request.headers.get("content-encoding"))) return deny(400);
      const raw = await readBoundedIdentityJson(new Response(request.body), MEETING_FRAME_BYTES + 2048, signal);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return deny(400);
      const command = raw as Record<string, unknown>;
      const { operation, room, peer, after } = command;
      if (typeof room !== "string" || !isForumObjectId(room, "room") ||
          typeof peer !== "string" || !isSeaPubkey(peer)) return deny(400);
      if (operation === "admit") {
        if (!exact(command, "operation", "peer", "room")) return deny(400);
      } else if (operation === "send") {
        if (!exact(command, "frame", "operation", "peer", "room")) return deny(400);
      } else if (operation === "read") {
        if (!exact(command, "after", "generation", "operation", "peer", "room") ||
            !validAck(after) || typeof command.generation !== "string") return deny(400);
      } else return deny(400);

      const authority = await input.authority(room, signal);
      signal.throwIfAborted();
      const principal = authority.principal(proof.key);
      if (!authority.current() || !principal || peer === principal) return deny(403);
      const key = JSON.stringify(principal < peer ? [room, principal, peer] : [room, peer, principal]);
      const current = rooms.get(key);
      const time = observe();
      if (proof.expiresAt <= time || !authority.mayJoin(principal) || !authority.mayJoin(peer)) {
        if (current) close(key, current);
        return deny(403);
      }
      if (current && current.expiresAt <= time) close(key, current);
      const row = rooms.get(key);
      const member = { principal, proof, token };
      if (!row) {
        if (operation !== "admit") return deny(409);
        if (rooms.size >= 16) return deny(503);
        const expiresAt = Math.min(time + MEETING_LEASE_MS, proof.expiresAt);
        const waiting: Meeting = { id: makeId(), room, first: member, expiresAt };
        rooms.set(key, waiting);
        scheduleExpiry(key, waiting, time);
        return Response.json({ state: "waiting", expiresAt }, { headers });
      }
      const isFirst = principal === row.first.principal;
      const other = isFirst ? row.second : row.first;
      if (other) {
        let otherProof: Proof;
        try { otherProof = await input.verify(other.token); }
        catch { close(key, row); return deny(403); }
        signal.throwIfAborted();
        // A concurrent request may have completed or retired the generation.
        if (rooms.get(key) !== row || (isFirst ? row.second : row.first) !== other) return deny(409);
        if (!authority.current()) return deny(409);
        const checkedAt = observe();
        if (checkedAt >= row.expiresAt || proof.expiresAt <= checkedAt || otherProof.expiresAt <= checkedAt ||
            !sameProof(otherProof, other.proof) || authority.principal(otherProof.key) !== other.principal) {
          close(key, row);
          return deny(403);
        }
      }
      // The second member may have been set by a concurrent successful join.
      const own = isFirst ? row.first : row.second;
      if (own && !sameProof(own.proof, proof)) {
        close(key, row);
        return deny(409);
      }
      if (operation === "admit") {
        if (!isFirst && !row.lease) {
          const issuedAt = observe();
          establish(row, member, issuedAt);
          scheduleExpiry(key, row, issuedAt);
        }
        return row.lease
          ? Response.json({ state: "ready", lease: row.lease }, { headers })
          : Response.json({ state: "waiting", expiresAt: row.expiresAt }, { headers });
      }

      if (!own || !other || !row.lease || !row.mail) return deny(409);
      const lease = row.lease;
      if (operation === "read") {
        if (!validAck(after)) return deny(400);
        const incoming = row.mail[isFirst ? 1 : 0];
        if (command.generation !== lease.generation || after < incoming.acknowledged ||
            after > incoming.delivered) return deny(409);
        incoming.acknowledged = after;
        incoming.frames = incoming.frames.filter(frame => frame.seq > after);
        incoming.bytes = incoming.frames.reduce((size, frame) => size + frameSize(frame), 0);
        incoming.delivered = incoming.sent;
        return Response.json({ frames: incoming.frames, generation: lease.generation }, { headers });
      }

      const frame = parseMeetingFrame(command.frame, lease, observe());
      if (frame.from !== principal || frame.to !== peer) return deny(403);
      const outgoing = row.mail[isFirst ? 0 : 1];
      const bytes = frameSize(frame);
      if (frame.seq > outgoing.sent && (outgoing.frames.length >= 32 ||
          outgoing.bytes + bytes > 2 * MEETING_FRAME_BYTES)) return deny(409);
      const accepted = outgoing.sequence.accept(frame, observe());
      if (accepted) {
        outgoing.frames.push(accepted);
        outgoing.bytes += bytes;
        outgoing.sent = frame.seq;
      }
      const ack = { generation: lease.generation, sequence: frame.seq };
      if (frame.kind === "leave") close(key, row);
      return Response.json(ack, { headers });
    } catch {
      return deny(409);
    } finally {
      inflight--;
    }
  };
}

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGunPeer, type FeedGun } from "@/components/GunPeerProvider";
import { useSeeAcl } from "@/components/SeeAclProvider";
import { useIdentitySession } from "@/components/useIdentitySession";
import {
  btnPrimary,
  btnSecondary,
  btnTabOff,
  btnTabOn,
  chipOff,
  chipOn,
  field,
} from "@/lib/brand-ui";
import { toGunNode, type FeedItem } from "@/lib/feed-types";
import {
  PILOT_AGENTS,
  PILOT_ALARM,
  PILOT_CHAT,
  PILOT_FORUM_ID,
  PILOT_FORUM_LABEL,
  PILOT_LABELS,
  PILOT_NEEDS,
  admitPilotRoster,
} from "@/lib/forum-squad-fixture";
import {
  retainForumChat, forumChatFits,
  pendingNeedKey, statusRevisionAllowed, grantForumWatch, expireForumWatches, type ForumWatch,
  forumOfferCacheKey, offersForNeed, pendingClosureContext, needSignerCandidates,
  cacheForumStatus, parseStatusHighWater, retainPendingStatus, prunePendingStatuses,
  statusWatchCandidate, grantStatusWatch, expireStatusWatches, type PendingStatus,
  chatAddresses,
  chatTone,
  clampProgress,
  cacheForumNeed,
  chatRemovalCandidate,
  commitForumAlarm,
  composeForumNeeds,
  composeForumRoster,
  grantChatRemovalWatch,
  grantOfferTailWatch,
  mergeForumChat,
  offerRemovalAuthority,
  offerRowShouldQueue,
  offerSignerCandidates,
  offerTailCandidate,
  parseForumAlarmUpdate,
  parseNeedHighWater,
  pendingNeedRetry,
  pendingOfferRetry,
  prunePendingNeeds,
  prunePendingOffers,
  PENDING_NEED_TTL_MS,
  PENDING_OFFER_TTL_MS,
  raiseNeedHighWater,
  retainPendingNeed,
  retainPendingOffer,
  retireLocalChat,
  serializeNeedHighWater,
  takeExpiredChatRemovalWatches,
  takeExpiredOfferTailWatches,
  type PendingNeedEntry,
  type PendingOfferEntry,
  filterAgents,
  formatClock,
  formatRuntime,
  formatTokens,
  authorizeForumAlarm,
  authorizeForumAgentRemoval,
  authorizeForumChat,
  authorizeForumChatTombstone,
  authorizeForumMeshRemoval,
  authorizeForumNeed,
  authorizeForumOffer,
  authorizeForumRoleAdmission,
  chatAuthorFromStatementId,
  chatRetractionIds,
  createMeshEventVersions,
  forumChatRemovalSoul,
  forumNeedRemovalSoul,
  forumOfferCancelSoul,
  forumOfferRemovalSoul,
  forumOwnerMayWriteStatus,
  forumStatementFromNode,
  forumStatusRemovalSoul,
  forumNeedAdmission,
  forumStatusAdmission,
  liveReplayBlocked,
  ownerAdmitSig,
  mergeForumOffer,
  needClosureStatus,
  offerBlockedByCancel,
  offerCancelAwaitingKeys,
  offerSeeWait,
  needIds,
  openNeedFor,
  overlaySeeGraph,
  parseForumAgentRemoval,
  parseForumAgentStatus,
  parseForumMeshRemoval,
  parseForumNeed,
  parseForumOffer,
  parseForumRoleMembership,
  pausedStatus,
  pickDisplayedStatus,
  reassignedStatus,
  shortSea,
  showFullVitals,
  buildForumStatement,
  withoutChatIds,
  type SquadAgent,
  type VitalsMode,
} from "@/lib/forum-squad";
import { readForumSignature, signForumRecord, signatureOf } from "@/lib/forum-sign";
import { soulKeyMatches } from "@/lib/unshare";
import { browserGunOptions, listenThenConnectSeedPeer, type SeedPeerEmitter } from "@/lib/gun-peer";
import {
  acceptForumOffer,
  admitFeedNode,
  declineForumOffer,
  forumAgentSoul,
  forumAlarmSoul,
  forumChatTag,
  forumEmergencyAlarm,
  forumNeedSoul,
  forumOfferSoul,
  forumStatementSoul,
  isForumObjectId,
  isRoleToken,
  isSeaPubkey,
  isSeparateChatSoul,
  offerForumHelp,
  reopenForumNeed,
  validateForumStatus,
  type ForumAgentState,
  type ForumAgentStatus,
  type ForumAlarm,
  type ForumNeed,
  type ForumOffer,
  type SeeGraph,
} from "@/lib/identity/check";
import { getMeshKey, isPlaintextMeshKeyRecord } from "@/lib/identity/idb";
import type { SeaPair } from "@/lib/identity/sea";
import {
  readUnlockedMeshPair,
  rememberUnlockedMeshPair,
  subscribeUnlockedMeshPair,
} from "@/lib/identity/unlocked-mesh";
import { createMemorySeeAcl } from "@/lib/identity/see-acl";

const STATES: ForumAgentState[] = ["emergency", "needs", "working", "idle"];

function slug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function stateDot(state: ForumAgentState): string {
  if (state === "emergency") return "bg-status-fail";
  if (state === "needs") return "bg-signal";
  if (state === "working") return "bg-status-pass";
  return "bg-ink-muted";
}

function chainGet(gun: FeedGun, soul: string): FeedGun | null {
  if (isSeparateChatSoul(soul)) return null;
  const parts = soul.split("/");
  if (parts.length === 0 || parts.some((part) => part.length === 0)) return null;
  let node = gun;
  for (const part of parts) node = node.get(part);
  return node;
}

function putSoul(gun: FeedGun | null, soul: string, data: unknown): boolean {
  if (!gun) return false;
  const node = chainGet(gun, soul);
  if (!node) return false;
  node.put(data);
  return true;
}

const NEED_HIGH_WATER_KEY = "s3rch.forum.need-high-water.v1";

function forumStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function entropy(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function ChatBody({ body }: { body: string }) {
  const parts = body.split(/(@[A-Za-z][A-Za-z0-9-]{0,31})/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("@") && chatAddresses(part).length > 0 ? (
          <span key={`${index}-${part}`} className="font-semibold text-signal">
            {part}
          </span>
        ) : (
          <span key={`${index}-t`}>{part}</span>
        ),
      )}
    </>
  );
}

function authorLabel(pub: string): string {
  return PILOT_LABELS.get(pub) ?? shortSea(pub);
}

export function SquadForum() {
  const session = useIdentitySession();
  const see = useSeeAcl();
  const gunPeer = useGunPeer();
  const register = gunPeer?.register;
  const [seaPub, setSeaPub] = useState<string | null>(null);
  const [oauthLinked, setOauthLinked] = useState(false);
  const [vitals, setVitals] = useState<VitalsMode>("auto");
  const [tab, setTab] = useState<"board" | "chat">("board");
  const [filters, setFilters] = useState<Set<ForumAgentState>>(() => new Set());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
  const [reassignTo, setReassignTo] = useState("");
  const [meshStatus, setMeshStatus] = useState<Map<string, ForumAgentStatus>>(() => new Map());
  const [meshNeeds, setMeshNeeds] = useState<Map<string, ForumNeed>>(() => new Map());
  const [meshOffers, setMeshOffers] = useState<Map<string, ForumOffer>>(() => new Map());
  const [offerCancels, setOfferCancels] = useState<ReadonlySet<string>>(() => new Set());
  const [offerBody, setOfferBody] = useState("");
  const [meshAlarm, setMeshAlarm] = useState<ForumAlarm | null>(null);
  const [alarmHeard, setAlarmHeard] = useState(false);
  const [meshChat, setMeshChat] = useState<FeedItem[]>([]);
  const [localStatus, setLocalStatus] = useState<Map<string, ForumAgentStatus>>(() => new Map());
  const [localNeeds, setLocalNeeds] = useState<Map<string, ForumNeed>>(() => new Map());
  const [localOffers, setLocalOffers] = useState<Map<string, ForumOffer>>(() => new Map());
  const [localChat, setLocalChat] = useState<FeedItem[]>([]);
  const [hiddenChat, setHiddenChat] = useState<readonly string[]>([]);
  const [removedNeeds, setRemovedNeeds] = useState<ReadonlySet<string>>(() => new Set());
  const [removedOffers, setRemovedOffers] = useState<ReadonlySet<string>>(() => new Set());
  const [removedAgents, setRemovedAgents] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [chatTombs, setChatTombs] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [admitted, setAdmitted] = useState<ReadonlySet<string>>(
    () => new Set(PILOT_AGENTS.map((agent) => agent.status.seaPubkey)),
  );
  const gunRef = useRef<FeedGun | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const pairRef = useRef<SeaPair | null>(null);
  const graphRef = useRef<SeeGraph | null>(null);
  const needsRef = useRef<Map<string, ForumNeed>>(new Map());
  const offersRef = useRef<Map<string, ForumOffer>>(new Map());
  const pendingNeedsRef = useRef<Map<string, PendingNeedEntry>>(new Map());
  const alarmRevRef = useRef<number | undefined>(undefined);
  const pendingOffersRef = useRef<Map<string, PendingOfferEntry>>(new Map());
  const highWaterRef = useRef<Map<string, ForumNeed>>(new Map());
  const needAdmitRef = useRef<Map<string, string>>(new Map());
  const [persistedNeeds, setPersistedNeeds] = useState<Map<string, ForumNeed>>(() => new Map());
  const acceptNeedRef = useRef<(data: unknown, key: string, gen: number, fromRemoval?: boolean) => Promise<void>>(
    async () => {},
  );
  const acceptOfferRef = useRef<
    (
      data: unknown,
      key: string,
      parentNeedId: string,
      gen: number,
      fromCancel?: boolean,
      fromRemoval?: boolean,
    ) => Promise<boolean>
  >(async () => false);
  const offerCancelsRef = useRef<ReadonlySet<string>>(offerCancels);
  offerCancelsRef.current = offerCancels;
  const removedNeedsRef = useRef<ReadonlySet<string>>(removedNeeds);
  removedNeedsRef.current = removedNeeds;
  const removedOffersRef = useRef<ReadonlySet<string>>(removedOffers);
  removedOffersRef.current = removedOffers;
  const removedAgentsRef = useRef<ReadonlyMap<string, number>>(removedAgents);
  removedAgentsRef.current = removedAgents;
  const chatTombsRef = useRef<ReadonlyMap<string, number>>(chatTombs);
  chatTombsRef.current = chatTombs;
  const [aclRev, setAclRev] = useState(0);
  const chatIdsRef = useRef<string[]>([]);
  const chatRowsRef = useRef<FeedItem[]>([]);
  const admittedRef = useRef(admitted);
  const pendingStatusRef = useRef<Map<string, PendingStatus>>(new Map());
  const statusHighWaterRef = useRef<Map<string, ForumAgentStatus>>(new Map());
  const sampleAcl = useMemo(() => {
    const acl = createMemorySeeAcl();
    admitPilotRoster(acl);
    return acl;
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!session?.address) {
      pairRef.current = null;
      setSeaPub(null);
      return;
    }
    const address = session.address;
    const hold = (pair: SeaPair | null, pubHint: string | null) => {
      if (cancelled) return;
      if (pair && isSeaPubkey(pair.pub) && (!pubHint || pair.pub === pubHint)) {
        pairRef.current = pair;
        setSeaPub(pair.pub);
        return;
      }
      const held = readUnlockedMeshPair(address);
      if (pubHint && isSeaPubkey(pubHint)) {
        pairRef.current = held && held.pub === pubHint ? held : null;
        setSeaPub(pubHint);
        return;
      }
      pairRef.current = null;
      setSeaPub(null);
    };
    const stop = subscribeUnlockedMeshPair((heard, pair) => {
      if (heard !== address.trim().toLowerCase()) return;
      hold(pair, pair?.pub ?? null);
    });
    const remembered = readUnlockedMeshPair(address);
    if (remembered) hold(remembered, remembered.pub);
    void getMeshKey(address)
      .then((record) => {
        if (cancelled) return;
        const pub = record?.seaPub;
        const readable = pub && isSeaPubkey(pub) ? pub : null;
        if (record && isPlaintextMeshKeyRecord(record) && record.seaPair.pub === readable) {
          rememberUnlockedMeshPair(address, record.seaPair);
          hold(record.seaPair, readable);
          return;
        }
        hold(readUnlockedMeshPair(address), readable);
      })
      .catch(() => {
        if (cancelled) return;
        pairRef.current = null;
        setSeaPub(null);
      });
    return () => {
      cancelled = true;
      stop();
    };
  }, [session?.address]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/identity/oauth/session", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return false;
        const body = (await response.json()) as { linked?: unknown };
        return body.linked === true;
      })
      .then((linked) => {
        if (!cancelled) setOauthLinked(linked);
      })
      .catch(() => {
        if (!cancelled) setOauthLinked(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function noteNeedHighWater(need: ForumNeed) {
    if (!raiseNeedHighWater(highWaterRef.current, need)) return;
    const next = new Map(highWaterRef.current);
    setPersistedNeeds(next);
    try {
      forumStorage()?.setItem(NEED_HIGH_WATER_KEY, serializeNeedHighWater(next));
    } catch {
      // Private mode can refuse the write. The in-memory mark still holds.
    }
  }

  useEffect(() => {
    const loaded = parseNeedHighWater(forumStorage()?.getItem(NEED_HIGH_WATER_KEY) ?? null);
    const statuses = parseStatusHighWater(forumStorage()?.getItem("s3rch:squad:status-high-water:v1") ?? null, PILOT_FORUM_ID);
    statusHighWaterRef.current = statuses;
    setMeshStatus(new Map(statuses));
    highWaterRef.current = loaded;
    if (loaded.size > 0) setPersistedNeeds(loaded);
  }, []);

  useEffect(() => {
    if (!register) return;
    let cancelled = false;
    let offAgents: { off?: () => void } | undefined;
    let offNeeds: { off?: () => void } | undefined;
    const forumOffs = new Map<string, { off?: () => void }>();
    const forumWatches = new Map<string, ForumWatch>();
    const chatRemovalOffs = new Map<string, { off?: () => void }>();
    const statusOffs = new Map<string, { off?: () => void }>();
    let statusTimer: ReturnType<typeof setInterval> | undefined;
    const offerTailOffs = new Map<string, { off?: () => void }>();
    let offAlarm: { off?: () => void } | undefined;
    let offItems: { off?: () => void } | undefined;
    let offRoles: { off?: () => void } | undefined;

    void (async () => {
      const GunMod = await import("gun/browser");
      const Gun = (GunMod.default ?? GunMod) as unknown as (opts?: object) => FeedGun;
      if (cancelled) return;
      const gun = Gun(browserGunOptions());
      gunRef.current = gun;
      register(gun);
      listenThenConnectSeedPeer(gun as unknown as SeedPeerEmitter, window.location.origin, () => {});
      const forum = gun.get("s3rch").get("forums").get(PILOT_FORUM_ID);
      const versions = createMeshEventVersions();
      function knownChatIds(): string[] {
        return chatIdsRef.current;
      }
      function enrollPub(pub: string) {
        if (!admittedRef.current.has(pub)) {
          const next = new Set(admittedRef.current);
          next.add(pub);
          admittedRef.current = next;
          setAdmitted(next);
        }
        prunePendingStatuses(pendingStatusRef.current, Date.now());
        const waiting = pendingStatusRef.current.get(pub);
        if (!waiting) return;
        pendingStatusRef.current.delete(pub);
        watchStatusRemoval(pub);
        commitMeshStatus(waiting.status);
      }
      function commitMeshStatus(status: ForumAgentStatus) {
        if (!cacheForumStatus(statusHighWaterRef.current, status)) return;
        try {
          forumStorage()?.setItem("s3rch:squad:status-high-water:v1", JSON.stringify([...statusHighWaterRef.current.values()]));
        } catch { /* The in-memory floor survives until this page closes. */ }
        setMeshStatus((prev) => {
          const existing = prev.get(status.seaPubkey);
          if (existing && existing.lastUpdate > status.lastUpdate) return prev;
          const next = new Map(prev);
          next.set(status.seaPubkey, status);
          return next;
        });
        setLocalStatus((prev) => {
          const local = prev.get(status.seaPubkey);
          if (!local || status.lastUpdate < local.lastUpdate) return prev;
          const next = new Map(prev);
          next.delete(status.seaPubkey);
          return next;
        });
      }
      function dropMeshStatus(pub: string) {
        pendingStatusRef.current.delete(pub);
        setMeshStatus((prev) => {
          if (!prev.has(pub)) return prev;
          const next = new Map(prev);
          next.delete(pub);
          return next;
        });
        setLocalStatus((prev) => {
          if (!prev.has(pub)) return prev;
          const next = new Map(prev);
          next.delete(pub);
          return next;
        });
      }
      function hideChat(ids: string[]) {
        for (const id of ids) noteChatTomb(id);
        setHiddenChat((prev) => [...new Set([...prev, ...ids])]);
        setMeshChat((prev) => withoutChatIds(prev, ids));
        setLocalChat((prev) => withoutChatIds(prev, ids));
      }
      function noteOfferCancel(need: string, offer: string) {
        const id = forumOfferCacheKey(need, offer);
        if (offerCancelsRef.current.has(id)) return;
        const next = new Set(offerCancelsRef.current);
        next.add(id);
        offerCancelsRef.current = next;
        setOfferCancels(next);
      }
      function noteOfferRemoval(need: string, offer: string) {
        const id = forumOfferCacheKey(need, offer);
        if (removedOffersRef.current.has(id)) return;
        const next = new Set(removedOffersRef.current);
        next.add(id);
        removedOffersRef.current = next;
        setRemovedOffers(next);
      }
      function noteNeedRemoval(id: string) {
        if (removedNeedsRef.current.has(id)) return;
        const next = new Set(removedNeedsRef.current);
        next.add(id);
        removedNeedsRef.current = next;
        setRemovedNeeds(next);
      }
      function noteAgentRemoval(pub: string) {
        if (removedAgentsRef.current.has(pub)) return;
        const next = new Map(removedAgentsRef.current);
        next.set(pub, Number.POSITIVE_INFINITY);
        removedAgentsRef.current = next;
        setRemovedAgents(next);
      }
      function noteChatTomb(id: string) {
        if (chatTombsRef.current.has(id)) return;
        const next = new Map(chatTombsRef.current);
        next.set(id, Number.POSITIVE_INFINITY);
        chatTombsRef.current = next;
        setChatTombs(next);
      }
      function stickSigned(soul: string, data: unknown) {
        try {
          putSoul(gunRef.current, soul, data);
        } catch {
          // A bad id has no removal soul.
        }
      }
      async function acceptOffer(
        data: unknown,
        key: string | undefined,
        parentNeedId: string,
        gen: number,
        fromCancel = false,
        fromRemoval = false,
      ): Promise<boolean> {
        const queueKey = `${fromRemoval ? "remove" : fromCancel ? "cancel" : "offer"}:${parentNeedId}:${key ?? ""}`;
        const versionScope = fromRemoval ? "offer-remove" : fromCancel ? "offer-cancel" : "offer";
        const sig = signatureOf(data);
        if (!sig || !data || typeof data !== "object") return false;
        const row = data as { helper?: unknown; need?: unknown };
        const hintedNeed = typeof row.need === "string" ? row.need : undefined;
        if (hintedNeed !== undefined && hintedNeed !== parentNeedId) return false;
        const pending = pendingNeedsRef.current.get(parentNeedId);
        const parentNeed = needsRef.current.get(parentNeedId) ??
          (pending && Date.now() - pending.at < PENDING_NEED_TTL_MS ? pending.context : undefined);
        const candidates = offerSignerCandidates({
          offerId: key,
          hintedHelper: typeof row.helper === "string" ? row.helper : undefined,
          owner: graphRef.current?.ownerOf(parentNeedId),
          subject: parentNeed?.subject,
        });
        let payload: unknown = null;
        let signer = "";
        for (const pub of candidates) {
          if (cancelled || !versions.current(versionScope, `${parentNeedId}:${key ?? ""}`, gen)) return false;
          const verified = await readForumSignature(sig, pub);
          if (verified) {
            payload = verified;
            signer = pub;
            break;
          }
        }
        if (cancelled || !versions.current(versionScope, `${parentNeedId}:${key ?? ""}`, gen)) return false;
        const queueOffer = (reason: "authority" | "grant", offerKey: string) => {
          const now = Date.now();
          const kept = retainPendingOffer(
            pendingOffersRef.current,
            queueKey,
            {
              data,
              key: offerKey,
              parentNeedId,
              gen,
              at: now,
              fromCancel,
              fromRemoval,
              reason,
            },
            now,
          );
          if (!kept) pendingOffersRef.current.delete(queueKey);
        };
        if (!payload) {
          const awaiting = offerCancelAwaitingKeys({
            graph: graphRef.current,
            need: parentNeed,
            needId: parentNeedId,
          });
          const reason = offerRowShouldQueue({
            verified: false,
            fromCancel,
            fromRemoval,
            awaitingAuthority: awaiting,
            waitingForGrant: false,
          });
          if (reason && key) queueOffer(reason, key);
          else if (pendingOffersRef.current.get(queueKey)?.gen === gen) pendingOffersRef.current.delete(queueKey);
          return false;
        }
        const removal = parseForumMeshRemoval(payload);
        if (removal) {
          if (key === undefined || removal.kind !== "offer" || removal.need === undefined) return false;
          const awaitingRemoval = offerCancelAwaitingKeys({
            graph: graphRef.current,
            need: parentNeed,
            needId: parentNeedId,
          });
          if (awaitingRemoval) {
            queueOffer("authority", key);
            return false;
          }
          const authority = offerRemovalAuthority({
            parentNeedId,
            hintedNeed,
            removalNeed: removal.need,
            parent: parentNeed,
            offerId: removal.id,
          });
          if (!authority) return false;
          if (
            !authorizeForumMeshRemoval({
              removal,
              mapKey: key,
              signer,
              owner: graphRef.current?.ownerOf(parentNeedId),
              subject: authority.subject,
              forumId: PILOT_FORUM_ID,
              parentNeedId,
              resolved: authority.resolved,
            })
          ) {
            return false;
          }
          if (!versions.current(versionScope, `${parentNeedId}:${key}`, gen)) return false;
          pendingOffersRef.current.delete(queueKey);
          noteOfferRemoval(parentNeedId, removal.id);
          stickSigned(forumOfferRemovalSoul(PILOT_FORUM_ID, parentNeedId, removal.id), data);
          setMeshOffers((prev) => {
            if (!prev.has(forumOfferCacheKey(parentNeedId, removal.id))) return prev;
            const next = new Map(prev);
            next.delete(forumOfferCacheKey(parentNeedId, removal.id));
            return next;
          });
          watchOfferTails(parentNeedId, removal.id);
          return true;
        }
        const offer = parseForumOffer(payload);
        if (!offer || offer.need !== parentNeedId) {
          if (fromCancel || fromRemoval) {
            const queued = pendingOffersRef.current.get(queueKey);
            if (queued?.gen === gen) pendingOffersRef.current.delete(queueKey);
          }
          return false;
        }
        const named = parentNeed;
        const party = {
          owner: graphRef.current?.ownerOf(offer.need),
          subject: named?.subject,
        };
        const seen =
          named && graphRef.current
            ? { graph: graphRef.current, need: named, now: Math.floor(Date.now() / 1000) }
            : undefined;
        if (fromCancel && offer.stated !== 0) {
          const queued = pendingOffersRef.current.get(queueKey);
          if (queued?.gen === gen) pendingOffersRef.current.delete(queueKey);
          return false;
        }
        if (!authorizeForumOffer(offer, signer, PILOT_FORUM_ID, party, seen)) {
          const waiting = offerSeeWait({
            offer,
            graph: graphRef.current,
            need: named,
            now: Math.floor(Date.now() / 1000),
          });
          const reason = offerRowShouldQueue({
            verified: false,
            fromCancel,
            fromRemoval,
            awaitingAuthority: false,
            waitingForGrant: offer.stated === 1 && waiting,
          });
          if (reason) queueOffer(reason, offer.id);
          else pendingOffersRef.current.delete(queueKey);
          return false;
        }
        if (key !== undefined && key !== offer.id) return false;
        if (!versions.current(versionScope, `${parentNeedId}:${key ?? ""}`, gen)) return false;
        if (removedOffersRef.current.has(forumOfferCacheKey(offer.need, offer.id))) return false;
        if (offer.stated === 1 && offerBlockedByCancel(offerCancelsRef.current, offer)) return false;
        if (offer.stated === 0) noteOfferCancel(offer.need, offer.id);
        pendingOffersRef.current.delete(queueKey);
        setMeshOffers((prev) => {
          const existing = prev.get(forumOfferCacheKey(offer.need, offer.id));
          if (!mergeForumOffer(existing, offer)) return prev;
          const next = new Map(prev);
          next.set(forumOfferCacheKey(offer.need, offer.id), offer);
          return next;
        });
        setLocalOffers((prev) => {
          const local = prev.get(forumOfferCacheKey(offer.need, offer.id));
          if (!local) return prev;
          if (local.stated === 0 && offer.stated === 1) return prev;
          const next = new Map(prev);
          next.delete(forumOfferCacheKey(offer.need, offer.id));
          return next;
        });
        watchOfferTails(parentNeedId, offer.id);
        return true;
      }
      async function acceptStatus(data: unknown, key: string, gen: number, fromRemoval = false) {
        const versionScope = fromRemoval ? "status-remove" : "status";
        const sig = signatureOf(data);
        if (!sig || !data || typeof data !== "object") return;
        const row = data as { seaPubkey?: unknown; id?: unknown };
        const hintedId = typeof row.id === "string" ? row.id : "";
        const claimed = typeof row.seaPubkey === "string" ? row.seaPubkey : "";
        const candidates = [
          claimed,
          hintedId ? (graphRef.current?.ownerOf(hintedId) ?? "") : "",
          graphRef.current?.ownerOf(PILOT_FORUM_ID) ?? "",
        ].filter((pub, index, all) => pub && all.indexOf(pub) === index);
        let payload: unknown = null;
        let signer = "";
        for (const pub of candidates) {
          if (cancelled || !versions.current(versionScope, key, gen)) return;
          const verified = await readForumSignature(sig, pub);
          if (verified) {
            payload = verified;
            signer = pub;
            break;
          }
        }
        if (cancelled || !versions.current(versionScope, key, gen) || !payload) return;
        const removal = parseForumAgentRemoval(payload);
        if (removal) {
          const forumOwner = graphRef.current?.ownerOf(PILOT_FORUM_ID);
          if (
            !authorizeForumAgentRemoval({
              removal,
              mapKey: key,
              signer,
              forumOwner,
              forumId: PILOT_FORUM_ID,
            })
          ) {
            return;
          }
          if (!versions.current(versionScope, key, gen)) return;
          noteAgentRemoval(removal.seaPubkey);
          dropMeshStatus(removal.seaPubkey);
          stickSigned(forumStatusRemovalSoul(PILOT_FORUM_ID, removal.seaPubkey), data);
          return;
        }
        const status = parseForumAgentStatus(payload);
        if (!status || fromRemoval) return;
        if (liveReplayBlocked(status.lastUpdate, removedAgentsRef.current.get(status.seaPubkey))) return;
        const forumOwner = graphRef.current?.ownerOf(PILOT_FORUM_ID);
        const enrolled = admittedRef.current.has(status.seaPubkey);
        const admission = forumStatusAdmission({
          status,
          mapKey: key,
          signer,
          forumOwner,
          forumId: PILOT_FORUM_ID,
          enrolled,
        });
        if (!versions.current(versionScope, key, gen)) return;
        if (!statusRevisionAllowed(status, signer, forumOwner, Math.floor(Date.now() / 1000))) return;
        if (admission === "pending") {
          retainPendingStatus(pendingStatusRef.current, status, Date.now());
          return;
        }
        if (admission !== "owner" && admission !== "enrolled") return;
        if (admission === "owner") enrollPub(status.seaPubkey);
        pendingStatusRef.current.delete(status.seaPubkey);
        watchStatusRemoval(status.seaPubkey);
        commitMeshStatus(status);
      }
      async function acceptNeed(data: unknown, key: string, gen: number, fromRemoval = false) {
        const queueKey = pendingNeedKey(key, fromRemoval);
        const versionScope = fromRemoval ? "need-remove" : "need";
        const sig = signatureOf(data);
        if (!sig || !data || typeof data !== "object") {
          pendingNeedsRef.current.delete(queueKey);
          return;
        }
        const hintedId = (data as { id?: unknown }).id;
        const hintedSubject = (data as { subject?: unknown }).subject;
        if (typeof hintedId !== "string" || key !== hintedId) {
          pendingNeedsRef.current.delete(queueKey);
          return;
        }
        const owner = graphRef.current?.ownerOf(hintedId);
        let signer = "";
        let payload: unknown = null;
        for (const candidate of needSignerCandidates(owner, needsRef.current.get(key)?.subject, hintedSubject)) {
          if (cancelled || !versions.current(versionScope, key, gen)) return;
          payload = await readForumSignature(sig, candidate);
          if (payload) { signer = candidate; break; }
        }
        if (cancelled || !versions.current(versionScope, key, gen)) return;
        if (!payload) {
          const now = Date.now();
          const kept =
            !owner &&
            retainPendingNeed(
              pendingNeedsRef.current,
              queueKey,
              {
                data,
                fromRemoval,
                gen,
                at: now,
                parentId: PILOT_FORUM_ID,
                objectId: key,
                reason: "owner",
              },
              now,
            );
          if (!kept) pendingNeedsRef.current.delete(queueKey);
          return;
        }
        const removal = parseForumMeshRemoval(payload);
        if (removal && removal.kind === "need") {
          const known = needsRef.current.get(removal.id);
          if (
            !authorizeForumMeshRemoval({
              removal,
              mapKey: key,
              signer,
              owner: graphRef.current?.ownerOf(removal.id),
              subject: known?.subject,
              forumId: PILOT_FORUM_ID,
            })
          ) {
            return;
          }
          if (!versions.current(versionScope, key, gen)) return;
          pendingNeedsRef.current.delete(queueKey);
          pendingNeedsRef.current.delete(pendingNeedKey(key));
          noteNeedRemoval(removal.id);
          stickSigned(forumNeedRemovalSoul(PILOT_FORUM_ID, removal.id), data);
          setMeshNeeds((prev) => {
            if (!prev.has(removal.id)) return prev;
            const next = new Map(prev);
            next.delete(removal.id);
            return next;
          });
          setLocalNeeds((prev) => {
            if (!prev.has(removal.id)) return prev;
            const next = new Map(prev);
            next.delete(removal.id);
            return next;
          });
          return;
        }
        const need = parseForumNeed(payload);
        if (!need || key !== need.id || fromRemoval || removedNeedsRef.current.has(need.id)) {
          pendingNeedsRef.current.delete(queueKey);
          return;
        }
        const known = needsRef.current.get(need.id);
        const closure =
          graphRef.current
            ? {
                graph: graphRef.current,
                postedOffers: offersForNeed(offersRef.current, need.id),
                now: Math.floor(Date.now() / 1000),
              }
            : undefined;
        const admitSig = ownerAdmitSig(payload);
        let admitted: ForumNeed | undefined;
        if (admitSig && owner) {
          const opened = await readForumSignature(admitSig, owner);
          if (cancelled || !versions.current(versionScope, key, gen)) return;
          const parsed = opened ? parseForumNeed(opened) : null;
          if (parsed && forumNeedAdmission(parsed, need)) admitted = parsed;
        }
        const allowed = authorizeForumNeed(need, signer, owner, PILOT_FORUM_ID, known, closure, admitted);
        if (!versions.current(versionScope, key, gen)) {
          pendingNeedsRef.current.delete(queueKey);
          return;
        }
        if (!allowed) {
          const closing = need.stated === 0 && !!need.acceptedOffer;
          const gate = closing && closure ? needClosureStatus(need, closure) : "denied";
          const now = Date.now();
          const waitingOnOwner = !owner && signer !== need.subject && isSeaPubkey(signer);
          const waitingOnAdmission = closing && !known && !owner && signer === need.subject && !!admitSig;
          const context = pendingClosureContext(need, signer, owner, known, admitted);
          const previousContext = pendingNeedsRef.current.get(key)?.context;
          const kept =
            (closing && gate === "wait" && !!context) || waitingOnOwner || waitingOnAdmission
              ? retainPendingNeed(
                  pendingNeedsRef.current,
                  queueKey,
                  {
                    data,
                    fromRemoval,
                    gen,
                    at: now,
                    parentId: PILOT_FORUM_ID,
                    objectId: need.id,
                    expectOwner: waitingOnOwner ? signer : undefined,
                    reason: closing && gate === "wait" ? "closure" : "owner",
                    context,
                  },
                  now,
                )
              : false;
          if (kept && context) {
            watchOffers(need.id);
            watchNeedRemoval(need.id);
            if (!previousContext || previousContext.hamState < context.hamState) setAclRev((rev) => rev + 1);
          }
          if (!kept) pendingNeedsRef.current.delete(queueKey);
          return;
        }
        pendingNeedsRef.current.delete(queueKey);
        const cached = cacheForumNeed(needsRef.current, need, highWaterRef.current.get(need.id));
        if (!cached) return;
        needsRef.current = cached;
        noteNeedHighWater(need);
        if (signer === owner && need.stated === 1) needAdmitRef.current.set(need.id, sig);
        watchOffers(need.id);
        watchNeedRemoval(need.id);
        setMeshNeeds((prev) => {
          const existing = prev.get(need.id);
          if (existing && existing.hamState > need.hamState) return prev;
          const next = new Map(prev);
          next.set(need.id, need);
          return next;
        });
        setLocalNeeds((prev) => {
          const local = prev.get(need.id);
          if (!local || need.hamState < local.hamState) return prev;
          const next = new Map(prev);
          next.delete(need.id);
          return next;
        });
      }
      acceptNeedRef.current = acceptNeed;
      acceptOfferRef.current = acceptOffer;
      async function acceptAlarm(data: unknown, gen: number) {
        const sig = signatureOf(data);
        const owner = graphRef.current?.ownerOf(PILOT_FORUM_ID);
        if (!sig || !owner) return;
        const payload = await readForumSignature(sig, owner);
        if (cancelled || !versions.current("alarm", "pin", gen) || !payload || typeof payload !== "object") return;
        const update = parseForumAlarmUpdate(payload, PILOT_FORUM_ID);
        if (!update) return;
        if (update.kind === "pin" && !authorizeForumAlarm(update.alarm, owner, owner, PILOT_FORUM_ID)) return;
        if (!versions.current("alarm", "pin", gen)) return;
        const committed = commitForumAlarm({ rev: alarmRevRef.current }, update);
        if (!committed) return;
        alarmRevRef.current = committed.rev;
        setAlarmHeard(true);
        setMeshAlarm(committed.alarm);
      }
      async function acceptRole(data: unknown, roleToken: string, mapKey: string, gen: number) {
        const sig = signatureOf(data);
        const forumOwner = graphRef.current?.ownerOf(PILOT_FORUM_ID);
        if (!sig || !forumOwner || !data || typeof data !== "object") return;
        const payload = await readForumSignature(sig, forumOwner);
        if (cancelled || !versions.current("role", `${roleToken}:${mapKey}`, gen) || !payload) return;
        const membership = parseForumRoleMembership(payload);
        if (!membership) return;
        if (
          !authorizeForumRoleAdmission({
            membership,
            roleToken,
            mapKey,
            signer: forumOwner,
            forumOwner,
            forumId: PILOT_FORUM_ID,
          })
        ) {
          return;
        }
        if (!versions.current("role", `${roleToken}:${mapKey}`, gen) || !forumWatches.has(`role:${roleToken}`)) return;
        grantForumWatch(forumWatches, "role", roleToken, true, Date.now());
        enrollPub(membership.principal);
      }
      function chatTombStamp(id: string): number | undefined {
        const direct = chatTombsRef.current.get(id);
        if (direct !== undefined) return direct;
        for (const [known, stamp] of chatTombsRef.current) {
          if (soulKeyMatches(id, known)) return stamp;
        }
        return undefined;
      }
      async function acceptChat(data: unknown, key: string | undefined, fromRemoval = false): Promise<boolean> {
        if (data === undefined || typeof key !== "string") return false;
        const versionScope = fromRemoval ? "chat-remove" : "chat";
        const gen = versions.bump(versionScope, key);
        const live = fromRemoval ? null : forumStatementFromNode(data, PILOT_FORUM_ID);
        if (live) {
          const sig = signatureOf(data);
          const author = live.author;
          if (!sig) return false;
          const payload = await readForumSignature(sig, author);
          if (cancelled || !versions.current(versionScope, key, gen) || !payload) return false;
          const item = forumStatementFromNode(payload, PILOT_FORUM_ID);
          const priorAuthor = chatRowsRef.current.find((row) => row.id === item?.id)?.author;
          if (!item || !forumChatFits(item) || !authorizeForumChat(item, author, key, PILOT_FORUM_ID, priorAuthor)) return false;
          if (!versions.current(versionScope, key, gen)) return false;
          if (liveReplayBlocked(item.ts, chatTombStamp(item.id))) return false;
          setMeshChat((prev) => retainForumChat(prev, item));
          setLocalChat((prev) => retireLocalChat(prev, item.id));
          return true;
        }
        const sig = signatureOf(data);
        if (!sig) return false;
        const hintedId = typeof (data as { id?: unknown }).id === "string" ? (data as { id: string }).id : key;
        const embedded = chatAuthorFromStatementId(hintedId) ?? chatAuthorFromStatementId(key);
        const remembered = chatRowsRef.current.find((row) => soulKeyMatches(row.id, key))?.author;
        const owner = graphRef.current?.ownerOf(PILOT_FORUM_ID);
        const candidates = [embedded ?? "", remembered ?? "", owner ?? ""].filter(
          (pub, index, all) => pub && all.indexOf(pub) === index,
        );
        let payload: unknown = null;
        let signer = "";
        for (const pub of candidates) {
          if (cancelled || !versions.current(versionScope, key, gen)) return false;
          const verified = await readForumSignature(sig, pub);
          if (verified) {
            payload = verified;
            signer = pub;
            break;
          }
        }
        if (cancelled || !versions.current(versionScope, key, gen) || !payload) return false;
        const payloadId = typeof (payload as { id?: unknown }).id === "string" ? (payload as { id: string }).id : hintedId;
        const author = chatAuthorFromStatementId(payloadId) ?? embedded ?? remembered;
        if (!authorizeForumChatTombstone({ signer, author, owner })) return false;
        const ids = chatRetractionIds(payload, key, knownChatIds(), PILOT_FORUM_ID);
        if (!versions.current(versionScope, key, gen) || ids.length === 0) return false;
        hideChat(ids);
        const statementId = typeof (payload as { id?: unknown }).id === "string" ? (payload as { id: string }).id : key;
        stickSigned(forumChatRemovalSoul(statementId), data);
        return true;
      }
      function expireForumListeners() {
        for (const id of expireForumWatches(forumWatches, Date.now())) {
          forumOffs.get(id)?.off?.(); forumOffs.delete(id);
        }
      }
      const chatRemovalWatches = new Map<string, number>();
      const expireChatRemovalWatches = (now: number) => {
        for (const expired of takeExpiredChatRemovalWatches(chatRemovalWatches, now)) {
          chatRemovalOffs.get(expired)?.off?.();
          chatRemovalOffs.delete(expired);
        }
      };
      const watchNeedRemoval = (needId: string) => {
        expireForumListeners();
        if (!grantForumWatch(forumWatches, "need", needId, true, Date.now())) return;
        forumOffs.set(`need:${needId}`,
          forum.get("needs").get(needId).get("remove").on((row) => {
            if (cancelled || row == null) return;
            const removalGen = versions.bump("need-remove", needId);
            void acceptNeed(row, needId, removalGen, true);
          }),
        );
      };
      const offerTailWatches = new Map<string, number>();
      function watchOfferTails(needId: string, offerId: string) {
        const now = Date.now();
        for (const expired of takeExpiredOfferTailWatches(offerTailWatches, now)) {
          offerTailOffs.get(expired)?.off?.();
          offerTailOffs.delete(expired);
        }
        if (!grantOfferTailWatch({ watches: offerTailWatches, needId, offerId, verified: true, now })) return;
        const id = `${needId}:${offerId}`;
        const cancelOff = forum.get("needs").get(needId).get("offers").get(offerId).get("cancel").on((cancel) => {
          if (cancelled || cancel == null) return;
          const cancelGen = versions.bump("offer-cancel", `${needId}:${offerId}`);
          void acceptOffer(cancel, offerId, needId, cancelGen, true);
        });
        const removeOff = forum.get("needs").get(needId).get("offers").get(offerId).get("remove").on((row) => {
          if (cancelled || row == null) return;
          const removalGen = versions.bump("offer-remove", `${needId}:${offerId}`);
          void acceptOffer(row, offerId, needId, removalGen, false, true);
        });
        offerTailOffs.set(id, {
          off() {
            cancelOff?.off?.();
            removeOff?.off?.();
          },
        });
      }
      const watchOffers = (needId: string) => {
        expireForumListeners();
        if (!grantForumWatch(forumWatches, "offers", needId, true, Date.now())) return;
        forumOffs.set(`offers:${needId}`,
          forum.get("needs").get(needId).get("offers").map().on((data, key) => {
            if (cancelled || typeof key !== "string" || data === undefined) return;
            if (!offerTailCandidate(needId, key, data)) return;
            const gen = versions.bump("offer", `${needId}:${key}`);
            if (data === null) return;
            void acceptOffer(data, key, needId, gen);
          }),
        );
      };
      for (const need of PILOT_NEEDS) {
        watchOffers(need.id);
        watchNeedRemoval(need.id);
      }
      const statusWatches = new Map<string, number>();
      function expireStatuses() {
        const now = Date.now();
        prunePendingStatuses(pendingStatusRef.current, now);
        prunePendingNeeds(pendingNeedsRef.current, now);
        expireForumListeners();
        for (const pub of expireStatusWatches(statusWatches, now)) {
          statusOffs.get(pub)?.off?.();
          statusOffs.delete(pub);
        }
      }
      function watchStatusRemoval(pub: string) {
        expireStatuses();
        if (!grantStatusWatch(statusWatches, pub, true, Date.now())) return;
        statusOffs.set(pub, forum.get("agents").get(pub).get("remove").on((row) => {
          if (cancelled || row == null) return;
          const gen = versions.bump("status-remove", pub);
          void acceptStatus(row, pub, gen, true);
        }));
      }
      for (const agent of PILOT_AGENTS) watchStatusRemoval(agent.status.seaPubkey);
      statusTimer = setInterval(expireStatuses, 30_000);
      offAgents = forum.get("agents").map().on((data, key) => {
        if (cancelled || typeof key !== "string" || !statusWatchCandidate(key, data)) return;
        const gen = versions.bump("status", key);
        void acceptStatus(data, key, gen);
      });
      offRoles = forum.get("roles").map().on((data, token) => {
        if (cancelled || typeof token !== "string" || !isRoleToken(token)) return;
        expireForumListeners();
        if (!grantForumWatch(forumWatches, "role", token, false, Date.now())) return;
        forumOffs.set(`role:${token}`,
          forum.get("roles").get(token).map().on((row, pub) => {
            if (cancelled || typeof pub !== "string") return;
            const gen = versions.bump("role", `${token}:${pub}`);
            if (row == null) return;
            void acceptRole(row, token, pub, gen);
          }),
        );
      });
      offNeeds = forum.get("needs").map().on((data, key) => {
        if (cancelled || typeof key !== "string" || data === undefined) return;
        const gen = versions.bump("need", key);
        if (data === null) return;
        void acceptNeed(data, key, gen);
      });
      offAlarm = forum.get("alarm").on((data) => {
        if (cancelled || data === undefined) return;
        const gen = versions.bump("alarm", "pin");
        if (data === null) return;
        void acceptAlarm(data, gen);
      });
      offItems = gun.get("s3rch").get("items").map().on((data, key) => {
        if (cancelled || typeof key !== "string" || data === undefined) return;
        if (!chatRemovalCandidate(key, data, PILOT_FORUM_ID)) return;
        void acceptChat(data, key).then((verified) => {
          if (cancelled || !verified) return;
          const now = Date.now();
          expireChatRemovalWatches(now);
          if (!grantChatRemovalWatch({ watches: chatRemovalWatches, key, verified, now })) return;
          const off = gun.get("s3rch").get("items").get(key).get("remove").on((row) => {
            if (cancelled || row == null) return;
            void acceptChat(row, key, true);
          });
          chatRemovalOffs.set(key, off);
        });
      });
    })();

    return () => {
      cancelled = true;
      offAgents?.off?.();
      offNeeds?.off?.();
      offRoles?.off?.();
      for (const off of forumOffs.values()) off.off?.();
      for (const off of chatRemovalOffs.values()) off.off?.();
      for (const off of offerTailOffs.values()) off.off?.();
      for (const off of statusOffs.values()) off.off?.();
      if (statusTimer) clearInterval(statusTimer);
      offAlarm?.off?.();
      offItems?.off?.();
      gunRef.current = null;
      register(null);
    };
  }, [register]);

  useEffect(() => {
    const acl = see?.acl;
    if (!acl) return;
    return acl.subscribe(() => setAclRev((n) => n + 1));
  }, [see?.acl]);

  useEffect(() => {
    const now = Date.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const [key, row] of [...pendingNeedsRef.current]) {
      const owner = graphRef.current?.ownerOf(row.objectId);
      const decision = pendingNeedRetry(row, now, owner);
      if (decision === "drop") {
        pendingNeedsRef.current.delete(key);
        continue;
      }
      if (decision === "keep") {
        earliest = Math.min(earliest, row.at + PENDING_NEED_TTL_MS);
        continue;
      }
      void acceptNeedRef.current(row.data, row.objectId, row.gen, row.fromRemoval);
    }
    for (const [key, row] of [...pendingOffersRef.current]) {
      const decision = pendingOfferRetry(row, now);
      if (decision === "drop") {
        pendingOffersRef.current.delete(key);
        continue;
      }
      earliest = Math.min(earliest, row.at + PENDING_OFFER_TTL_MS);
      void acceptOfferRef.current(
        row.data,
        row.key,
        row.parentNeedId,
        row.gen,
        row.fromCancel,
        row.fromRemoval,
      );
    }
    if (!Number.isFinite(earliest)) return;
    const timer = setTimeout(() => {
      const at = Date.now();
      prunePendingNeeds(pendingNeedsRef.current, at);
      prunePendingOffers(pendingOffersRef.current, at);
    }, Math.max(0, earliest - Date.now()) + 5);
    return () => clearTimeout(timer);
  }, [aclRev, localNeeds, localOffers, meshNeeds, meshOffers, see?.ready]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const graph: SeeGraph | null = see ? overlaySeeGraph(see.acl, sampleAcl) : null;
  graphRef.current = graph;
  chatRowsRef.current = [...PILOT_CHAT, ...meshChat, ...localChat];
  chatIdsRef.current = chatRowsRef.current.map((item) => item.id);

  const needs = useMemo(
    () =>
      composeForumNeeds({
        pilot: PILOT_NEEDS,
        mesh: [...persistedNeeds.values(), ...meshNeeds.values()],
        local: [...localNeeds.values()],
        removed: removedNeeds,
      }),
    [localNeeds, meshNeeds, persistedNeeds, removedNeeds],
  );
  needsRef.current = needs;

  const offers = useMemo(() => {
    const map = new Map(meshOffers);
    for (const offer of localOffers.values()) {
      const seen = map.get(forumOfferCacheKey(offer.need, offer.id));
      if (!seen || (offer.stated === 0 && seen.stated === 1)) map.set(forumOfferCacheKey(offer.need, offer.id), offer);
    }
    for (const [id, offer] of map) {
      if (removedOffers.has(id)) {
        map.delete(id);
        continue;
      }
      if (offerBlockedByCancel(offerCancels, offer)) map.set(id, { ...offer, stated: 0 });
    }
    return map;
  }, [localOffers, meshOffers, offerCancels, removedOffers]);
  offersRef.current = offers;

  const roster = useMemo(() => {
    const merged = composeForumRoster({
      sample: PILOT_AGENTS,
      mesh: [...meshStatus.values()],
      admitted,
      removed: new Set(removedAgents.keys()),
    });
    return merged.map((agent) => {
      const over = localStatus.get(agent.status.seaPubkey);
      const status = pickDisplayedStatus(agent.status, over);
      return status === agent.status ? agent : { ...agent, status };
    });
  }, [admitted, localStatus, meshStatus, removedAgents]);

  const visible = useMemo(
    () => filterAgents(roster, filters, query),
    [filters, query, roster],
  );

  const alarm = meshAlarm ?? (alarmHeard ? null : PILOT_ALARM);
  const pinnedNeed = alarm ? (needs.get(alarm.need) ?? null) : null;
  const alarmOn = forumEmergencyAlarm(
    roster.map((agent) => agent.status.state),
    alarm,
    pinnedNeed,
  );
  const emergencyCount = roster.filter((agent) => agent.status.state === "emergency").length;
  const needsCount = roster.filter((agent) => agent.status.state === "needs").length;
  const active = roster.find((agent) => agent.status.seaPubkey === selected) ?? null;

  const chat = useMemo(
    () => mergeForumChat({ pilot: PILOT_CHAT, mesh: meshChat, local: localChat, hidden: hiddenChat }),
    [hiddenChat, localChat, meshChat],
  );

  const requireGraph = useCallback((): SeeGraph | null => {
    if (!see?.ready || !graph) {
      setNotice("Check is still loading.");
      return null;
    }
    if (!seaPub) {
      setNotice("A SEA key on this browser is required.");
      return null;
    }
    return graph;
  }, [graph, seaPub, see?.ready]);

  function toggleFilter(state: ForumAgentState) {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  }

  function needNotice(reason: string, verb: "offer" | "accept" | "decline" | "reopen"): string {
    if (reason === "party") return "Only the need owner or subject can accept or decline an offer.";
    if (reason === "owner") return "Only the need owner can reopen.";
    if (reason === "open") return "This need is still open.";
    if (reason === "body") return "Write the offer first. That does not close the need.";
    if (reason === "unposted") return "That offer is not a live posted row.";
    if (reason === "resolved") return "This need is resolved on that offer.";
    if (reason === "helper") return "Only the helper can withdraw that offer.";
    return `Check denied ${verb} (${reason}).`;
  }

  function meshNote(kind: string, wrote: "signed" | "offline" | "local", okLine: string): string {
    if (wrote === "signed") return okLine;
    if (wrote === "offline") return `${kind} on this browser. The mesh peer was not ready.`;
    return `${kind} on this browser. The mesh put needs a signature from this SEA key.`;
  }

  function offerEntropy(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function onOffer(agent: SquadAgent) {
    const current = requireGraph();
    if (!current || !seaPub) return;
    const open = openNeedFor(agent.status, needs);
    if (!open) {
      setNotice("No open need on this tile.");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const decision = offerForumHelp({
      graph: current,
      writer: seaPub,
      need: open,
      body: offerBody,
      now,
      entropy: offerEntropy(),
    });
    if (!decision.ok || !decision.offer) {
      setNotice(needNotice(decision.ok ? "bad-offer" : decision.reason, "offer"));
      return;
    }
    see?.acl.putObject(decision.offer.id, decision.offer.helper);
    void see?.persist();
    const offer = decision.offer;
    setLocalOffers((prev) => {
      const next = new Map(prev);
      next.set(forumOfferCacheKey(offer.need, offer.id), offer);
      return next;
    });
    setOfferBody("");
    const wrote = await putAuthedRecord(
      forumOfferSoul(offer.forumId, offer.need, offer.id),
      offer,
      seaPub,
    );
    setNotice(meshNote("Offer kept", wrote, "Offer posted. The need stays open."));
  }

  function liveOffer(need: ForumNeed): ForumOffer | null {
    for (const offer of offers.values()) {
      if (offer.need === need.id && offer.stated === 1) return offer;
    }
    return null;
  }

  async function onAccept(agent: SquadAgent) {
    const current = requireGraph();
    if (!current || !seaPub) return;
    const open = openNeedFor(agent.status, needs);
    if (!open) {
      setNotice("No open need on this tile.");
      return;
    }
    const offer = liveOffer(open);
    if (!offer) {
      setNotice("No offer to accept.");
      return;
    }
    const decision = acceptForumOffer({
      graph: current,
      writer: seaPub,
      need: open,
      offer,
      postedOffers: offersForNeed(offers, open.id),
      now: Math.floor(Date.now() / 1000),
    });
    if (!decision.ok || !decision.need) {
      setNotice(needNotice(decision.ok ? "bad-need" : decision.reason, "accept"));
      return;
    }
    const next = decision.need;
    setLocalNeeds((prev) => {
      const map = new Map(prev);
      map.set(next.id, next);
      return map;
    });
    const needOwner = current.ownerOf(open.id);
    const admit = needOwner && seaPub !== needOwner ? needAdmitRef.current.get(open.id) : undefined;
    const record = admit ? { ...next, admit } : next;
    const wrote = await putAuthedRecord(forumNeedSoul(next.forumId, next.id), record, seaPub);
    setNotice(meshNote("Accept kept", wrote, "Offer accepted. The need is closed."));
  }

  async function onDecline(agent: SquadAgent) {
    const current = requireGraph();
    if (!current || !seaPub) return;
    const open = openNeedFor(agent.status, needs);
    if (!open) {
      setNotice("No open need on this tile.");
      return;
    }
    const offer = liveOffer(open);
    if (!offer) {
      setNotice("No offer to decline.");
      return;
    }
    const decision = declineForumOffer({
      graph: current,
      writer: seaPub,
      need: open,
      offer,
      postedOffers: offersForNeed(offers, open.id),
      now: Math.floor(Date.now() / 1000),
    });
    if (!decision.ok || !decision.offer) {
      setNotice(needNotice(decision.ok ? "bad-offer" : decision.reason, "decline"));
      return;
    }
    const next = decision.offer;
    if (!offerCancelsRef.current.has(forumOfferCacheKey(next.need, next.id))) {
      const ids = new Set(offerCancelsRef.current);
      ids.add(forumOfferCacheKey(next.need, next.id));
      offerCancelsRef.current = ids;
      setOfferCancels(ids);
    }
    setLocalOffers((prev) => {
      const map = new Map(prev);
      map.set(forumOfferCacheKey(next.need, next.id), next);
      return map;
    });
    const wrote = await putAuthedRecord(forumOfferSoul(next.forumId, next.need, next.id), next, seaPub);
    if (wrote === "signed") {
      await putAuthedRecord(forumOfferCancelSoul(next.forumId, next.need, next.id), next, seaPub);
    }
    setNotice(meshNote("Decline kept", wrote, "Offer declined. The need stays open."));
  }

  async function onReopen(agent: SquadAgent) {
    const current = requireGraph();
    if (!current || !seaPub) return;
    const listed = needIds(agent.status.needs)
      .map((id) => needs.get(id))
      .find((need) => need && need.stated === 0);
    if (!listed) {
      setNotice("This need is still open.");
      return;
    }
    const decision = reopenForumNeed({
      graph: current,
      writer: seaPub,
      need: listed,
      now: Math.floor(Date.now() / 1000),
    });
    if (!decision.ok || !decision.need) {
      setNotice(needNotice(decision.ok ? "bad-need" : decision.reason, "reopen"));
      return;
    }
    const next = decision.need;
    setLocalNeeds((prev) => {
      const map = new Map(prev);
      map.set(next.id, next);
      return map;
    });
    const wrote = await putAuthedRecord(forumNeedSoul(next.forumId, next.id), next, seaPub);
    setNotice(meshNote("Reopen kept", wrote, "Need reopened. Earlier offers stay."));
  }

  function onReply(agent: SquadAgent) {
    setDraft(`@${agent.label} `);
    setTab("chat");
    setSelected(null);
    setNotice("");
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  function onPause(agent: SquadAgent) {
    const current = requireGraph();
    if (!current || !seaPub) return;
    if (!forumOwnerMayWriteStatus(current.ownerOf(PILOT_FORUM_ID), seaPub)) {
      setNotice("Check see is not a status write. The forum owner can write status.");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const next = pausedStatus(agent.status, now);
    if (!validateForumStatus(next)) {
      setNotice("Status was not accepted.");
      return;
    }
    setLocalStatus((prev) => {
      const map = new Map(prev);
      map.set(next.seaPubkey, next);
      return map;
    });
    void putAuthedStatus(next, seaPub).then((wrote) => {
      if (wrote === "signed") setNotice("Paused.");
      else if (wrote === "offline") setNotice("Paused on this browser. The mesh peer was not ready.");
      else setNotice("Paused on this browser. The mesh put needs a signature from this SEA key.");
    });
  }

  function onReassign(agent: SquadAgent) {
    const target = reassignTo.trim();
    if (!isSeaPubkey(target)) {
      setNotice("Enter a SEA pubkey to reassign.");
      return;
    }
    const current = requireGraph();
    if (!current || !seaPub) return;
    if (!forumOwnerMayWriteStatus(current.ownerOf(PILOT_FORUM_ID), seaPub)) {
      setNotice("Check see is not a status write. The forum owner can write status.");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const next = reassignedStatus(agent.status, target, now);
    if (!next || !validateForumStatus(next)) {
      setNotice("Status was not accepted.");
      return;
    }
    setLocalStatus((prev) => {
      const map = new Map(prev);
      map.set(next.seaPubkey, next);
      return map;
    });
    void putAuthedStatus(next, seaPub).then((wrote) => {
      if (wrote === "signed") setNotice("Reassigned.");
      else if (wrote === "offline") setNotice("Reassigned on this browser. The mesh peer was not ready.");
      else setNotice("Reassigned on this browser. The mesh put needs a signature from this SEA key.");
    });
  }

  async function putAuthedRecord(
    soul: string,
    record: object,
    writer: string,
  ): Promise<"signed" | "offline" | "local"> {
    const pair = pairRef.current;
    if (!pair || pair.pub !== writer) return "local";
    const sig = await signForumRecord(record, pair);
    if (!sig) return "local";
    return putSoul(gunRef.current, soul, { ...record, sig }) ? "signed" : "offline";
  }

  async function putAuthedStatus(
    status: ForumAgentStatus,
    writer: string,
  ): Promise<"signed" | "offline" | "local"> {
    return putAuthedRecord(forumAgentSoul(status.forumId, status.seaPubkey), status, writer);
  }

  async function onSend() {
    if (!see?.ready || !seaPub) {
      setNotice(seaPub ? "Check is still loading." : "A SEA key on this browser is required.");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const item = buildForumStatement({
      forumId: PILOT_FORUM_ID,
      author: seaPub,
      body: draft,
      now,
      entropy: entropy(),
    });
    if (!item) {
      setNotice("Statement was not accepted.");
      return;
    }
    const node = toGunNode(item);
    const admitted = admitFeedNode(see.acl, node, seaPub);
    if ("denied" in admitted) {
      setNotice("Check denied the statement.");
      return;
    }
    let soul: string;
    try {
      soul = forumStatementSoul(item.id);
    } catch {
      setNotice("Statement was not accepted.");
      return;
    }
    const pair = pairRef.current;
    const sig = pair && pair.pub === seaPub ? await signForumRecord(node, pair) : null;
    const wrote = sig ? putSoul(gunRef.current, soul, { ...node, sig }) : false;
    void see.persist();
    setLocalChat((prev) => retainForumChat(prev, item));
    setDraft("");
    if (!sig) setNotice("Statement kept on this browser. The mesh put needs a signature from this SEA key.");
    else if (!wrote) setNotice("Statement kept on this browser. The mesh peer was not ready.");
    else setNotice("Statement sent.");
  }

  const wallet = session?.address
    ? `${session.address.slice(0, 6)}…${session.address.slice(-4)}`
    : "not linked";

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Squad forum</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {PILOT_FORUM_LABEL}. Identity is the SEA pubkey. Wallet and Panopticon are linked
            credentials.
          </p>
        </div>
        {alarmOn ? (
          <p
            data-testid="squad-alarm"
            className="border border-status-fail bg-status-fail px-3 py-2 text-xs font-semibold text-ground"
          >
            Alarm
          </p>
        ) : null}
      </div>

      <dl className="mt-4 grid gap-2 text-xs text-ink-muted sm:grid-cols-3">
        <div className="border border-rule bg-panel px-3 py-2">
          <dt>Identity</dt>
          <dd className="mt-1 font-data text-ink">{seaPub ? shortSea(seaPub) : "no SEA key on this browser"}</dd>
        </div>
        <div className="border border-rule bg-panel px-3 py-2">
          <dt>Wallet</dt>
          <dd className="mt-1 font-data text-ink" title={session?.address ?? ""}>
            {wallet}
          </dd>
        </div>
        <div className="border border-rule bg-panel px-3 py-2">
          <dt>Panopticon</dt>
          <dd className="mt-1 text-ink">{oauthLinked ? "linked" : "not linked"}</dd>
        </div>
      </dl>
      {!session ? (
        <p className="mt-2 text-sm text-ink-muted">
          <Link href="/feed" className="font-semibold text-ink hover:text-signal">
            Sign in on the feed
          </Link>{" "}
          to link a wallet. The SEA key stays on this browser.
        </p>
      ) : null}
      {notice ? (
        <p data-testid="squad-notice" className="mt-3 border border-rule bg-panel px-3 py-2 text-sm text-ink">
          {notice}
        </p>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-[200px_minmax(0,1fr)_320px]">
        <aside className="border border-rule bg-panel p-3 text-sm">
          <p className="font-semibold text-ink">{PILOT_FORUM_LABEL}</p>
          <p className="mt-2 text-xs text-ink-muted">
            {emergencyCount} emergency · {needsCount} needs
          </p>
          <p className="mt-3 text-xs font-semibold text-ink">Vitals</p>
          <div data-testid="squad-vitals" className="mt-2 flex flex-wrap gap-1">
            {(["auto", "dot", "full"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={vitals === mode ? chipOn : chipOff}
                onClick={() => setVitals(mode)}
              >
                {mode === "auto" ? "Auto" : mode === "dot" ? "Dot" : "Full"}
              </button>
            ))}
          </div>
          <p className="mt-4 text-xs text-ink-muted">Fleet and Command are not on this page.</p>
        </aside>

        <section>
          <div className="flex gap-2">
            <button
              type="button"
              className={tab === "board" ? btnTabOn : btnTabOff}
              onClick={() => setTab("board")}
            >
              Board
            </button>
            <button
              type="button"
              className={tab === "chat" ? btnTabOn : btnTabOff}
              onClick={() => setTab("chat")}
            >
              Chat
            </button>
          </div>

          <div
            data-testid="squad-board"
            className={`mt-3 ${tab === "chat" ? "hidden lg:block" : ""}`}
          >
              <div className="flex flex-wrap items-center gap-2">
                {STATES.map((state) => (
                  <button
                    key={state}
                    type="button"
                    className={filters.has(state) ? chipOn : chipOff}
                    onClick={() => toggleFilter(state)}
                  >
                    {state}
                  </button>
                ))}
                <input
                  className={`${field} min-w-0 flex-1`}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Filter tiles"
                  aria-label="Filter tiles"
                />
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {visible.map((agent) => {
                  const open = openNeedFor(agent.status, needs);
                  const full = showFullVitals(agent.status.type, vitals);
                  return (
                    <button
                      key={agent.status.seaPubkey}
                      type="button"
                      data-testid={`squad-tile-${slug(agent.label)}`}
                      className={`border bg-panel p-3 text-left ${
                        agent.status.state === "emergency" ? "border-status-fail" : "border-rule"
                      }`}
                      onClick={() => setSelected(agent.status.seaPubkey)}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2 font-semibold text-ink">
                          <span className={`inline-block size-2 ${stateDot(agent.status.state)}`} aria-hidden />
                          {agent.label}
                        </span>
                        <span className="text-xs uppercase text-ink-muted">{agent.status.type}</span>
                      </div>
                      <p className="mt-1 text-xs uppercase text-ink-muted">{agent.status.state}</p>
                      <p className="mt-2 text-sm text-ink">{agent.status.task}</p>
                      <p className="mt-1 text-xs text-ink-muted">{agent.status.result}</p>
                      <p className="mt-2 line-clamp-2 text-xs text-ink">{agent.status.lastPrompt}</p>
                      {open ? <p className="mt-2 text-xs text-ink">{open.body}</p> : null}
                      <div className="mt-2 h-1 bg-rule">
                        <div
                          className="h-1 bg-signal"
                          style={{ width: `${clampProgress(agent.status.progress)}%` }}
                        />
                      </div>
                      {full ? (
                        <p className="mt-2 font-data text-xs text-ink-muted">
                          hb {agent.status.hb ?? "—"} · batt {agent.status.batt ?? "—"} · link{" "}
                          {agent.status.link ?? "—"}
                        </p>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
        </section>

        <div className={tab === "board" ? "hidden lg:block" : ""}>
          <ChatColumn
            chat={chat}
            draft={draft}
            setDraft={setDraft}
            onSend={onSend}
            composerRef={composerRef}
            seaLabel={seaPub ? shortSea(seaPub) : "no SEA key"}
          />
        </div>
      </div>

      {active ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={active.label}
          data-testid="squad-drawer"
          className="fixed inset-y-0 right-0 z-[60] flex w-full max-w-md flex-col overflow-y-auto border-l border-rule bg-ground p-4 shadow-lg"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-ink">{active.label}</h2>
              <p className="mt-1 text-xs uppercase text-ink-muted">
                {active.status.state} · {PILOT_FORUM_LABEL} · {active.status.type}
              </p>
            </div>
            <button type="button" className={btnSecondary} onClick={() => setSelected(null)}>
              Close
            </button>
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-xs text-ink-muted">
            <div>
              <dt>Started</dt>
              <dd className="font-data text-ink">{formatClock(active.status.started)}</dd>
            </div>
            <div>
              <dt>Tokens</dt>
              <dd className="font-data text-ink">{formatTokens(active.status.tokens)}</dd>
            </div>
            <div>
              <dt>Runtime</dt>
              <dd className="font-data text-ink">{formatRuntime(active.status.runtime)}</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm text-ink">{active.status.task}</p>
          <div className="mt-2 h-1 bg-rule">
            <div className="h-1 bg-signal" style={{ width: `${clampProgress(active.status.progress)}%` }} />
          </div>
          <h3 className="mt-4 text-xs font-semibold uppercase text-ink-muted">Subtasks</h3>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {active.subtasks.map((task) => (
              <li key={task.id}>
                <span className="text-xs uppercase text-ink-muted">{task.state}</span> {task.label}
              </li>
            ))}
          </ul>
          <h3 className="mt-4 text-xs font-semibold uppercase text-ink-muted">Last prompt</h3>
          <p className="mt-1 text-sm text-ink">
            {active.status.lastPrompt}
            {active.promptBy ? <span className="text-ink-muted"> · {active.promptBy}</span> : null}
          </p>
          <h3 className="mt-4 text-xs font-semibold uppercase text-ink-muted">Updates</h3>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {active.updates.map((update) => (
              <li key={update.id}>
                <span className="font-data text-xs text-ink-muted">{formatClock(update.ts)}</span> {update.body}
              </li>
            ))}
          </ul>
          <h3 className="mt-4 text-xs font-semibold uppercase text-ink-muted">Results</h3>
          <p className="mt-1 text-sm text-ink">{active.status.result}</p>
          {active.artifactNote ? <p className="mt-1 text-xs text-ink-muted">{active.artifactNote}</p> : null}
          <h3 className="mt-4 text-xs font-semibold uppercase text-ink-muted">Needs</h3>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {needIds(active.status.needs).map((id) => {
              const need = needs.get(id);
              if (!need) return null;
              return (
                <li key={id}>
                  {need.severity} · stated {need.stated} · {need.body}
                  {need.acceptedOffer ? ` · offer ${need.acceptedOffer.slice(0, 12)}` : ""}
                </li>
              );
            })}
          </ul>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {[...offers.values()]
              .filter((offer) => needIds(active.status.needs).includes(offer.need))
              .map((offer) => (
                <li key={forumOfferCacheKey(offer.need, offer.id)}>
                  offer · stated {offer.stated} · {offer.body}
                </li>
              ))}
          </ul>
          {active.status.state === "needs" || active.status.state === "emergency" ? (
            <label className="mt-4 block text-xs text-ink-muted" htmlFor="squad-offer-body">
              Offer help
              <textarea
                id="squad-offer-body"
                className={`${field} mt-1 min-h-16 w-full`}
                value={offerBody}
                maxLength={280}
                onChange={(event) => setOfferBody(event.target.value)}
              />
            </label>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            {active.status.state === "needs" || active.status.state === "emergency" ? (
              <>
                <button
                  type="button"
                  data-testid="squad-offer"
                  className={btnPrimary}
                  onClick={() => onOffer(active)}
                >
                  Offer help
                </button>
                <button
                  type="button"
                  data-testid="squad-accept"
                  className={btnSecondary}
                  onClick={() => onAccept(active)}
                >
                  Accept offer
                </button>
                <button
                  type="button"
                  data-testid="squad-decline"
                  className={btnSecondary}
                  onClick={() => onDecline(active)}
                >
                  Decline offer
                </button>
              </>
            ) : null}
            <button type="button" data-testid="squad-reopen" className={btnSecondary} onClick={() => onReopen(active)}>
              Reopen
            </button>
            <button type="button" data-testid="squad-reply" className={btnSecondary} onClick={() => onReply(active)}>
              Reply in chat
            </button>
            <button type="button" data-testid="squad-pause" className={btnSecondary} onClick={() => onPause(active)}>
              Pause
            </button>
          </div>
          <div className="mt-3 flex gap-2">
            <input
              className={`${field} min-w-0 flex-1`}
              value={reassignTo}
              onChange={(event) => setReassignTo(event.target.value)}
              placeholder="SEA pubkey"
              aria-label="Reassign target"
              data-testid="squad-reassign-target"
            />
            <button
              type="button"
              data-testid="squad-reassign"
              className={btnSecondary}
              onClick={() => onReassign(active)}
            >
              Reassign
            </button>
          </div>
          <p className="mt-3 text-xs text-ink-muted">Tag {forumChatTag(PILOT_FORUM_ID)}</p>
        </div>
      ) : null}
    </div>
  );
}

function ChatColumn({
  chat,
  draft,
  setDraft,
  onSend,
  composerRef,
  seaLabel,
}: {
  chat: FeedItem[];
  draft: string;
  setDraft: (value: string) => void;
  onSend: () => void | Promise<void>;
  composerRef?: { current: HTMLTextAreaElement | null };
  seaLabel: string;
}) {
  return (
    <section data-testid="squad-chat" className="mt-3 flex h-[32rem] flex-col border border-rule bg-panel lg:mt-0">
      <h2 className="border-b border-rule px-3 py-2 text-sm font-semibold text-ink">Live chat</h2>
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {chat.map((item) => {
          const tone = chatTone(item);
          const klass =
            tone === "emergency"
              ? "border-l-2 border-status-fail pl-2"
              : tone === "system"
                ? "text-ink-muted"
                : "";
          return (
            <li key={item.id} className={`text-sm text-ink ${klass}`}>
              <span className="font-data text-xs text-ink-muted">
                {formatClock(item.ts)} {authorLabel(item.author)}
              </span>
              <p>
                <ChatBody body={item.body} />
              </p>
            </li>
          );
        })}
      </ol>
      <form
        className="border-t border-rule p-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <label className="text-xs text-ink-muted" htmlFor="squad-composer">
          statement as {seaLabel}
        </label>
        <textarea
          id="squad-composer"
          ref={(node) => {
            if (composerRef) composerRef.current = node;
          }}
          className={`${field} mt-1 min-h-16 w-full`}
          value={draft}
          maxLength={280}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className={`${btnPrimary} mt-2`}>
          Send
        </button>
      </form>
    </section>
  );
}

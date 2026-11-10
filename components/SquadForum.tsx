"use client";

import {
  acceptForumOffer, declineForumOffer, continueForumOfferCancellation,
  offerForumHelp, reopenForumNeed,
} from "@/lib/identity/forum-transitions";

import { createForumReceiveRetry } from "@/lib/forum-receive-retry";
import { createForumReceiveProofs } from "@/lib/forum-receive-proofs";
import { BusinessRoleStrips } from "@/components/BusinessRoleStrips";
import { businessTemplateRetryKey, createBusinessRoles, parseBusinessTemplate } from "@/lib/forum-business-roles";
import { LiveForumReports } from "./LiveForumReports";
import { forwardFields, isNeed, type BoardSource, type ReportParents } from "@/lib/forum-report-forward";
import { readableForumChat } from "@/lib/forum-readable-chat";
import { ReportList, ForumPreviewReports } from "./ForumPreviewReports";
import { ForumHierarchyPreview, type PreviewLevel } from "@/components/ForumHierarchyPreview";
import { ForumShell, type ForumTab } from "@/components/ForumShell";
import { ForumDrawerRecords } from "@/components/ForumDrawerRecords";
import { SquadDelegationControls } from "@/components/SquadDelegationControls";
import Link from "next/link";
import { forumSoulNode } from "@/lib/forum-transport";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGunPeer, type FeedGun } from "@/components/GunPeerProvider";
import { publishForumAuthorized } from "@/lib/forum-authorized-publish";
import { useForumAuthority } from "@/components/ForumAuthorityProvider";
import { useIdentitySession } from "@/components/useIdentitySession";
import {
  btnPrimary,
  btnSecondary,
  chipOff,
  chipOn,
  field,
} from "@/lib/brand-ui";
import { toGunNode, type FeedItem } from "@/lib/feed-types";
import {
  PILOT_AGENTS,
  PILOT_ALARM,
  PILOT_CHAT,
  PILOT_LABELS,
  PILOT_NEEDS,
  admitPilotRoster,
} from "@/lib/forum-squad-fixture";
import {
  freshestOfferParent, retainForumOffer, forumOfferFits,
  pendingClosureDominates, retainChatTombstone, pruneChatTombstones, CHAT_TOMBSTONE_TTL_MS, authorizeStatusAdmission,
  retainForumChat, forumChatFits,
  pendingNeedKey, statusRevisionAllowed, grantForumWatch, expireForumWatches, type ForumWatch,
  forumOfferCacheKey, offersForNeed, pendingClosureContext, needSignerCandidates,
  cacheForumStatus, restoreForumStatusCache, retainPendingStatus, prunePendingStatuses,
  statusWatchCandidate, grantStatusWatch, expireStatusWatches, type PendingStatus,
  chatAddresses,
  chatTone,
  clampProgress,
  cacheForumNeed,
  chatRemovalCandidate,
  commitForumAlarm,
  retainForumRemoval,
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
  restoreForumNeedCache,
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
  parseForumAgentRemoval,
  parseForumAgentStatus,
  parseForumMeshRemoval,
  parseForumNeed,
  parseForumOffer,
  parseForumRoleMembership,
  pickDisplayedStatus,
  shortSea,
  showFullVitals,
  buildForumStatement,
  withoutChatIds,
  type SquadAgent,
  type VitalsMode,
} from "@/lib/forum-squad";
import { readForumSignature, signForumRecord, signatureOf } from "@/lib/forum-sign";
import { soulKeyMatches } from "@/lib/unshare";
import { acquireBrowserGun } from "@/lib/browser-gun";
import {
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

import { squadView, isPublicSquadPrincipal, type LiveSquadSpec, type SquadView } from "@/lib/squad-view";

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

function putSoul(gun: FeedGun | null, soul: string, data: unknown, live: boolean): boolean {
  if (!live || !gun) return false;
  const node = forumSoulNode(gun, soul);
  if (!node) return false;
  node.put(data);
  return true;
}

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

/** Namespace changes remount every subscription, cache floor and pending proof. */
export function SquadForum({ live, reportParents, sessionKey = null }: { live?: LiveSquadSpec; reportParents?: ReportParents; sessionKey?: string | null }) {
  const view = squadView(live);
  return <SquadForumView key={view.key} view={view} reportParents={reportParents} sessionKey={sessionKey} />;
}
function SquadForumView({ view, sessionKey, reportParents }: { view: SquadView; reportParents?: ReportParents; sessionKey: string | null }) {
  const { forumId, label: forumLabel, live: liveEnabled, storage } = view;
  function authorLabel(pub: string): string {
    return liveEnabled ? shortSea(pub) : PILOT_LABELS.get(pub) ?? shortSea(pub);
  }
  const session = useIdentitySession();
  const authority = useForumAuthority();
  const gunPeer = useGunPeer();
  const register = gunPeer?.register;
  const connectedRef = useRef(false);
  const retryRef = useRef<ReturnType<typeof createForumReceiveRetry> | null>(null);
  const proofs = useMemo(() => createForumReceiveProofs({
    key: principal => {
      const now = Math.floor(Date.now() / 1000);
      if (liveEnabled && isPublicSquadPrincipal(principal)) return null;
      return authority?.graph.writerKey(principal, now, now) ?? null;
    },
    ready: () => connectedRef.current && authority?.graph.ownerOf(forumId) === view.owner,
    verify: readForumSignature,
  }), [authority]);
  const businessRoles = useMemo(() => createBusinessRoles(forumId, proofs.valid), [proofs]);
  const [seaPub, setSeaPub] = useState<string | null>(null);
  const [oauthLinked, setOauthLinked] = useState(false);
  const [vitals, setVitals] = useState<VitalsMode>("auto");
  const [escalations, setEscalations] = useState<ReadonlyMap<string, { revision: number; command: boolean }>>(new Map());
  const [sharedReports, setSharedReports] = useState<ReadonlyMap<FeedItem, "Fleet" | "Command">>(new Map());
  const [readReports, setReadReports] = useState(new Set<string>());
  const [previewLevel, setPreviewLevel] = useState<PreviewLevel>("Squad");
  const [tab, setTab] = useState<ForumTab>("board");
  const [filters, setFilters] = useState<Set<ForumAgentState>>(() => new Set());
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState("");
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
    () => new Set(liveEnabled ? [] : PILOT_AGENTS.map((agent) => agent.status.seaPubkey)),
  );
  const gunRef = useRef<FeedGun | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const pairRef = useRef<SeaPair | null>(null);
  const graphRef = useRef<SeeGraph | null>(null);
  const needsRef = useRef<Map<string, ForumNeed>>(new Map());
  const offersRef = useRef<Map<string, ForumOffer>>(new Map());
  const pendingNeedsRef = useRef<Map<string, PendingNeedEntry>>(new Map());
  const alarmFloorRef = useRef<ReturnType<typeof parseForumAlarmUpdate>>(null);
  const pendingOffersRef = useRef<Map<string, PendingOfferEntry>>(new Map());
  const highWaterRef = useRef<Map<string, ForumNeed>>(new Map());
  const needAdmitRef = useRef<Map<string, string>>(new Map());
  const [authenticatedNeeds, setAuthenticatedNeeds] = useState<Map<string, ForumNeed>>(() => new Map());
  const acceptNeedRef = useRef<(data: unknown, key: string, gen: number, fromRemoval?: boolean, fromPending?: boolean) => Promise<void>>(
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
  const forwards = useRef(new WeakMap<BoardSource, ReturnType<typeof forwardFields>>());
  const chatRowsRef = useRef<FeedItem[]>([]);
  const admittedRef = useRef(admitted);
  const pendingStatusRef = useRef<Map<string, PendingStatus>>(new Map());
  const statusHighWaterRef = useRef<Map<string, ForumAgentStatus>>(new Map());
  const sampleAcl = useMemo(() => {
    if (liveEnabled) return null;
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
      if (liveEnabled && ((pair && isPublicSquadPrincipal(pair.pub)) || (pubHint && isPublicSquadPrincipal(pubHint)))) {
        pairRef.current = null; setSeaPub(null); return;
      }
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
        const readable = pub && isSeaPubkey(pub) && (!liveEnabled || !isPublicSquadPrincipal(pub)) ? pub : null;
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
    // Called only after signature and admission checks. Never promote the
    // remaining unsigned replay cache when one row authenticates.
    setAuthenticatedNeeds((prev) => cacheForumNeed(prev, need, highWaterRef.current.get(need.id)) ?? prev);
    if (!raiseNeedHighWater(highWaterRef.current, need)) return;
    const next = new Map(highWaterRef.current);
    try {
      forumStorage()?.setItem(storage.needs, serializeNeedHighWater(next));
    } catch {
      // Private mode can refuse the write. The in-memory mark still holds.
    }
  }

  useEffect(() => {
    if (!liveEnabled) return;
    const loaded = restoreForumNeedCache(forumStorage()?.getItem(storage.needs) ?? null);
    const statuses = restoreForumStatusCache(forumStorage()?.getItem(storage.status) ?? null, forumId);
    try {
      const saved = forumStorage()?.getItem(storage.alarm);
      alarmFloorRef.current = saved && saved.length <= 4096 ? parseForumAlarmUpdate(JSON.parse(saved), forumId) : null;
    } catch { alarmFloorRef.current = null; }
    statusHighWaterRef.current = statuses.highWater;
    setMeshStatus(statuses.mesh);
    highWaterRef.current = loaded.highWater;
    setAuthenticatedNeeds(loaded.authenticated);
  }, []);

  useEffect(() => {
    if (!liveEnabled || !register) return;
    let cancelled = false;
    const retries = createForumReceiveRetry(); retryRef.current = retries;
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
    let offTemplate: { off?: () => void } | undefined;
    let offRoles: { off?: () => void } | undefined;

    const connection = acquireBrowserGun(window.location.origin);
    void (async () => {
      const root = await connection.ready.catch(() => null);
      if (!root || cancelled) return;
      const gun = root;
      gunRef.current = gun;
      register(gun);
      connection.onStatus(up => {
        if (cancelled) return;
        connectedRef.current = up;
        if (!up) proofs.interrupt();
        setAclRev(n => n + 1);
      });
      const forum = gun.get("s3rch").get("forums").get(forumId);
      const versions = createMeshEventVersions();
      function knownChatIds(): string[] {
        return chatIdsRef.current;
      }
      function enrollPub(pub: string, evidence: object) {
        if (liveEnabled && isPublicSquadPrincipal(pub)) return;
        if (!proofs.enroll(pub, evidence)) return;
        if (!admittedRef.current.has(pub)) {
          const next = new Set(admittedRef.current);
          next.add(pub);
          admittedRef.current = next;
          setAdmitted(next);
        }
        prunePendingStatuses(pendingStatusRef.current, Date.now());
        const waiting = pendingStatusRef.current.get(pub);
        if (!waiting || !proofs.valid(waiting.status)) return;
        pendingStatusRef.current.delete(pub);
        watchStatusRemoval(pub);
        commitMeshStatus(waiting.status);
      }
      function commitMeshStatus(status: ForumAgentStatus) {
        if (liveEnabled && isPublicSquadPrincipal(status.seaPubkey)) return;
        if (!proofs.valid(status) || !proofs.enrolled(status.seaPubkey)) return;
        if (!cacheForumStatus(statusHighWaterRef.current, status)) return;
        try {
          forumStorage()?.setItem(storage.status, JSON.stringify([...statusHighWaterRef.current.values()]));
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
        setHiddenChat([...chatTombsRef.current.keys()]);
        for (const key of [...chatRemovalWatches.keys()]) {
          if (ids.some(id => soulKeyMatches(id, key))) {
            chatRemovalWatches.delete(key); chatRemovalOffs.get(key)?.off?.(); chatRemovalOffs.delete(key);
          }
        }
        setMeshChat((prev) => withoutChatIds(prev, ids));
        setLocalChat((prev) => withoutChatIds(prev, ids));
      }
      function noteOfferCancel(need: string, offer: string) {
        const id = forumOfferCacheKey(need, offer);
        if (offerCancelsRef.current.has(id)) return;
        const next = retainForumRemoval(offerCancelsRef.current, id);
        offerCancelsRef.current = next;
        setOfferCancels(next);
      }
      function noteOfferRemoval(need: string, offer: string) {
        const id = forumOfferCacheKey(need, offer);
        if (removedOffersRef.current.has(id)) return;
        const next = retainForumRemoval(removedOffersRef.current, id);
        removedOffersRef.current = next;
        setRemovedOffers(next);
      }
      function noteNeedRemoval(id: string) {
        if (removedNeedsRef.current.has(id)) return;
        const next = retainForumRemoval(removedNeedsRef.current, id);
        removedNeedsRef.current = next;
        setRemovedNeeds(next);
      }
      function noteAgentRemoval(pub: string) {
        if (removedAgentsRef.current.has(pub)) return;
        const next = new Map(removedAgentsRef.current);
        if (next.size >= 128) next.delete(next.keys().next().value!);
        next.set(pub, Number.POSITIVE_INFINITY);
        removedAgentsRef.current = next;
        setRemovedAgents(next);
      }
      function noteChatTomb(id: string) {
        const next = new Map(chatTombsRef.current);
        retainChatTombstone(next, id, Date.now());
        chatTombsRef.current = next;
        setChatTombs(next);
      }
      function stickSigned(soul: string, data: unknown) {
        try {
          putSoul(gunRef.current, soul, data, liveEnabled);
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
        const proof = proofs.begin();
        const queueKey = `${fromRemoval ? "remove" : fromCancel ? "cancel" : "offer"}:${parentNeedId}:${key ?? ""}`;
        const versionScope = fromRemoval ? "offer-remove" : fromCancel ? "offer-cancel" : "offer";
        if (cancelled || !versions.current(versionScope, `${parentNeedId}:${key ?? ""}`, gen)) return false;
        const retryId = `${versionScope}:${parentNeedId}:${key ?? ""}`;
        retries.remember(retryId, data, row => acceptOffer(row, key, parentNeedId, gen, fromCancel, fromRemoval));
        const sig = signatureOf(data);
        if (!sig || !data || typeof data !== "object") return false;
        if (!forumOfferFits(data)) return false;
        const row = data as { helper?: unknown; need?: unknown };
        const hintedNeed = typeof row.need === "string" ? row.need : undefined;
        if (hintedNeed !== undefined && hintedNeed !== parentNeedId) return false;
        const pending = pendingNeedsRef.current.get(parentNeedId);
        let parentNeed = freshestOfferParent(needsRef.current.get(parentNeedId), pending, Date.now());
        if (parentNeed && !proofs.valid(parentNeed)) parentNeed = undefined;
        const candidates = offerSignerCandidates({
          offerId: key,
          hintedHelper: typeof row.helper === "string" ? row.helper : undefined,
          owner: graphRef.current?.ownerOf(parentNeedId),
          subject: parentNeed?.subject,
        });
        let payload: unknown = null;
        let signer = "";
        for (const pub of candidates) {
          if (cancelled || !proof.current() || !versions.current(versionScope, `${parentNeedId}:${key ?? ""}`, gen)) return false;
          const verified = await proof.read(sig, pub);
          if (verified) {
            payload = verified;
            signer = pub;
            break;
          }
        }
        if (cancelled || !proof.current() || !versions.current(versionScope, `${parentNeedId}:${key ?? ""}`, gen)) return false;
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
        parentNeed = freshestOfferParent(needsRef.current.get(parentNeedId), pendingNeedsRef.current.get(parentNeedId), Date.now());
        if (parentNeed && !proofs.valid(parentNeed)) parentNeed = undefined;
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
              forumId: forumId,
              parentNeedId,
              resolved: authority.resolved,
            })
          ) {
            return false;
          }
          if (!proof.current() || !versions.current(versionScope, `${parentNeedId}:${key}`, gen)) return false;
          pendingOffersRef.current.delete(queueKey);
          if (!proofs.ready()) return false;
          retries.forget(retryId);
          noteOfferRemoval(parentNeedId, removal.id);
          stickSigned(forumOfferRemovalSoul(forumId, parentNeedId, removal.id), data);
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
        if (offer.stated === 0 && offerCancelAwaitingKeys({ graph: graphRef.current, need: parentNeed, needId: parentNeedId })) {
          queueOffer("authority", offer.id);
          return false;
        }
        const named = parentNeed;
        if (named && !proof.depend(named)) return false;
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
        if (!authorizeForumOffer(offer, signer, forumId, party, seen)) {
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
        if (!proof.current() || !versions.current(versionScope, `${parentNeedId}:${key ?? ""}`, gen)) return false;
        if (removedOffersRef.current.has(forumOfferCacheKey(offer.need, offer.id))) return false;
        if (offer.stated === 1 && offerBlockedByCancel(offerCancelsRef.current, offer)) return false;
        if (!proofs.ready() || !proof.retain(offer)) return false;
        retries.forget(retryId);
        if (offer.stated === 0) noteOfferCancel(offer.need, offer.id);
        pendingOffersRef.current.delete(queueKey);
        setMeshOffers((prev) => {
          const existing = prev.get(forumOfferCacheKey(offer.need, offer.id));
          if (!mergeForumOffer(existing, offer)) return prev;
          return retainForumOffer(prev, offer);
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
      async function acceptStatus(data: unknown, key: string, gen: number, fromRemoval = false, fromAdmission = false) {
        const proof = proofs.begin();
        const versionScope = fromAdmission ? "status-admission" : fromRemoval ? "status-remove" : "status";
        if (cancelled || !versions.current(versionScope, key, gen)) return;
        const retryId = `${versionScope}:${key}`;
        retries.remember(retryId, data, row => acceptStatus(row, key, gen, fromRemoval, fromAdmission));
        const sig = signatureOf(data);
        if (!sig || !data || typeof data !== "object") return;
        const row = data as { seaPubkey?: unknown; id?: unknown };
        const hintedId = typeof row.id === "string" ? row.id : "";
        const claimed = typeof row.seaPubkey === "string" ? row.seaPubkey : "";
        const candidates = [
          claimed,
          hintedId ? (graphRef.current?.ownerOf(hintedId) ?? "") : "",
          graphRef.current?.ownerOf(forumId) ?? "",
        ].filter((pub, index, all) => pub && all.indexOf(pub) === index);
        let payload: unknown = null;
        let signer = "";
        for (const pub of candidates) {
          if (cancelled || !proof.current() || !versions.current(versionScope, key, gen)) return;
          const verified = await proof.read(sig, pub);
          if (verified) {
            payload = verified;
            signer = pub;
            break;
          }
        }
        if (cancelled || !proof.current() || !versions.current(versionScope, key, gen) || !payload) return;
        const removal = parseForumAgentRemoval(payload);
        if (removal) {
          if (fromAdmission) return;
          const forumOwner = graphRef.current?.ownerOf(forumId);
          if (
            !authorizeForumAgentRemoval({
              removal,
              mapKey: key,
              signer,
              forumOwner,
              forumId: forumId,
            })
          ) {
            return;
          }
          if (!proof.current() || !versions.current(versionScope, key, gen)) return;
          if (!proofs.ready()) return;
          retries.forget(retryId);
          noteAgentRemoval(removal.seaPubkey);
          dropMeshStatus(removal.seaPubkey);
          stickSigned(forumStatusRemovalSoul(forumId, removal.seaPubkey), data);
          return;
        }
        const status = parseForumAgentStatus(payload);
        const forumOwner = graphRef.current?.ownerOf(forumId);
        if (!status || (liveEnabled && isPublicSquadPrincipal(status.seaPubkey)) || fromRemoval || !proof.retain(status, () => signer === forumOwner
          ? graphRef.current?.ownerOf(forumId) === signer : signer === status.seaPubkey)) return;
        if (liveReplayBlocked(status.lastUpdate, removedAgentsRef.current.get(status.seaPubkey))) return;
        if (fromAdmission && !authorizeStatusAdmission(status, key, signer, forumOwner, forumId)) return;
        const enrolled = proofs.enrolled(status.seaPubkey);
        const admission = forumStatusAdmission({
          status,
          mapKey: key,
          signer,
          forumOwner,
          forumId: forumId,
          enrolled,
        });
        if (!proof.current() || !versions.current(versionScope, key, gen)) return;
        if (!statusRevisionAllowed(status, signer, forumOwner, Math.floor(Date.now() / 1000))) return;
        if (admission === "pending") {
          retainPendingStatus(pendingStatusRef.current, status, Date.now());
          watchStatusRemoval(status.seaPubkey);
          return;
        }
        if (admission !== "owner" && admission !== "enrolled") return;
        if (!proofs.ready()) return;
        retries.forget(retryId);
        if (admission === "owner") {
          if (!fromAdmission) stickSigned(`${forumAgentSoul(forumId, key)}/admission`, data);
          enrollPub(status.seaPubkey, status);
        }
        pendingStatusRef.current.delete(status.seaPubkey);
        watchStatusRemoval(status.seaPubkey);
        commitMeshStatus(status);
      }
      async function acceptNeed(data: unknown, key: string, gen: number, fromRemoval = false, fromPending = false) {
        const proof = proofs.begin();
        const queueKey = pendingNeedKey(key, fromRemoval);
        const versionScope = fromPending ? "need-pending" : fromRemoval ? "need-remove" : "need";
        if (cancelled || !versions.current(versionScope, key, gen)) return;
        const retryId = `${versionScope}:${key}`;
        retries.remember(retryId, data, row => acceptNeed(row, key, gen, fromRemoval, fromPending));
        const discardUnverified = () => {
          if (!pendingNeedsRef.current.get(queueKey)?.context) pendingNeedsRef.current.delete(queueKey);
        };
        const sig = signatureOf(data);
        if (!sig || !data || typeof data !== "object") {
          discardUnverified();
          return;
        }
        const hintedId = (data as { id?: unknown }).id;
        const hintedSubject = (data as { subject?: unknown }).subject;
        if (typeof hintedId !== "string" || key !== hintedId) {
          discardUnverified();
          return;
        }
        let owner = graphRef.current?.ownerOf(hintedId);
        let signer = "";
        let payload: unknown = null;
        for (const candidate of needSignerCandidates(owner, needsRef.current.get(key)?.subject, hintedSubject)) {
          if (cancelled || !proof.current() || !versions.current(versionScope, key, gen)) return;
          payload = await proof.read(sig, candidate);
          if (payload) { signer = candidate; break; }
        }
        if (cancelled || !proof.current() || !versions.current(versionScope, key, gen)) return;
        owner = graphRef.current?.ownerOf(hintedId);
        if (!payload) {
          const now = Date.now();
          const kept =
            !owner && !pendingNeedsRef.current.get(queueKey)?.context &&
            retainPendingNeed(
              pendingNeedsRef.current,
              queueKey,
              {
                data,
                fromRemoval,
                gen,
                at: now,
                parentId: forumId,
                objectId: key,
                reason: "owner",
              },
              now,
            );
          if (!kept) discardUnverified();
          return;
        }
        const removal = parseForumMeshRemoval(payload);
        if (removal && removal.kind === "need") {
          const candidate = needsRef.current.get(removal.id);
          const known = proofs.valid(candidate) ? candidate : undefined;
          if (
            !authorizeForumMeshRemoval({
              removal,
              mapKey: key,
              signer,
              owner: graphRef.current?.ownerOf(removal.id),
              subject: known?.subject,
              forumId: forumId,
            })
          ) {
            return;
          }
          if (!proof.current() || !versions.current(versionScope, key, gen)) return;
          discardUnverified();
          pendingNeedsRef.current.delete(queueKey);
          pendingNeedsRef.current.delete(pendingNeedKey(key));
          versions.bump("need-pending", key);
          if (!proofs.ready()) return;
          retries.forget(retryId);
          noteNeedRemoval(removal.id);
          stickSigned(forumNeedRemovalSoul(forumId, removal.id), data);
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
          discardUnverified();
          return;
        }
        if (pendingClosureDominates(pendingNeedsRef.current.get(key), need, Date.now())) return;
        const candidate = needsRef.current.get(need.id);
        const known = proofs.valid(candidate) ? candidate : undefined;
        const closure = () =>
          graphRef.current
            ? {
                graph: graphRef.current,
                postedOffers: offersForNeed(new Map([...offersRef.current].filter(([, row]) => proofs.valid(row))), need.id),
                now: Math.floor(Date.now() / 1000),
              }
            : undefined;
        const admitSig = ownerAdmitSig(payload);
        let admitted: ForumNeed | undefined;
        const admissionOwner = owner;
        if (admitSig && owner) {
          const opened = await proof.read(admitSig, owner);
          if (cancelled || !proof.current() || !versions.current(versionScope, key, gen)) return;
          const parsed = opened ? parseForumNeed(opened) : null;
          if (parsed && forumNeedAdmission(parsed, need)) admitted = parsed;
        }
        owner = graphRef.current?.ownerOf(hintedId);
        if (owner !== admissionOwner) return;
        if (signer !== owner && !admitted && known && !proof.depend(known)) return;
        const admittedOwner = owner;
        if (!proof.retain(need, () => graphRef.current?.ownerOf(need.id) === admittedOwner)) return;
        const allowed = authorizeForumNeed(need, signer, owner, forumId, known, closure(), admitted);
        if (!proof.current() || !versions.current(versionScope, key, gen)) {
          discardUnverified();
          return;
        }
        if (!allowed) {
          const closing = need.stated === 0 && !!need.acceptedOffer;
          const freshClosure = closure();
          const gate = closing && freshClosure ? needClosureStatus(need, freshClosure) : "denied";
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
                    gen: context ? versions.bump("need-pending", key) : gen,
                    at: now,
                    parentId: forumId,
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
          if (!kept) discardUnverified();
          return;
        }
        if (!proofs.ready()) return;
        retries.forget(retryId);
        pendingNeedsRef.current.delete(queueKey);
        versions.bump("need-pending", key);
        const cached = cacheForumNeed(needsRef.current, need, highWaterRef.current.get(need.id));
        if (!cached) return;
        forwards.current.set(need, forwardFields(data));
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
        const proof = proofs.begin();
        if (cancelled || !versions.current("alarm", "pin", gen)) return;
        const retryId = "alarm:pin";
        retries.remember(retryId, data, row => acceptAlarm(row, gen));
        const sig = signatureOf(data);
        const owner = graphRef.current?.ownerOf(forumId);
        if (!sig || !owner) return;
        const payload = await proof.read(sig, owner);
        if (cancelled || !proof.current() || !versions.current("alarm", "pin", gen) || !payload || typeof payload !== "object") return;
        if (!proofs.ready() || graphRef.current?.ownerOf(forumId) !== owner) return;
        const update = parseForumAlarmUpdate(payload, forumId);
        if (!update) return;
        if (update.kind === "pin" && !authorizeForumAlarm(update.alarm, owner, owner, forumId)) return;
        if (!proof.current() || !versions.current("alarm", "pin", gen)) return;
        const committed = commitForumAlarm({ rev: alarmFloorRef.current?.rev, previous: alarmFloorRef.current ?? undefined }, update);
        if (!committed) return;
        if (committed.alarm && !proof.retain(committed.alarm, () => graphRef.current?.ownerOf(forumId) === owner)) return;
        retries.forget(retryId);
        alarmFloorRef.current = update;
        try { forumStorage()?.setItem(storage.alarm, JSON.stringify(update.kind === "pin"
          ? { ...update.alarm, rev: update.rev } : { forumId: update.forumId, pinned: 0, rev: update.rev })); } catch { /* Keep the in-memory floor. */ }
        setAlarmHeard(true);
        setMeshAlarm(committed.alarm);
      }
      async function acceptTemplate(data: unknown, knownRetryId?: string) {
        const proof = proofs.begin();
        if (cancelled) return;
        const sig = signatureOf(data);
        if (!sig) return;
        const retryId = knownRetryId ?? await businessTemplateRetryKey(sig);
        if (!retryId || cancelled || !proof.current()) return;
        // Unversioned templates must all verify independently. A newer arrival
        // cannot discard a conflicting mode, including while keys are missing.
        retries.remember(retryId, { sig }, row => acceptTemplate(row, retryId));
        const owner = graphRef.current?.ownerOf(forumId);
        if (!owner) return;
        const payload = await proof.read(sig, owner);
        if (cancelled || !proof.current() || !proofs.ready() || graphRef.current?.ownerOf(forumId) !== owner) return;
        const template = parseBusinessTemplate(payload, forumId);
        if (!template || !proof.retain(template, () => graphRef.current?.ownerOf(forumId) === owner)) return;
        businessRoles.template(template);
        retries.forget(retryId);
        setAclRev(n => n + 1);
      }
      async function acceptRole(data: unknown, roleToken: string, mapKey: string, gen: number) {
        const proof = proofs.begin();
        if (cancelled || !versions.current("role", `${roleToken}:${mapKey}`, gen)) return;
        const retryId = `role:${roleToken}:${mapKey}`;
        retries.remember(retryId, data, row => acceptRole(row, roleToken, mapKey, gen));
        const sig = signatureOf(data);
        const forumOwner = graphRef.current?.ownerOf(forumId);
        if (!sig || !forumOwner || !data || typeof data !== "object") return;
        const payload = await proof.read(sig, forumOwner);
        if (cancelled || !proof.current() || !versions.current("role", `${roleToken}:${mapKey}`, gen) || !payload) return;
        if (!proofs.ready() || graphRef.current?.ownerOf(forumId) !== forumOwner) return;
        const membership = parseForumRoleMembership(payload);
        if (!membership || (liveEnabled && isPublicSquadPrincipal(membership.principal))) return;
        if (
          !authorizeForumRoleAdmission({
            membership,
            roleToken,
            mapKey,
            signer: forumOwner,
            forumOwner,
            forumId: forumId,
          })
        ) {
          return;
        }
        if (!proof.current() || !versions.current("role", `${roleToken}:${mapKey}`, gen) || !forumWatches.has(`role:${roleToken}`)) return;
        grantForumWatch(forumWatches, "role", roleToken, true, Date.now());
        if (!proof.retain(membership, () => graphRef.current?.ownerOf(forumId) === forumOwner)) return;
        retries.forget(retryId);
        enrollPub(membership.principal, membership);
        businessRoles.membership(membership);
        setAclRev(n => n + 1);
      }
      function chatTombStamp(id: string): number | undefined {
        const direct = chatTombsRef.current.get(id);
        if (direct !== undefined && Date.now() - direct < CHAT_TOMBSTONE_TTL_MS) return Number.POSITIVE_INFINITY;
        for (const [known, stamp] of chatTombsRef.current) {
          if (soulKeyMatches(id, known) && Date.now() - stamp < CHAT_TOMBSTONE_TTL_MS) return Number.POSITIVE_INFINITY;
        }
        return undefined;
      }
      function watchChatRemoval(key: string) {
        if (cancelled) return;
        const now = Date.now();
        expireChatRemovalWatches(now);
        if (!grantChatRemovalWatch({ watches: chatRemovalWatches, key, verified: true, now, onEvict(old) {
          chatRemovalOffs.get(old)?.off?.(); chatRemovalOffs.delete(old);
        } })) return;
        const off = gun.get("s3rch").get("items").get(key).get("remove").on((row) => {
          if (cancelled || row == null) return;
          void acceptChat(row, key, true);
        });
        chatRemovalOffs.set(key, off);
      }
      async function acceptChat(data: unknown, key: string | undefined, fromRemoval = false, retryGen?: number): Promise<boolean> {
        const proof = proofs.begin();
        if (data === undefined || typeof key !== "string") return false;
        const versionScope = fromRemoval ? "chat-remove" : "chat";
        const gen = retryGen ?? versions.bump(versionScope, key);
        if (cancelled || !versions.current(versionScope, key, gen)) return false;
        const retryId = `${versionScope}:${key}`;
        retries.remember(retryId, data, row => acceptChat(row, key, fromRemoval, gen));
        const live = fromRemoval ? null : forumStatementFromNode(data, forumId);
        if (live) {
          const sig = signatureOf(data);
          const author = live.author;
          if (!sig) return false;
          const payload = await proof.read(sig, author);
          if (cancelled || !proof.current() || !versions.current(versionScope, key, gen) || !payload) return false;
          const item = forumStatementFromNode(payload, forumId);
          const priorAuthor = chatRowsRef.current.find((row) => row.id === item?.id)?.author;
          if (!item || !forumChatFits(item) || !authorizeForumChat(item, author, key, forumId, priorAuthor)) return false;
          if (!proof.current() || !versions.current(versionScope, key, gen)) return false;
          if (liveReplayBlocked(item.ts, chatTombStamp(item.id))) return false;
          const graph = authority?.graph, now = Math.floor(Date.now() / 1000);
          if (!proofs.ready() || !graph?.checkDirectSee(item.id, author, now).allowed || !graph.checkPost(item.id, author, now).allowed || !proof.retain(item)) return false;
          retries.forget(retryId);
          if (item.tags.includes("report")) forwards.current.set(item, forwardFields(data));
          setMeshChat((prev) => retainForumChat(prev, item));
          setLocalChat((prev) => retireLocalChat(prev, item.id));
          watchChatRemoval(key);
          return true;
        }
        const sig = signatureOf(data);
        if (!sig) return false;
        const hintedId = typeof (data as { id?: unknown }).id === "string" ? (data as { id: string }).id : key;
        const embedded = chatAuthorFromStatementId(hintedId) ?? chatAuthorFromStatementId(key);
        const remembered = chatRowsRef.current.find((row) => soulKeyMatches(row.id, key))?.author;
        const owner = graphRef.current?.ownerOf(forumId);
        const candidates = [embedded ?? "", remembered ?? "", owner ?? ""].filter(
          (pub, index, all) => pub && all.indexOf(pub) === index,
        );
        let payload: unknown = null;
        let signer = "";
        for (const pub of candidates) {
          if (cancelled || !proof.current() || !versions.current(versionScope, key, gen)) return false;
          const verified = await proof.read(sig, pub);
          if (verified) {
            payload = verified;
            signer = pub;
            break;
          }
        }
        if (cancelled || !proof.current() || !versions.current(versionScope, key, gen) || !payload) return false;
        const payloadId = typeof (payload as { id?: unknown }).id === "string" ? (payload as { id: string }).id : hintedId;
        const author = chatAuthorFromStatementId(payloadId) ?? embedded ?? remembered;
        if (!proofs.ready() || !authorizeForumChatTombstone({ signer, author, owner: graphRef.current?.ownerOf(forumId) })) return false;
        const ids = chatRetractionIds(payload, key, knownChatIds(), forumId);
        if (!proof.current() || !versions.current(versionScope, key, gen) || ids.length === 0) return false;
        retries.forget(retryId);
        hideChat(ids);
        const statementId = typeof (payload as { id?: unknown }).id === "string" ? (payload as { id: string }).id : key;
        stickSigned(forumChatRemovalSoul(statementId), data);
        return false; // Already removed; do not allocate a new removal listener.
      }
      function expireForumListeners() {
        for (const id of expireForumWatches(forumWatches, Date.now())) {
          forumOffs.get(id)?.off?.(); forumOffs.delete(id);
        }
      }
      const chatRemovalWatches = new Map<string, number>();
      const expireChatRemovalWatches = (now: number) => {
        for (const key of chatRemovalWatches.keys()) {
          if (knownChatIds().some(id => soulKeyMatches(id, key))) chatRemovalWatches.set(key, now);
        }
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
      for (const need of (liveEnabled ? [] : PILOT_NEEDS)) {
        watchOffers(need.id);
        watchNeedRemoval(need.id);
      }
      const statusWatches = new Map<string, number>();
      function expireStatuses() {
        const now = Date.now();
        prunePendingStatuses(pendingStatusRef.current, now);
        prunePendingNeeds(pendingNeedsRef.current, now);
        expireForumListeners();
        const tombs = new Map(chatTombsRef.current);
        if (pruneChatTombstones(tombs, now)) {
          chatTombsRef.current = tombs; setChatTombs(tombs); setHiddenChat([...tombs.keys()]);
        }
        expireChatRemovalWatches(now);
        for (const pub of expireStatusWatches(statusWatches, now)) {
          statusOffs.get(pub)?.off?.();
          statusOffs.delete(pub);
        }
      }
      function watchStatusRemoval(pub: string) {
        expireStatuses();
        if (!grantStatusWatch(statusWatches, pub, true, Date.now())) return;
        const base = forum.get("agents").get(pub);
        const removalOff = base.get("remove").on((row) => {
          if (cancelled || row == null) return;
          const gen = versions.bump("status-remove", pub);
          void acceptStatus(row, pub, gen, true);
        });
        const admissionOff = base.get("admission").on((row) => {
          if (cancelled || row == null) return;
          const gen = versions.bump("status-admission", pub);
          void acceptStatus(row, pub, gen, false, true);
        });
        statusOffs.set(pub, { off() { removalOff?.off?.(); admissionOff?.off?.(); } });
      }
      for (const agent of (liveEnabled ? [] : PILOT_AGENTS)) watchStatusRemoval(agent.status.seaPubkey);
      statusTimer = setInterval(expireStatuses, 30_000);
      offAgents = forum.get("agents").map().on((data, key) => {
        if (cancelled || typeof key !== "string" || !statusWatchCandidate(key, data)) return;
        const gen = versions.bump("status", key);
        void acceptStatus(data, key, gen);
      });
      offTemplate = forum.get("template").on(data => {
        if (cancelled || data == null) return;
        void acceptTemplate(data);
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
        if (!chatRemovalCandidate(key, data, forumId)) return;
        void acceptChat(data, key);
      });
    })();

    return () => {
      cancelled = true;
      offAgents?.off?.();
      offNeeds?.off?.();
      offRoles?.off?.();
      offTemplate?.off?.();
      businessRoles.reset();
      for (const off of forumOffs.values()) off.off?.();
      for (const off of chatRemovalOffs.values()) off.off?.();
      for (const off of offerTailOffs.values()) off.off?.();
      for (const off of statusOffs.values()) off.off?.();
      if (statusTimer) clearInterval(statusTimer);
      offAlarm?.off?.();
      offItems?.off?.();
      gunRef.current = null;
      connectedRef.current = false; proofs.reset(); retries.clear(); retryRef.current = null;
      connection.release();
      register(null);
    };
  }, [register, proofs, authority, businessRoles]);

  useEffect(() => {
    if (!liveEnabled) return;
    const off = authority?.subscribe(() => setAclRev((n) => n + 1));
    const timer = setInterval(() => setAclRev(n => n + 1), 1000);
    return () => { off?.(); clearInterval(timer); };
  }, [authority]);

  useEffect(() => {
    retryRef.current?.retry();
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
      void acceptNeedRef.current(row.data, row.objectId, row.gen, row.fromRemoval, !!row.context);
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
  }, [aclRev, localNeeds, localOffers, meshNeeds, meshOffers]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const graph: SeeGraph | null = liveEnabled ? authority?.graph ?? null : sampleAcl;
  graphRef.current = graph;
  chatRowsRef.current = liveEnabled ? meshChat.filter(row => proofs.valid(row)) : [...PILOT_CHAT, ...meshChat, ...localChat];
  chatIdsRef.current = chatRowsRef.current.map((item) => item.id);

  const receivedNeeds = useMemo(
    () =>
      composeForumNeeds({
        pilot: liveEnabled ? [] : PILOT_NEEDS,
        mesh: [...authenticatedNeeds.values(), ...meshNeeds.values()].filter(row => !liveEnabled || (proofs.valid(row) && !!graph?.hasObject(row.id))),
        local: liveEnabled ? [] : [...localNeeds.values()],
        removed: removedNeeds,
      }),
    [localNeeds, meshNeeds, authenticatedNeeds, removedNeeds, aclRev, proofs, graph],
  );
  needsRef.current = receivedNeeds;
  const readAt = Math.floor(Date.now() / 1000);
  const reader = sessionKey && authority?.graph.principalForKey(sessionKey, readAt);
  const mayReadSquad = reader && authority?.graph.checkForumSee(forumId, reader, readAt).allowed;
  const needs = liveEnabled ? new Map([...receivedNeeds].filter(([id]) =>
    mayReadSquad && authority?.graph.checkForumSee(id, reader, readAt).allowed)) : receivedNeeds;

  const offers = useMemo(() => {
    const map = new Map([...meshOffers].filter(([, row]) => !liveEnabled || (proofs.valid(row) &&
      (row.stated === 0 || !!authority?.graph.checkForumSee(row.need, row.helper, Math.floor(Date.now() / 1000)).allowed))));
    for (const offer of (liveEnabled ? [] : localOffers.values())) {
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
    let bounded = new Map<string, ForumOffer>();
    for (const offer of map.values()) bounded = retainForumOffer(bounded, offer);
    return bounded;
  }, [localOffers, meshOffers, offerCancels, removedOffers, aclRev, proofs, authority]);
  offersRef.current = offers;

  const roster = useMemo(() => {
    const merged = composeForumRoster({
      sample: liveEnabled ? [] : PILOT_AGENTS,
      mesh: [...meshStatus.values()].filter(row => !liveEnabled || (mayReadSquad && proofs.valid(row) && proofs.enrolled(row.seaPubkey))),
      admitted,
      removed: new Set(removedAgents.keys()),
    });
    return merged.map((agent) => {
      const over = liveEnabled ? undefined : localStatus.get(agent.status.seaPubkey);
      const status = pickDisplayedStatus(agent.status, over);
      return status === agent.status ? agent : { ...agent, status };
    });
  }, [admitted, localStatus, meshStatus, removedAgents, aclRev, proofs, mayReadSquad]);

  const visible = useMemo(
    () => filterAgents(roster, filters, query),
    [filters, query, roster],
  );

  const alarm = liveEnabled ? (mayReadSquad && proofs.valid(meshAlarm) ? meshAlarm : null) : meshAlarm ?? (alarmHeard ? null : PILOT_ALARM);
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
    () => mergeForumChat({ pilot: liveEnabled ? [] : PILOT_CHAT,
      mesh: liveEnabled ? readableForumChat(meshChat, forumId, sessionKey, authority?.graph, proofs.valid,
        Math.floor(Date.now() / 1000)) : meshChat,
      local: liveEnabled ? [] : localChat, hidden: hiddenChat }),
    [hiddenChat, localChat, meshChat, aclRev, proofs, authority, liveEnabled, forumId, sessionKey],
  );

  function signingPrincipal() {
    if (!liveEnabled) return seaPub;
    const principal = seaPub ? authority?.graph.principalForKey(seaPub, Math.floor(Date.now() / 1000)) ?? null : null;
    return principal && !isPublicSquadPrincipal(principal) ? principal : null;
  }

  const requireGraph = useCallback((): SeeGraph | null => {
    if (!graph) {
      setNotice("Check is still loading.");
      return null;
    }
    if (!seaPub) {
      setNotice("A mesh key on this browser is required.");
      return null;
    }
    return graph;
  }, [graph, seaPub]);

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

  function meshNote(kind: string, wrote: "signed" | "offline" | "local" | "denied", okLine: string): string {
    if (!liveEnabled) return `${kind} on this browser until mesh publish.`;
    if (wrote === "denied") return "Authority changed before publication. Refresh and try again.";
    if (wrote === "signed") return okLine;
    if (wrote === "offline") return "The mesh peer was not ready. Refresh before retrying the change.";
    return "A signature from this mesh key is required to publish the change.";
  }

  function offerEntropy(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function onOffer(agent: SquadAgent) {
    const current = requireGraph(), writer = signingPrincipal();
    if (!current || !writer) return;
    const open = openNeedFor(agent.status, needs);
    if (!open) {
      setNotice("No open need on this tile.");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const decision = offerForumHelp({
      graph: current,
      writer: writer,
      need: open,
      body: offerBody,
      now,
      entropy: offerEntropy(),
    });
    if (!decision.ok || !decision.offer) {
      setNotice(needNotice(decision.ok ? "bad-offer" : decision.reason, "offer"));
      return;
    }
    const offer = decision.offer;
    if (!liveEnabled) setLocalOffers((prev) => {
      return retainForumOffer(prev, offer);
    });
    setOfferBody("");
    const wrote = await putAuthedRecord(
      forumOfferSoul(offer.forumId, offer.need, offer.id),
      offer,
      writer,
      () => {
        const fresh = graphRef.current, need = needsRef.current.get(open.id);
        return !!fresh && !!need && (!liveEnabled || proofs.valid(need)) && need.stated === 1 && offerForumHelp({ graph: fresh, writer: writer,
          need, body: offer.body, artifacts: offer.artifacts, entropy: offer.id.slice(-32), now: Math.floor(Date.now() / 1000) }).ok;
      },
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
    const current = requireGraph(), writer = signingPrincipal();
    if (!current || !writer) return;
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
      writer: writer,
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
    if (!liveEnabled) setLocalNeeds((prev) => {
      const map = new Map(prev);
      map.set(next.id, next);
      return map;
    });
    const needOwner = current.ownerOf(open.id);
    const admit = needOwner && writer !== needOwner ? needAdmitRef.current.get(open.id) : undefined;
    const record = admit ? { ...next, admit } : next;
    const wrote = await putAuthedRecord(forumNeedSoul(next.forumId, next.id), record, writer, () => {
      const fresh = graphRef.current, need = needsRef.current.get(open.id);
      return !!fresh && !!need && (!liveEnabled || proofs.valid(need)) && need.hamState === open.hamState && (!liveEnabled || proofs.valid(offer)) && acceptForumOffer({ graph: fresh, writer: writer,
        need, offer, postedOffers: offersForNeed(offersRef.current, open.id), now: Math.floor(Date.now() / 1000) }).ok;
    });
    setNotice(meshNote("Accept kept", wrote, "Offer accepted. The need is closed."));
  }

  async function onDecline(agent: SquadAgent) {
    const current = requireGraph(), writer = signingPrincipal();
    if (!current || !writer) return;
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
      writer: writer,
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
    if (!liveEnabled && !offerCancelsRef.current.has(forumOfferCacheKey(next.need, next.id))) {
      const ids = new Set(offerCancelsRef.current);
      ids.add(forumOfferCacheKey(next.need, next.id));
      offerCancelsRef.current = ids;
      setOfferCancels(ids);
    }
    if (!liveEnabled) setLocalOffers((prev) => {
      return retainForumOffer(prev, next);
    });
    const authorized = (tail = false) => {
      const fresh = graphRef.current, need = needsRef.current.get(open.id);
      const check = tail ? continueForumOfferCancellation : declineForumOffer;
      return !!fresh && !!need && (!liveEnabled || proofs.valid(need)) && need.hamState === open.hamState && (!liveEnabled || proofs.valid(offer)) && check({ graph: fresh, writer: writer, need, offer,
        postedOffers: offersForNeed(offersRef.current, open.id), now: Math.floor(Date.now() / 1000) }).ok;
    };
    let wrote = await putAuthedRecord(forumOfferSoul(next.forumId, next.need, next.id), next, writer, authorized);
    if (wrote === "signed") {
      wrote = await putAuthedRecord(forumOfferCancelSoul(next.forumId, next.need, next.id), next, writer, () => authorized(true));
    }
    setNotice(meshNote("Decline kept", wrote, "Offer declined. The need stays open."));
  }

  async function onReopen(agent: SquadAgent) {
    const current = requireGraph(), writer = signingPrincipal();
    if (!current || !writer) return;
    const listed = needIds(agent.status.needs)
      .map((id) => needs.get(id))
      .find((need) => need && need.stated === 0);
    if (!listed) {
      setNotice("This need is still open.");
      return;
    }
    const decision = reopenForumNeed({
      graph: current,
      writer: writer,
      need: listed,
      now: Math.floor(Date.now() / 1000),
    });
    if (!decision.ok || !decision.need) {
      setNotice(needNotice(decision.ok ? "bad-need" : decision.reason, "reopen"));
      return;
    }
    const next = decision.need;
    if (!liveEnabled) setLocalNeeds((prev) => {
      const map = new Map(prev);
      map.set(next.id, next);
      return map;
    });
    const wrote = await putAuthedRecord(forumNeedSoul(next.forumId, next.id), next, writer, () => {
      const fresh = graphRef.current, need = needsRef.current.get(listed.id);
      return !!fresh && !!need && (!liveEnabled || proofs.valid(need)) && need.hamState === listed.hamState && reopenForumNeed({ graph: fresh, writer: writer, need, now: Math.floor(Date.now() / 1000) }).ok;
    });
    setNotice(meshNote("Reopen kept", wrote, "Need reopened. Earlier offers stay."));
  }

  function onReply(agent: SquadAgent) {
    setDraft(`@${agent.label} `);
    setTab("chat");
    setSelected(null);
    setNotice("");
    window.setTimeout(() => composerRef.current?.focus(), 0);
  }

  async function putAuthedRecord(
    soul: string,
    record: object,
    writer: string,
    authorized: () => boolean,
  ): Promise<"signed" | "offline" | "local" | "denied"> {
    if (!liveEnabled) return "local";
    const pair = pairRef.current;
    if (!pair || authority?.graph.writerKey(writer, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)) !== pair.pub) return "local";
    return publishForumAuthorized({ record, authorized: () => proofs.ready() && authorized() && pairRef.current === pair &&
      authority?.graph.writerKey(writer, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)) === pair.pub, sign: value => signForumRecord(value, pair),
      put: value => putSoul(gunRef.current, soul, value, liveEnabled) });
  }

  async function onSend(report = false) {
    if (report && liveEnabled) return;
    const writer = signingPrincipal();
    if (!writer) {
      setNotice("A mesh key on this browser is required.");
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const item = buildForumStatement({
      forumId: forumId,
      author: writer,
      body: draft,
      extras: report ? ["report"] : [],
      now,
      entropy: entropy(),
    });
    if (!item) {
      setNotice("Statement was not accepted.");
      return;
    }
    if (!liveEnabled) {
      setLocalChat(prev => retainForumChat(prev, item));
      setDraft("");
      setNotice("Statement kept on this browser until mesh publish.");
      return;
    }
    const node = toGunNode(item);
    // Descriptive chat never creates ACL ownership. A separately signed
    // object admission and current direct post authority must already exist.
    if (!graph?.checkPost?.(item.id, writer, now).allowed) {
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
    const wrote = await putAuthedRecord(soul, node, writer, () => {
      const now = Math.floor(Date.now() / 1000);
      return !!authority?.graph.checkDirectSee(item.id, writer, now).allowed &&
        authority.graph.checkPost(item.id, writer, now).allowed;
    });
    if (wrote === "signed") setDraft("");
    if (wrote === "denied" || wrote === "local") setNotice("Statement not sent. Current post authority or a mesh signature was unavailable.");
    else if (wrote === "offline") setNotice("Statement not sent. The mesh peer was not ready.");
    else setNotice("Statement sent.");
  }

  const wallet = session?.address
    ? `${session.address.slice(0, 6)}…${session.address.slice(-4)}`
    : "not linked";

  function toggleEscalation(need: ForumNeed, destination: "Fleet" | "Command") {
    if (liveEnabled || need.stated !== 1) return;
    setEscalations(previous => {
      const next = new Map(previous);
      const entry = previous.get(need.id);
      if (destination === "Fleet") {
        if (entry?.revision === need.hamState) next.delete(need.id);
        else next.set(need.id, { revision: need.hamState, command: false });
      } else if (entry?.revision === need.hamState && need.severity === "emergency") {
        next.set(need.id, { ...entry, command: !entry.command });
      }
      return next;
    });
  }

  const liveReports = chat.filter(row => row.tags.includes("report"));
  const boardProps = liveEnabled && reportParents && authority && sessionKey && gunPeer?.gun ? {
    path: { squad: view, ...reportParents }, graph: authority.graph, gun: gunPeer.gun, sessionKey, read: readReports,
    markRead: (key: string) => setReadReports(prev => new Set(prev).add(key)),
    evidence: (row: BoardSource) => forwards.current.get(row), pair: () => pairRef.current,
    valid: (row: BoardSource) => {
      if (!proofs.valid(row)) return false;
      if (isNeed(row)) return needsRef.current.get(row.id) === row;
      const now = Math.floor(Date.now() / 1000);
      return chatRowsRef.current.includes(row) && authority.graph.checkDirectSee(row.id, row.author, now).allowed &&
        authority.graph.checkPost(row.id, row.author, now).allowed;
    },
  } : null;
  const liveReportPanel = boardProps ? <LiveForumReports key={sessionKey} {...boardProps} reportsOnly rows={liveReports} />
    : <ReportList reports={liveReports} authorLabel={authorLabel} />;
  const reports = liveEnabled ? liveReportPanel : <ForumPreviewReports level={previewLevel} chat={chat}
    shared={sharedReports} authorLabel={authorLabel} onToggle={row => {
      setSharedReports(previous => {
        // Bind forwarding to the exact row. Replaced or retracted statements lose their selection.
        const next = new Map([...previous].filter(([item]) => chat.includes(item)));
        if (previewLevel === "Squad") {
          if (next.has(row)) next.delete(row);
          else next.set(row, "Fleet");
        } else if (previewLevel === "Fleet" && next.has(row)) {
          next.set(row, next.get(row) === "Command" ? "Fleet" : "Command");
        }
        return next;
      });
    }} />;
  const hierarchy = liveEnabled ? null : <ForumHierarchyPreview level={previewLevel} onSelect={setPreviewLevel}
    squadLabel={forumLabel} members={roster.length} needingHelp={needsCount} emergencies={emergencyCount} alarm={alarmOn}
    reports={reports} needs={needs} escalations={escalations} onToggleCommand={need => toggleEscalation(need, "Command")} />;
  if (!liveEnabled && previewLevel !== "Squad") return hierarchy;
  const shell = (
    <div>
      {hierarchy}
      <ForumShell reports={reports} tab={tab} onTab={setTab} forum={{ label: forumLabel, href: "/feed/squad" }}
        header={<>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{liveEnabled ? forumLabel : "Squad forum"}</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {forumLabel}. Your identity is the key on this browser. A wallet and
            a sign-in are linked credentials.{" "}
            {liveEnabled ? "Only verified records appear here." : "This board stays in this browser until mesh publish."}
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
          <dd className="mt-1 font-data text-ink">{seaPub ? shortSea(seaPub) : "no mesh key on this browser"}</dd>
        </div>
        <div className="border border-rule bg-panel px-3 py-2">
          <dt>Wallet</dt>
          <dd className="mt-1 font-data text-ink" title={session?.address ?? ""}>
            {wallet}
          </dd>
        </div>
        <div className="border border-rule bg-panel px-3 py-2">
          <dt>Linked account</dt>
          <dd className="mt-1 text-ink">{oauthLinked ? "linked" : "not linked"}</dd>
        </div>
      </dl>
      {!session ? (
        <p className="mt-2 text-sm text-ink-muted">
          <Link href="/feed" className="font-semibold text-ink hover:text-signal">
            Sign in on the feed
          </Link>
          . The key stays on this browser.
        </p>
      ) : null}
      {notice ? (
        <p data-testid="squad-notice" className="mt-3 border border-rule bg-panel px-3 py-2 text-sm text-ink">
          {notice}
        </p>
      ) : null}

        </>}
        sidebar={<>
          <p className="font-semibold text-ink">{forumLabel}</p>
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
        </>}
        controls={<>
              <div className="flex flex-wrap items-center gap-2">
                {STATES.map((state) => (
                  <button
                    key={state}
                    type="button"
                    className={filters.has(state) ? chipOn : chipOff}
                    aria-pressed={filters.has(state)}
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
        </>}
        board={<div data-testid="squad-board">
              <BusinessRoleStrips view={businessRoles.view()} roster={liveEnabled ? roster : []} onOpen={setSelected} />
              <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
                {!visible.length ? <p role="status" className="text-sm text-ink-muted">No contributors match these filters.</p> : null}
                {visible.map((agent) => {
                  const open = openNeedFor(agent.status, needs);
                  const full = showFullVitals(agent.status.type, vitals);
                  return (
                    <button
                      key={agent.status.seaPubkey}
                      type="button"
                      data-testid={`squad-tile-${slug(agent.label)}`}
                      className={`flex min-w-0 flex-col border bg-panel p-3 text-left [overflow-wrap:anywhere] ${
                        agent.status.state === "emergency" ? "border-status-fail" : "border-rule"
                      }`}
                      onClick={() => setSelected(agent.status.seaPubkey)}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                        <span className="flex items-center gap-2 font-semibold text-ink">
                          <span className={`inline-block size-2 shrink-0 ${stateDot(agent.status.state)}`} aria-hidden />
                          {agent.label}
                        </span>
                        <span className="text-xs uppercase text-ink-muted">{agent.status.type}</span>
                      </div>
                      <p className="mt-1 text-xs uppercase text-ink-muted">{agent.status.state}</p>
                      <p className="mt-2 text-sm text-ink">{agent.status.task}</p>
                      <p className="mt-1 text-xs text-ink-muted">{agent.status.result}</p>
                      <p data-testid="squad-tile-prompt" className="mt-2 text-xs leading-relaxed text-ink">{agent.status.lastPrompt}</p>
                      {open ? <p className="mt-2 text-xs text-ink">{open.body}</p> : null}
                      <div className="mt-auto pt-3">
                        <div className="h-1 bg-rule">
                          <div
                            className="h-1 bg-signal"
                            style={{ width: `${clampProgress(agent.status.progress)}%` }}
                          />
                        </div>
                        {full ? (
                          <dl data-testid="squad-tile-vitals" className="mt-2 grid grid-cols-3 gap-2 font-data text-xs leading-relaxed text-ink-muted">
                            <div>
                              <dt title="Heartbeat">hb</dt>
                              <dd>{agent.status.hb ?? "—"}</dd>
                            </div>
                            <div>
                              <dt title="Battery">batt</dt>
                              <dd>{agent.status.batt ?? "—"}</dd>
                            </div>
                            <div>
                              <dt title="Link">link</dt>
                              <dd>{agent.status.link ?? "—"}</dd>
                            </div>
                          </dl>
                        ) : null}
                      </div>
                    </button>
                  );
                })}
              </div>
        </div>}
        list={
          <ul data-testid="squad-list" className="mt-3 space-y-2">
            {visible.map(agent => <li key={agent.status.seaPubkey}>
              <button type="button" className="w-full min-w-0 border border-rule bg-panel p-3 text-left [overflow-wrap:anywhere]"
                onClick={() => setSelected(agent.status.seaPubkey)}>
                <span className="font-semibold text-ink">{agent.label}</span>
                <span className="ml-2 text-xs uppercase text-ink-muted">{agent.status.state} · {agent.status.type}</span>
                <p className="mt-1 text-sm text-ink">{agent.status.task}</p>
                <p className="mt-1 text-xs text-ink-muted">{agent.status.result}</p>
              </button>
            </li>)}
            {!visible.length ? <li className="p-3 text-sm text-ink-muted">No contributors match these filters.</li> : null}
          </ul>
        }
        chat={
          <ChatColumn
            authorLabel={authorLabel}
            chat={chat}
            draft={draft}
            setDraft={setDraft}
            onSend={onSend}
            onReport={liveEnabled ? undefined : () => onSend(true)}
            composerRef={composerRef}
            seaLabel={seaPub ? shortSea(seaPub) : "no mesh key"}
          />
        }
      />

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
                {active.status.state} · {forumLabel} · {active.status.type}
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
          {liveEnabled ? (authority ? (
            <ForumDrawerRecords key={active.status.seaPubkey} forum={forumId}
              agent={active.status.seaPubkey} authority={authority} gun={gunPeer?.gun ?? null}
              viewerKey={signingPrincipal() ? seaPub : null} active={meshStatus.has(active.status.seaPubkey) && admitted.has(active.status.seaPubkey) && !removedAgents.has(active.status.seaPubkey)}
              getPair={() => pairRef.current} />
          ) : <p role="status">Waiting for current drawer authority.</p>) : (
            <>
          {active.drawerSource === "status-only" ? (
            <p role="note" className="mt-3 text-xs text-ink-muted">
              Only status data is available. Subtasks, update history, and artifact records
              have not been loaded. Sample details are omitted.
            </p>
          ) : null}
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
            </>
          )}
          <h3 className="mt-4 text-xs font-semibold uppercase text-ink-muted">Results</h3>
          <p className="mt-1 text-sm text-ink">{active.status.result}</p>
          {!liveEnabled && active.artifactNote ? <p className="mt-1 text-xs text-ink-muted">{active.artifactNote}</p> : null}
          <h3 className="mt-4 text-xs font-semibold uppercase text-ink-muted">Needs</h3>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {needIds(active.status.needs).map((id) => {
              const need = needs.get(id);
              if (!need) return null;
              return (
                <li key={id}>
                  {need.severity} · stated {need.stated} · {need.body}
                  {need.acceptedOffer ? ` · offer ${need.acceptedOffer.slice(0, 12)}` : ""}
                  {!liveEnabled && need.stated === 1 && <button type="button" className={btnSecondary}
                    onClick={() => toggleEscalation(need, "Fleet")}>
                    {escalations.get(id)?.revision === need.hamState ? "Withdraw from Fleet" : "Escalate to Fleet"}
                  </button>}
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
          </div>
          <SquadDelegationControls scope={liveEnabled ? { forum: forumId, owner: active.status.seaPubkey } : undefined} />
          <p className="mt-3 text-xs text-ink-muted">Tag {forumChatTag(forumId)}</p>
        </div>
      ) : null}
    </div>
  );
  return boardProps && tab === "board"
    ? <LiveForumReports key={sessionKey} {...boardProps} reportsOnly={false} rows={[...liveReports, ...needs.values()]}>{shell}</LiveForumReports>
    : shell;
}

function ChatColumn({
  authorLabel,
  chat,
  draft,
  setDraft,
  onSend,
  onReport,
  composerRef,
  seaLabel,
}: {
  authorLabel: (pub: string) => string;
  chat: FeedItem[];
  draft: string;
  setDraft: (value: string) => void;
  onSend: () => void | Promise<void>;
  onReport?: () => Promise<void>;
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
        {onReport && <button type="button" className={btnSecondary} onClick={() => void onReport()}>Post report</button>}
      </form>
    </section>
  );
}

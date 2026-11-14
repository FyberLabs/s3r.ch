"use client";

import Link from "next/link";
import { useSquadForumCoordination } from "@/lib/use-squad-forum-coordination";
import { BusinessRoleStrips } from "@/components/BusinessRoleStrips";
import { LiveForumReports } from "./LiveForumReports";
import { ForumBotMessage } from "@/components/ForumBotMessage";
import { parseBotMessage } from "@/lib/forum-bot-protocol";
import { ReportList, ForumPreviewReports } from "./ForumPreviewReports";
import { ForumHierarchyPreview } from "@/components/ForumHierarchyPreview";
import { ForumShell } from "@/components/ForumShell";
import { ForumDrawerRecords } from "@/components/ForumDrawerRecords";
import { SquadDelegationControls } from "@/components/SquadDelegationControls";
import { btnPrimary, btnSecondary, chipOff, chipOn, field } from "@/lib/brand-ui";
import type { FeedItem } from "@/lib/feed-types";
import type { ReportParents } from "@/lib/forum-report-forward";
import { chatAddresses, chatTone, clampProgress, formatClock, formatRuntime, formatTokens,
  shortSea, showFullVitals, openNeedFor, needIds, forumOfferCacheKey } from "@/lib/forum-squad";
import { forumChatTag, type ForumAgentState } from "@/lib/identity/check";
import { squadView, type LiveSquadSpec, type SquadView } from "@/lib/squad-view";

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
  const { forumId, forumLabel, liveEnabled, authorLabel, seaPub, oauthLinked,
    vitals, setVitals, escalations, sharedReports, previewLevel, setPreviewLevel,
    tab, setTab, filters, query, setQuery, setSelected, notice, draft, setDraft,
    offerBody, setOfferBody, roster, visible, active, chat, needs, offers,
    alarmOn, needsCount, emergencyCount, wallet, boardProps, liveReports,
    toggleEscalation, toggleFilter, onSend, onOffer, onAccept, onDecline, onReopen, onReply,
    composerRef, viewer, prepareCancel, drawerProps, toggleSharedReport, roleView, walletAddress } = useSquadForumCoordination({ view, sessionKey, reportParents });
  const liveReportPanel = boardProps ? <LiveForumReports key={sessionKey} {...boardProps} reportsOnly rows={liveReports} />
    : <ReportList reports={liveReports} authorLabel={authorLabel} />;
  const reports = liveEnabled ? liveReportPanel : <ForumPreviewReports level={previewLevel} chat={chat}
    shared={sharedReports} authorLabel={authorLabel} onToggle={toggleSharedReport} />;
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
          <dd className="mt-1 font-data text-ink">{seaPub ? shortSea(seaPub) : "no active identity"}</dd>
        </div>
        <div className="border border-rule bg-panel px-3 py-2">
          <dt>Wallet</dt>
          <dd className="mt-1 font-data text-ink" title={walletAddress}>
            {wallet}
          </dd>
        </div>
        <div className="border border-rule bg-panel px-3 py-2">
          <dt>Linked account</dt>
          <dd className="mt-1 text-ink">{oauthLinked ? "linked" : "not linked"}</dd>
        </div>
      </dl>
      {!seaPub ? (
        <p className="mt-2 text-sm text-ink-muted">
          <Link href="/feed" className="font-semibold text-ink hover:text-signal">
            Unlock an identity on the feed
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
              <BusinessRoleStrips view={roleView} roster={liveEnabled ? roster : []} onOpen={setSelected} />
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
            viewer={viewer}
            onPrepareCancel={prepareCancel}
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
          {liveEnabled ? (drawerProps ? (
            <ForumDrawerRecords key={active.status.seaPubkey} {...drawerProps} />
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
  viewer,
  onPrepareCancel,
}: {
  authorLabel: (pub: string) => string;
  chat: FeedItem[];
  draft: string;
  setDraft: (value: string) => void;
  onSend: () => void | Promise<void>;
  onReport?: () => Promise<void>;
  composerRef?: { current: HTMLTextAreaElement | null };
  seaLabel: string;
  viewer?: string | null;
  onPrepareCancel?: (body: string) => void;
}) {
  const draftBotMessage = parseBotMessage(draft);
  return (
    <section data-testid="squad-chat" className="mt-3 flex h-[32rem] flex-col border border-rule bg-panel lg:mt-0">
      <h2 className="border-b border-rule px-3 py-2 text-sm font-semibold text-ink">Live chat</h2>
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {chat.map((item) => {
          const botMessage = parseBotMessage(item.body);
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
              {botMessage ? <ForumBotMessage message={botMessage} author={item.author} viewer={viewer}
                onPrepareCancel={onPrepareCancel} /> : <p><ChatBody body={item.body} /></p>}
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
        {viewer && <p className="text-xs text-ink-muted">Send to current forum readers. New statement access lasts one hour.</p>}
        {draftBotMessage && <div aria-label="Message preview"><ForumBotMessage message={draftBotMessage} author={viewer ?? ""} /></div>}
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

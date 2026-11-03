"use client";

import { BUSINESS_ROLES, type BusinessRoleView } from "@/lib/forum-business-roles";
import { shortSea, type SquadAgent } from "@/lib/forum-squad";
import { btnSecondary } from "@/lib/brand-ui";

/** Membership labels never grant authority to commission, publish or assign. */
export function BusinessRoleStrips(props: { view: BusinessRoleView; roster: readonly SquadAgent[]; onOpen: (principal: string) => void }) {
  const ready = props.view.state === "ready";
  return <section aria-label="Business roles" className="mt-4 min-w-0">
    <h2 className="text-sm font-semibold text-ink">Business roles</h2>
    <p role="status" className="mt-1 text-xs text-ink-muted">{
      props.view.state === "capacity" ? "Role capacity reached. Assignments cannot be displayed safely." :
      props.view.state === "conflict" ? "Conflicting role configuration. Waiting for an unambiguous assignment." :
      !ready ? "Waiting for a verified forum template and role membership." :
      props.view.mode === "distinct-principals" ? "Separate principals for each role. Verified assignments received so far." :
      "One principal with multiple role labels. Verified assignments received so far."
    }</p>
    <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
      {BUSINESS_ROLES.map(role => {
        const member = ready ? props.view.members.find(row => row.role === role.token) : undefined;
        const agent = member ? props.roster.find(row => row.status.seaPubkey === member.principal) : undefined;
        const noteId = `business-${role.token}-note`;
        return <article key={role.token} aria-label={role.label} className="min-w-0 border border-rule bg-panel p-3 [overflow-wrap:anywhere]">
          <h3 className="text-sm font-semibold text-ink">{role.label}</h3>
          {member ? <><p className="mt-2 text-xs text-ink-muted">SEA principal</p><code className="block break-all text-xs" title={member.principal}>{member.principal}</code>
            {agent ? <button type="button" className={`${btnSecondary} mt-2`} onClick={() => props.onOpen(member.principal)}>
              Open contributor · {shortSea(member.principal)} · {agent.status.state}
            </button> : <p className="mt-2 text-xs text-ink-muted">No current contributor status available.</p>}
          </> : <p className="mt-2 text-xs text-ink-muted">No verified assignment available.</p>}
          <p className="mt-3 text-sm">{role.sources}</p>
          <p className="text-xs text-ink-muted">No verified source connected.</p>
          <p id={noteId} className="mt-3 text-xs text-ink-muted">Role actions require their own authorization. They are not available yet.</p>
          <button type="button" disabled aria-describedby={noteId} className={`${btnSecondary} mt-2 cursor-not-allowed opacity-60`}>{role.action}</button>
        </article>;
      })}
    </div>
    <p className="mt-2 text-xs text-ink-muted">Resolving work does not elect an owner or change role membership.</p>
  </section>;
}

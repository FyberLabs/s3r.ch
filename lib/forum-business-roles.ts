import { acceptForumRoles, isForumObjectId, type ForumTemplate, type ForumRoleMembership } from "./identity/forum-check";
import { recoveryObject } from "./identity/forum-recovery-records";

export const BUSINESS_ROLES = [
  { token: "treasurer", label: "Treasurer", sources: "Token, time and money allocations", action: "Commission" },
  { token: "secretary", label: "Secretary", sources: "Memory map and onboarding", action: "Publish" },
  { token: "practice-manager", label: "Practice Manager", sources: "Distilled skills and agent scorecards", action: "Publish" },
  { token: "president", label: "President / PM", sources: "Roadmap: done, in evaluation, assigned and open", action: "Assign" },
] as const;

export function parseBusinessTemplate(input: unknown, forumId: string): ForumTemplate | null {
  const row = recoveryObject(input);
  if (!row || Object.keys(row).length !== 2 || row.forumId !== forumId || !isForumObjectId(forumId, "forum") ||
      (row.mode !== "distinct-principals" && row.mode !== "role-labels")) return null;
  return Object.freeze({ forumId, mode: row.mode });
}

export type BusinessRoleView = {
  state: "waiting" | "conflict" | "capacity" | "ready";
  mode: ForumTemplate["mode"] | null;
  members: readonly ForumRoleMembership[];
};
/** Receipts, not parsed data, admit roles. The v1 membership/template records
 * have no revision or removal protocol: conflicting signed assignments cannot
 * be resolved by transport arrival order. Never silently drop a conflict at cap.
 */
export function createBusinessRoles(forumId: string, valid: (row: object) => boolean) {
  const templates = new Map<string, ForumTemplate>();
  const members = new Map<string, ForumRoleMembership>();
  let overflow = false;
  return {
    template(row: ForumTemplate) {
      if (row.forumId !== forumId || !valid(row)) return false;
      templates.set(row.mode, row); return true;
    },
    membership(row: ForumRoleMembership) {
      if (row.forumId !== forumId || !valid(row)) return false;
      const key = `${row.role}:${row.principal}`;
      if (!members.has(key) && members.size >= 128) { overflow = true; return false; }
      members.set(key, row); return true;
    },
    view(): BusinessRoleView {
      if (overflow) return { state: "capacity", mode: null, members: [] };
      const modes = [...templates.values()].filter(valid);
      if (!modes.length) return { state: "waiting", mode: null, members: [] };
      const rows = [...members.values()].filter(valid);
      if (modes.length !== 1 || !acceptForumRoles(modes[0].mode, rows)) return { state: "conflict", mode: null, members: [] };
      return { state: "ready", mode: modes[0].mode, members: rows };
    },
    reset() { templates.clear(); members.clear(); overflow = false; },
  };
}

/** Assignment changes require verified cancellation and fresh destination grants.
 * Keep this control disabled until the assignment/access coordinator is wired.
 */
export function SquadDelegationControls() {
  return (
    <fieldset disabled aria-describedby="squad-delegation-unavailable" className="mt-3">
      <legend className="text-xs font-medium text-ink-muted">Assignment and access</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        <input
          disabled
          aria-label="Reassign target"
          data-testid="squad-reassign-target"
          placeholder="Mesh key"
          className="min-w-0 flex-1 rounded border bg-transparent px-3 py-2 opacity-50"
        />
        <button type="button" disabled data-testid="squad-reassign" className="rounded border px-3 py-2 opacity-50">
          Reassign
        </button>
      </div>
      <p id="squad-delegation-unavailable" role="note" className="mt-2 text-xs text-ink-muted">
        Reassignment is unavailable until access changes can be verified. Updating an assignment
        or status alone does not change permissions.
      </p>
    </fieldset>
  );
}

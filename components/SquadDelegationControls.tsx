/**
 * SociACL's pause/reassign contract needs durable cancellation evidence and
 * worker fencing. The pilot has neither. There is intentionally no enable flag,
 * status-write callback or optimistic success path on these controls.
 */
export function SquadDelegationControls() {
  return (
    <fieldset disabled aria-describedby="squad-delegation-unavailable" className="mt-3">
      <legend className="text-xs font-medium text-ink-muted">Agent control</legend>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled data-testid="squad-pause" className="rounded border px-3 py-2 opacity-50">
          Pause
        </button>
        <input
          disabled
          aria-label="Reassign target"
          data-testid="squad-reassign-target"
          placeholder="SEA pubkey"
          className="min-w-0 flex-1 rounded border bg-transparent px-3 py-2 opacity-50"
        />
        <button type="button" disabled data-testid="squad-reassign" className="rounded border px-3 py-2 opacity-50">
          Reassign
        </button>
      </div>
      <p id="squad-delegation-unavailable" role="note" className="mt-2 text-xs text-ink-muted">
        Pause and reassignment are unavailable. This app cannot yet confirm that the previous
        agent has stopped and its access has been revoked. Changing its status would not stop its work.
      </p>
    </fieldset>
  );
}

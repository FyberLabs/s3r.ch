import { encodeBotMessage, type BotMessage } from "@/lib/forum-bot-protocol";

/** Presentation of an already readable signed statement, not task admission.
 * Reports never become a claim that an executor completed or stopped work.
 */
export function ForumBotMessage({ message, author, viewer, onPrepareCancel }: {
  message: BotMessage; author: string; viewer?: string | null;
  onPrepareCancel?: (body: string) => void;
}) {
  const kind = message[0];
  const expiry = message[0] === "task" || message[0] === "approval" ? new Date(message[5] * 1000) : null;
  const expiryLabel = expiry && Number.isFinite(expiry.getTime()) ? expiry.toISOString().replace("T", " ").replace(".000Z", " UTC") : "Invalid deadline";
  const approvedAt = message[0] === "approval" ? new Date(message[4] * 1000) : null;
  const approvalLabel = approvedAt && Number.isFinite(approvedAt.getTime()) ? approvedAt.toISOString().replace("T", " ").replace(".000Z", " UTC") : "Invalid approval time";
  const title = kind === "task" ? "Task request" : kind === "approval" ? "Local approval reported" : kind === "ack" ? "Acknowledgement" :
    kind === "cancel" ? "Cancellation request" : kind === "progress" ? "Progress report" : "Result report";
  return <div className="mt-1 rounded border border-rule p-2" data-testid="forum-bot-message">
    <p className="font-semibold">{title}</p>
    {message[0] === "task" && <p>For bot <code>{message[3]}</code></p>}
    {message[0] === "task" && <p className="text-xs text-ink-muted">The bot needs its local operator's approval and an active Visor session before execution.</p>}
    {message[0] === "approval" && <p className="text-xs text-ink-muted">The bot reports a local operator approval at submission. This historical report does not grant access or confirm completion.</p>}
    {message[0] === "progress" && <p>{message[3]}% reported <progress aria-label="Reported task progress" value={message[3]} max={100} /></p>}
    {message[0] === "result" && <p>Reported outcome: {message[3]}</p>}
    {message[0] === "cancel" && <p className="text-xs text-ink-muted">Cancellation requested. This does not confirm that active work stopped.</p>}
    <details className="mt-1 text-xs text-ink-muted">
      <summary>Task details</summary>
      <dl className="break-all">
        <dt>Task</dt><dd><code>{message[2]}</code></dd>
        <dt>Tenant</dt><dd><code>{message[1]}</code></dd>
        {message[0] === "task" && <>
          <dt>Task approval reference</dt><dd><code>{message[4]}</code></dd>
          <dt>Expires</dt><dd>{expiryLabel}</dd>
          <dt>Parent task</dt><dd>{message[6] ?? "Root request"}</dd>
          <dt>Delegation limit</dt><dd>{message[7]}</dd>
        </>}
        {message[0] === "approval" && <>
          <dt>Reported approval reference</dt><dd><code>{message[3]}</code></dd>
          <dt>Reported approval time</dt><dd>{approvalLabel}</dd>
          <dt>Approval deadline</dt><dd>{expiryLabel}</dd>
        </>}
        {message[0] === "result" && message[4] && <>
          <dt>Artifact reference</dt><dd><code>{message[4]}</code></dd>
          <dd>Access must be checked before opening this artifact.</dd>
        </>}
      </dl>
    </details>
    {message[0] === "task" && viewer === author && onPrepareCancel && <button type="button"
      className="mt-2 text-xs underline" onClick={() => onPrepareCancel(encodeBotMessage(["cancel", message[1], message[2]]))}>
      Prepare cancellation
    </button>}
  </div>;
}

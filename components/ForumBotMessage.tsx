import { encodeBotMessage, type BotMessage } from "@/lib/forum-bot-protocol";

/** Presentation of an already readable signed statement, not task admission.
 * Reports never become a claim that an executor completed or stopped work.
 */
export function ForumBotMessage({ message, author, viewer, onPrepareCancel }: {
  message: BotMessage; author: string; viewer?: string | null;
  onPrepareCancel?: (body: string) => void;
}) {
  const kind = message[0];
  const expiry = message[0] === "task" ? new Date(message[5] * 1000) : null;
  const expiryLabel = expiry && Number.isFinite(expiry.getTime()) ? expiry.toISOString().replace("T", " ").replace(".000Z", " UTC") : "Invalid deadline";
  const title = kind === "task" ? "Task request" : kind === "ack" ? "Acknowledgement" :
    kind === "cancel" ? "Cancellation request" : kind === "progress" ? "Progress report" : "Result report";
  return <div className="mt-1 rounded border border-rule p-2" data-testid="forum-bot-message">
    <p className="font-semibold">{title}</p>
    {message[0] === "task" && <p>For bot <code>{message[3]}</code></p>}
    {message[0] === "progress" && <p>{message[3]}% reported <progress aria-label="Reported task progress" value={message[3]} max={100} /></p>}
    {message[0] === "result" && <p>Reported outcome: {message[3]}</p>}
    {message[0] === "cancel" && <p className="text-xs text-ink-muted">Cancellation requested. This does not confirm that active work stopped.</p>}
    <details className="mt-1 text-xs text-ink-muted">
      <summary>Task details</summary>
      <dl className="break-all">
        <dt>Task</dt><dd><code>{message[2]}</code></dd>
        <dt>Tenant</dt><dd><code>{message[1]}</code></dd>
        {message[0] === "task" && <>
          <dt>Authorized task reference</dt><dd><code>{message[4]}</code></dd>
          <dt>Expires</dt><dd>{expiryLabel}</dd>
          <dt>Parent task</dt><dd>{message[6] ?? "Root request"}</dd>
          <dt>Delegation limit</dt><dd>{message[7]}</dd>
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

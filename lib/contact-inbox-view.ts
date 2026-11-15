/** Authenticated browser-session boundary for the contacts panel.
 * Implementations own current identity/grant checks, ciphertext-only transport,
 * and durable decisions. UI rows are never authority for those operations.
 */
export type ContactRequestView = Readonly<{ id: string; sender: string; message: string }>;
export type ContactView = Readonly<{ principal: string; blocked: boolean }>;
export type ContactMessageView = Readonly<{ id: string; sender: string; body: string }>;
export type ContactInboxView = Readonly<{ requests: readonly ContactRequestView[]; contacts: readonly ContactView[] }>;
export interface ContactInboxSession {
  /** Unique to this unlocked identity/session generation; never reuse after lock. */
  readonly id: string;
  readonly principal: string;
  /** Changes on lock, logout, authority expiry, or remote contact decisions. */
  subscribe(listener: () => void): () => void;
  current(): boolean;
  load(signal: AbortSignal): Promise<ContactInboxView>;
  accept(requestId: string, signal: AbortSignal): Promise<void>;
  reject(requestId: string, signal: AbortSignal): Promise<void>;
  block(principal: string, signal: AbortSignal): Promise<void>;
  messages(principal: string, signal: AbortSignal): Promise<readonly ContactMessageView[]>;
  /** Must authenticate the current recipient grant and prepare ciphertext once.
   * submit must reuse the same committed ciphertext on ambiguous-response retries.
   * It must recheck current identity/block/grant state before every submission.
   */
  prepareMessage(principal: string, text: string, signal: AbortSignal): Promise<{
    submit(signal: AbortSignal): Promise<void>;
  }>;
}

export const CONTACT_TEXT_MAX = 1024;
export function contactText(value: string): string {
  const text = value.trim();
  if (!text || new TextEncoder().encode(text).length > CONTACT_TEXT_MAX || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ||
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(text)) throw Error('Invalid contact message');
  return text;
}

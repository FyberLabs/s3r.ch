import { isSeparateChatSoul } from "@/lib/identity/forum-check";

/** Traverse a built forum/feed soul without splitting the dot inside a SEA key.
 * This is transport only: callers must authenticate and authorize every write.
 */
export function forumSoulNode<T extends { get(key: string): T }>(gun: T, soul: string): T | null {
  if (isSeparateChatSoul(soul)) return null;
  const parts = soul.split("/");
  if (parts.some((part) => part.length === 0)) return null;
  let node = gun;
  for (const part of parts) node = node.get(part);
  return node;
}

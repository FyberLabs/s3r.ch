import type { createForumPublicationFence } from "./forum-publication-fence";

/** Recheck current destination authority after asynchronous signing. A signature
 * is not a cached grant. No await may separate the final gate from dispatch. */
export async function publishForumAuthorized<T extends object>(input: {
  record: T; authorized: () => boolean; sign: (record: T) => Promise<string | null>;
  put: (record: T & { sig: string }) => boolean;
  fence?: ReturnType<typeof createForumPublicationFence>;
}): Promise<"signed" | "offline" | "denied"> {
  const permit = input.fence?.enter();
  if (input.fence && !permit) return "denied";
  try {
    if (!input.authorized() || (permit && !permit.allowed())) return "denied";
    const sig = await input.sign(input.record);
    if (!sig || !input.authorized() || (permit && !permit.allowed())) return "denied";
    return input.put({ ...input.record, sig }) ? "signed" : "offline";
  } finally { permit?.finish(); }
}

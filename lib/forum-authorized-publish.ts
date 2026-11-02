/** Recheck current destination authority after asynchronous signing. A signature
 * is not a cached grant. No await may separate the final gate from dispatch. */
export async function publishForumAuthorized<T extends object>(input: {
  record: T; authorized: () => boolean; sign: (record: T) => Promise<string | null>;
  put: (record: T & { sig: string }) => boolean;
}): Promise<"signed" | "offline" | "denied"> {
  if (!input.authorized()) return "denied";
  const sig = await input.sign(input.record);
  if (!sig || !input.authorized()) return "denied";
  return input.put({ ...input.record, sig }) ? "signed" : "offline";
}

/** Start delivery before yielding to other page work. Keepalive lets a bounded
 * attribution request finish after the navigation deadline. */
export function sendFeedConversion(body: { action: "conversion"; display: string; eventId: string }, navigate: () => void,
  transport: typeof fetch = fetch, deadline = 1500): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  const delivery = transport("/api/experiments", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
  return Promise.race([delivery, new Promise<void>(resolve => { timer = setTimeout(resolve, deadline); })])
    .then(() => { clearTimeout(timer); navigate(); });
}

"use client";

import { useEffect } from "react";

// Checks run serially, only while the page is visible. A 401 leaves the
// reader idle until focus or an identity change triggers a fresh read.
export function useVisibleRead(
  enabled: boolean,
  read: (signal: AbortSignal) => Promise<boolean>,
  intervalMs: number,
) {
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    function stop() {
      clearTimeout(timer);
      controller?.abort();
    }
    async function load() {
      stop();
      if (document.visibilityState !== "visible") return;
      const request = new AbortController();
      controller = request;
      let repeat = true;
      try {
        repeat = await read(request.signal);
      } catch {
        // The next visible refresh can retry a transient network failure.
      }
      if (!request.signal.aborted && repeat) timer = setTimeout(load, intervalMs);
    }
    void load();
    document.addEventListener("visibilitychange", load);
    window.addEventListener("s3rch-session-changed", load);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", load);
      window.removeEventListener("s3rch-session-changed", load);
    };
  }, [enabled, read, intervalMs]);
}

/**
 * Page handshake for the s3r.ch pull contract.
 * Same-origin postMessage only. Unknown v is ignored.
 */
const CHANNEL = "s3rch-pull";
const V = 1;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL || data.v !== V) return;

  if (data.type === "hello") {
    window.postMessage(
      { channel: CHANNEL, type: "ready", v: V, via: "extension" },
      event.origin,
    );
    return;
  }

  if (data.type === "pull" && typeof data.id === "string") {
    chrome.runtime.sendMessage(data, (response) => {
      if (chrome.runtime.lastError) {
        window.postMessage(
          {
            channel: CHANNEL,
            type: "denied",
            v: V,
            id: data.id,
            error: chrome.runtime.lastError.message || "Extension did not answer.",
          },
          event.origin,
        );
        return;
      }
      window.postMessage(response, event.origin);
    });
  }
});

window.postMessage(
  { channel: CHANNEL, type: "ready", v: V, via: "extension" },
  window.location.origin,
);
